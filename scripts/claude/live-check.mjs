// The live check: one real run of @Claude against the real API, once per gate. The owner runs it with their own key.
//
//   ANTHROPIC_API_KEY_LIVE=... node scripts/claude/live-check.mjs [--only models,text,figure,web,think,effort] [--questions 10] [--out report.json]
//
// With no ANTHROPIC_API_KEY_LIVE it says so and exits 0 (CI without the secret stays green). With a key it:
//   1. lists the models and picks the newest active Haiku and Opus by their `line`, then probes which web search tool each accepts;
//   2. asks a text question on the default model (a Haiku answer must cost under 0.1 cent);
//   3. asks a follow-up within 5 minutes (it must show cache reads);
//   4. asks about a figure (the image path must be accepted);
//   5. asks a question that needs the web (one search, at most, and a source);
//   6. asks the same question with Think harder (about 3 to 5 cents; over 25 cents it would have asked first);
//   7. runs the effort comparison, `low` against `medium`, on 10 questions;
//   8. measures the estimate's calibration factor with free token counting.
// It prints every request's `usage` and dollars. It costs a few cents. The key is read from the environment only and is scrubbed
// from everything printed or written. Exit code 1 when a check fails.
import { writeFileSync } from 'node:fs';
import { ask, choose, listModels, loadCore, looksLikeKey, postJson, probeWebSearch, readKey, samplePack, say, scrub, topPassages, KEY_ENV } from './lib.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const only = opt('only', '').split(',').filter(Boolean);
const wants = (step) => only.length === 0 || only.includes(step);
const questionCount = Number(opt('questions', '10'));
const outFile = opt('out', null);

const key = readKey();
if (!key) {
  console.log(`${KEY_ENV} is not set, so the live check is skipped. Nothing was sent.`);
  process.exit(0);
}

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  say(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const cents = (usd) => `${(usd * 100).toFixed(3)} cents`;

const QUESTION = 'Why does the parallel trends assumption matter for this result?';
const WEB_QUESTION = 'What is the difference-in-differences method, in general? Search the web for a definition.';
const EFFORT_QUESTIONS = [
  'What is the main finding?', 'How many restaurants were studied?', 'Why does the parallel trends assumption matter?',
  'What data did the authors use?', 'What did they find about pay?', 'Which restaurants were dropped, and why?',
  'What does the conclusion say about other industries?', 'What is the standard error of the employment effect?',
  'How is the treated group different from the control group?', 'What would make the result less certain?',
].slice(0, questionCount);

let total = 0;
const { core, close } = await loadCore();
try {
  // 1. Models
  const list = await listModels(key);
  const lines = [...new Set(list.map((m) => m.line).filter(Boolean))];
  say(`Models: ${list.length} listed, lines: ${lines.join(', ') || '(none)'}`);
  const draft = { haiku: choose(list, 'haiku', null), opus: choose(list, 'opus', null) };
  check('the model list has an active Haiku and Opus', Boolean(draft.haiku && draft.opus), `${list.length} models`);
  if (!draft.haiku || !draft.opus) throw new Error('no Haiku or Opus found');
  const haiku = { ...draft.haiku, webSearchTool: await probeWebSearch(key, draft.haiku.id) };
  const opus = { ...draft.opus, webSearchTool: await probeWebSearch(key, draft.opus.id) };
  say(`Default: ${haiku.displayName} (web search tool: ${haiku.webSearchTool ?? 'none'}, images: ${haiku.imageInput})`);
  say(`Think harder: ${opus.displayName} (web search tool: ${opus.webSearchTool ?? 'none'}, images: ${opus.imageInput})`);
  check('both models accept some web search tool', Boolean(haiku.webSearchTool && opus.webSearchTool));

  const run = async (label, model, role, question, { webSearch = false, figure = false, turns, pack: given } = {}) => {
    const pack = given ?? samplePack(question, { figure });
    const built = await core.buildRequest(pack, turns ?? [{ role: 'user', content: question }], { role, model, webSearch });
    const price = core.priceFor(model);
    const t0 = Date.now();
    const r = await ask(core, key, built, { role, price, figureLabels: core.figureLabelsOf(pack) });
    const u = r.result.usage;
    total += u?.usd ?? 0;
    say(`\n[${label}] ${model.displayName}, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    say(`  usage: in ${u.inputTokens}, cache write ${u.cacheWriteTokens}, cache read ${u.cacheReadTokens}, out ${u.outputTokens}, searches ${u.webSearches}  =>  ${cents(u.usd)}`);
    say(`  citations: ${r.result.citations.length}, sources: ${r.result.webSources.length}, stop: ${r.result.status}`);
    say(`  ${r.result.body.replace(/\s+/g, ' ').slice(0, 400)}`);
    return { ...r, built, pack, u };
  };

  // 2 and 3. Text question, then a follow-up
  let first = null;
  if (wants('text')) {
    first = await run('text question', haiku, 'default', QUESTION);
    check('a Haiku question without web search costs under 0.1 cent', first.u.usd < 0.001, cents(first.u.usd));
    check('the answer cites a page', first.result.citations.length > 0);
    check('a reply is not an error', first.result.status === 'done', first.result.error?.message);

    const followTurns = [
      { role: 'user', content: QUESTION },
      { role: 'assistant', content: first.message.content },
      { role: 'user', content: 'And what happens if that assumption fails?' },
    ];
    const follow = await run('follow-up within 5 minutes', haiku, 'default', QUESTION, { turns: followTurns, pack: first.pack });
    check('a follow-up shows cache reads', follow.u.cacheReadTokens > 0, `${follow.u.cacheReadTokens} tokens read from the cache`);
    check('the follow-up costs less than the first question', follow.u.usd < first.u.usd, `${cents(follow.u.usd)} against ${cents(first.u.usd)}`);

    // 8. Calibration: free token counting against the plain chars / 4 rule
    const counted = await postJson('/v1/messages/count_tokens', key, { model: haiku.id, system: first.built.params.system, tools: first.built.params.tools, messages: first.built.params.messages.slice(0, 1) });
    const bare = await postJson('/v1/messages/count_tokens', key, { model: haiku.id, system: first.built.params.system, tools: first.built.params.tools, messages: [{ role: 'user', content: 'Hi' }] });
    if (counted.ok && bare.ok) {
      const raw = core.FIXED_PROMPT_TOKENS + core.packTextTokens(first.pack) + Math.ceil(QUESTION.length / 4);
      const factor = counted.body.input_tokens / raw;
      say(`\nCalibration (${haiku.line}): counted ${counted.body.input_tokens} tokens, the chars/4 rule says ${raw}  =>  factor ${factor.toFixed(2)} (code has ${core.calibrationFor(haiku.line)}).`);
      say(`Fixed part (tools + system prompt): about ${bare.body.input_tokens - 8} tokens (code has ${core.FIXED_PROMPT_TOKENS}).`);
      check('the estimate is within 25% of the counted tokens', Math.abs(core.estimate(first.pack, 'default', haiku).inputTokens / counted.body.input_tokens - 1) < 0.25);
    } else check('token counting works', false, `HTTP ${counted.status}/${bare.status}`);
  }

  // 4. Figure
  if (wants('figure')) {
    const fig = await run('figure question', haiku, 'default', core.EXPLAIN_FIGURE_QUESTION, { figure: true });
    check('a figure question is accepted and answered', fig.result.status === 'done', fig.result.error?.message);
    check('a figure question costs under 0.5 cent on Haiku', fig.u.usd < 0.005, cents(fig.u.usd));
  }

  // 5. Web search
  if (wants('web')) {
    const web = await run('web search', haiku, 'default', WEB_QUESTION, { webSearch: true });
    check('a web search question searched, once at most', web.u.webSearches >= 1 && web.u.webSearches <= core.MAX_WEB_SEARCHES, `${web.u.webSearches} searches`);
    check('the answer has a web source', web.result.webSources.length > 0);
    check('web search is billed: the search costs $0.01', web.u.usd >= 0.01, cents(web.u.usd));
  }

  // 6. Think harder
  if (wants('think')) {
    const think = await run('Think harder', opus, 'think-harder', QUESTION);
    check('Think harder costs between 0.5 and 10 cents', think.u.usd >= 0.005 && think.u.usd <= 0.1, cents(think.u.usd));
    const est = core.estimate(think.pack, 'think-harder', opus);
    say(`  estimate was ${cents(est.usd)}; real ${cents(think.u.usd)}`);
    const d = core.decide({ estimateUsd: 0.3, spentUsd: 0, capUsd: null, confirmOverUsd: 0.25, saved: true, scope: 'passages', priceKnown: true });
    check('a request over $0.25 would ask first', typeof d === 'object' && 'ask' in d && d.ask === 'over-threshold');
  }

  // 7. Effort comparison
  if (wants('effort')) {
    const rows = { low: [], medium: [] };
    for (const q of EFFORT_QUESTIONS) {
      for (const effort of ['low', 'medium']) {
        const pack = samplePack(q);
        const built = await core.buildRequest(pack, [{ role: 'user', content: q }], { role: 'default', model: haiku, webSearch: false });
        built.params.output_config = { effort };
        const r = await ask(core, key, built, { role: 'default', price: core.priceFor(haiku) });
        total += r.result.usage.usd;
        rows[effort].push({ q, out: r.result.usage.outputTokens, usd: r.result.usage.usd, words: r.result.body.split(/\s+/).length, cites: r.result.citations.length, body: r.result.body });
      }
    }
    const avg = (xs, f) => xs.reduce((s, x) => s + f(x), 0) / xs.length;
    say(`\nEffort comparison on ${EFFORT_QUESTIONS.length} questions (default model):`);
    for (const effort of ['low', 'medium']) {
      const r = rows[effort];
      say(`  ${effort.padEnd(6)} avg output ${avg(r, (x) => x.out).toFixed(0)} tokens, ${avg(r, (x) => x.words).toFixed(0)} words, ${avg(r, (x) => x.cites).toFixed(1)} citations, ${cents(avg(r, (x) => x.usd))} each`);
    }
    say('  Read the answers side by side before changing EFFORT in packages/core/src/claude/request.ts:');
    EFFORT_QUESTIONS.forEach((q, i) => say(`   - ${q}\n       low:    ${rows.low[i].body.replace(/\s+/g, ' ').slice(0, 160)}\n       medium: ${rows.medium[i].body.replace(/\s+/g, ' ').slice(0, 160)}`));
    check('the effort comparison ran', rows.low.length === EFFORT_QUESTIONS.length);
  }

  say(`\nTotal spent by this check: ${cents(total)} ($${total.toFixed(4)}).`);
  void topPassages;
} catch (e) {
  check('the live check ran to the end', false, scrub(e.message));
} finally {
  await close();
}

const failed = results.filter((r) => !r.ok);
say(`\n${results.length - failed.length} of ${results.length} checks passed.`);
if (outFile) {
  const text = JSON.stringify({ at: new Date().toISOString(), totalUsd: total, results }, null, 1);
  if (looksLikeKey(text)) {
    console.error('Not writing the report: it contains something shaped like a key.');
    process.exit(1);
  }
  writeFileSync(outFile, text);
}
process.exit(failed.length > 0 ? 1 : 0);

// Records a real reply as a fixture for the replay double (e2e/support/claude-replay.ts). The owner runs it with their own key;
// CI never does. Replace the synthetic fixtures in e2e/fixtures/claude/ with recordings when you have a key to spare.
//
//   ANTHROPIC_API_KEY_LIVE=... node scripts/claude/record.mjs --kind models|text|figure|web|think --name <fixture-name> [--out <dir>] [--dry-run]
//
// The key comes from the environment variable only, never from an argument. Without it the script says so and exits 1: it is only
// run on purpose, and a chain like `record.mjs && git add ...` must not go on as if a recording was made.
// What it writes is scrubbed: message and tool ids become fixture ids, the model becomes "$model", opaque encrypted blobs and
// signatures become placeholders, response headers are not kept, and citations become `$cite` placeholders that the double
// resolves against whatever request it is replaying. Model ids in the Models list become fixture ids too.
// It REFUSES to write a file that holds the key, a piece of it, or anything shaped like a key (exit code 2), and it never prints one.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ask, choose, listModels, loadCore, looksLikeKey, probeWebSearch, readKey, REPO, samplePack, say, scrub, KEY_ENV } from './lib.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const kind = opt('kind', '');
const name = opt('name', '');
const outDir = opt('out', join(REPO, 'e2e/fixtures/claude'));
const dryRun = args.includes('--dry-run');

const key = readKey();
if (!key) {
  console.error(`${KEY_ENV} is not set, so nothing was recorded. Nothing was sent.`);
  process.exit(1);
}
if (!['models', 'text', 'figure', 'web', 'think'].includes(kind) || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
  console.error('Usage: node scripts/claude/record.mjs --kind models|text|figure|web|think --name <fixture-name> [--out <dir>] [--dry-run]');
  process.exit(1);
}

// ---- Scrubbing ----

const MODEL_SHAPE = /\bclaude-[a-z0-9][a-z0-9.-]*/gi;

/** Ids become fixture ids, numbered in order of first appearance. */
function idMapper() {
  const seen = new Map();
  return (prefix, id) => {
    const k = `${prefix}:${id}`;
    if (!seen.has(k)) seen.set(k, `${prefix}_fixture_${String(seen.size + 1).padStart(2, '0')}`);
    return seen.get(k);
  };
}

export function scrubEvents(events) {
  const fixtureId = idMapper();
  const walk = (v, keyName) => {
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v === null || typeof v !== 'object') {
      if (typeof v !== 'string') return v;
      if (keyName === 'model') return '$model';
      if (keyName === 'encrypted_content' || keyName === 'encrypted_index') return 'FIXTURE_ENCRYPTED';
      if (keyName === 'signature') return 'FIXTURE_SIGNATURE';
      if ((keyName === 'id' || keyName === 'tool_use_id') && /^(msg|toolu|srvtoolu)_/.test(v)) return fixtureId(v.split('_')[0], v);
      return v.replace(MODEL_SHAPE, '$model');
    }
    if (v.type === 'content_block_location') return { $cite: { doc: v.document_title ?? '', block: v.start_block_index } };
    if (v.type === 'search_result_location') return { $cite: { searchResult: v.search_result_index } };
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
  };
  return events.map((e) => ({ data: walk(e) }));
}

function writeFixture(file, object) {
  const text = `${JSON.stringify(object, null, 1)}\n`;
  if (looksLikeKey(text)) {
    console.error(`Refusing to write ${file}: the recording holds something shaped like a key. Nothing was written.`);
    process.exit(2);
  }
  if (dryRun) return say(`(dry run) would write ${file}, ${text.length} bytes`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(file, text);
  say(`Wrote ${file}, ${text.length} bytes.`);
}

// ---- Recording ----

const today = new Date().toISOString().slice(0, 10);
const { core, close } = await loadCore();
try {
  const list = await listModels(key);
  if (kind === 'models') {
    const order = [...list].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const counts = new Map();
    const ids = new Map(order.map((m) => {
      const n = (counts.get(m.line) ?? 0) + 1;
      counts.set(m.line, n);
      return [m.id, `fixture-${m.line ?? 'other'}-${String.fromCharCode(96 + n)}`];
    }));
    const data = order.map((m) => ({ ...m, id: ids.get(m.id) }));
    writeFixture(join(outDir, `${name}.json`), { description: `The Models API list recorded ${today}, ids replaced by fixture ids.`, synthetic: false, models: { data, has_more: false, first_id: data[0].id, last_id: data.at(-1).id } });
  } else {
    const line = kind === 'think' ? 'opus' : 'haiku';
    const base = choose(list, line, null);
    if (!base) throw new Error(`no active ${line} model in the list`);
    const model = { ...base, webSearchTool: await probeWebSearch(key, base.id) };
    const question = { text: 'Why does the parallel trends assumption matter for this result?', figure: core.EXPLAIN_FIGURE_QUESTION, web: 'What is the difference-in-differences method, in general? Search the web for a definition.', think: 'Why does the parallel trends assumption matter for this result?' }[kind];
    const pack = samplePack(question, { figure: kind === 'figure' });
    const built = await core.buildRequest(pack, [{ role: 'user', content: question }], { role: kind === 'think' ? 'think-harder' : 'default', model, webSearch: kind === 'web' });
    const r = await ask(core, key, built, { role: 'default', price: core.priceFor(model) });
    say(`Recorded ${r.raw.length} events; ${r.result.citations.length} page citations, ${r.result.webSources.length} sources, ${r.result.usage.webSearches} searches.`);
    writeFixture(join(outDir, `${name}.json`), {
      description: `A ${kind} reply recorded ${today}. Citations are placeholders the double resolves against the request it replays.`,
      synthetic: false,
      steps: [{ events: scrubEvents(r.raw) }],
    });
  }
} catch (e) {
  console.error(scrub(e.message));
  process.exit(1);
} finally {
  await close();
}

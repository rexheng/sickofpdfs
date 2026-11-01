// Shared by scripts/claude/live-check.mjs and scripts/claude/record.mjs. Not part of the extension.
//
// These scripts call the Messages API with plain fetch (only apps/extension/src/viewer/claude/client.ts may import the SDK),
// but they build every request with the product's own code (packages/core/src/claude) and read every reply with its stream
// mapper, so a live run checks the code that ships.
//
// The key: read from the environment variable ANTHROPIC_API_KEY_LIVE only, never from an argument (arguments land in shell
// history), never printed, never written to a file. `scrub` is run over everything that is printed or written.
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

export const REPO = fileURLToPath(new URL('../../', import.meta.url));
export const KEY_ENV = 'ANTHROPIC_API_KEY_LIVE';
/** The API version the SDK sends (research 03 §5a). */
export const API_VERSION = '2026-10-21';

export const readKey = () => (process.env[KEY_ENV] ?? '').trim();
export const baseUrl = () => (process.env.CLAUDE_LIVE_BASE_URL ?? 'https://api.anthropic.com').replace(/\/+$/, '');

/** Loads the product's TypeScript (the way scripts/filter/report.mjs does) and returns the core package. */
export async function loadCore() {
  const { createServer } = await import('vite');
  const vite = await createServer({ root: REPO, logLevel: 'error', server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  const core = await vite.ssrLoadModule('/packages/core/src/index.ts');
  return { core, close: () => vite.close() };
}

// ---- Keeping the key out of output ----

const KEY_SHAPES = [/sk-ant-[A-Za-z0-9_-]{6,}/g, /\bsk-[A-Za-z0-9_-]{20,}/g];

/** Every place the key, or anything shaped like one, could show up: replaced. */
export function scrub(text, key = readKey()) {
  let out = String(text);
  if (key.length >= 8) {
    for (const piece of [key, key.slice(-12), key.slice(0, 12)]) if (piece.length >= 8) out = out.split(piece).join('[KEY]');
  }
  for (const shape of KEY_SHAPES) out = out.replace(shape, '[KEY]');
  return out;
}

/** True when `text` holds the key, a piece of it, or something shaped like a key. */
export function looksLikeKey(text, key = readKey()) {
  return scrub(text, key) !== String(text);
}

export const say = (...a) => console.log(scrub(a.join(' ')));

// ---- Calling the API ----

export class ApiError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}: ${scrub(typeof body === 'string' ? body : JSON.stringify(body)).slice(0, 300)}`);
    this.status = status;
  }
}

function headers(key, extra = {}) {
  return { 'x-api-key': key, 'anthropic-version': API_VERSION, 'content-type': 'application/json', ...extra };
}

export async function getJson(path, key) {
  const res = await fetch(`${baseUrl()}${path}`, { headers: headers(key) });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, body);
  return body;
}

/** POST that answers JSON (token counting). Returns `{ ok, status, body }` without throwing, so probes can read a 400. */
export async function postJson(path, key, payload) {
  const res = await fetch(`${baseUrl()}${path}`, { method: 'POST', headers: headers(key), body: JSON.stringify(payload) });
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
}

/** Streams POST /v1/messages and yields the events as objects. Throws ApiError for an HTTP failure. */
export async function* streamMessages(key, params) {
  const { betas, ...rest } = params;
  const res = await fetch(`${baseUrl()}/v1/messages`, {
    method: 'POST',
    headers: headers(key, betas?.length ? { 'anthropic-beta': betas.join(',') } : {}),
    body: JSON.stringify({ ...rest, stream: true }),
  });
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let cut;
    while ((cut = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut).replace(/^\r?\n\r?\n/, '');
      const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
      if (data) yield JSON.parse(data);
    }
  }
}

/** Builds the assistant message out of stream events: the exact blocks a follow-up turn must send back. */
export function assembleMessage(events) {
  const content = [];
  const json = new Map();
  let stop_reason = null;
  let usage = {};
  for (const e of events) {
    if (e.type === 'message_start') usage = { ...e.message.usage };
    else if (e.type === 'content_block_start') content[e.index] = { ...e.content_block, ...(e.content_block.type === 'text' ? { text: '' } : {}) };
    else if (e.type === 'content_block_delta') {
      const b = content[e.index];
      const d = e.delta;
      if (!b) continue;
      if (d.type === 'text_delta') b.text += d.text;
      else if (d.type === 'citations_delta') (b.citations ??= []).push(d.citation);
      else if (d.type === 'input_json_delta') json.set(e.index, (json.get(e.index) ?? '') + d.partial_json);
      else if (d.type === 'thinking_delta') b.thinking = (b.thinking ?? '') + d.thinking;
      else if (d.type === 'signature_delta') b.signature = d.signature;
    } else if (e.type === 'content_block_stop') {
      if (json.has(e.index)) content[e.index].input = JSON.parse(json.get(e.index) || '{}');
    } else if (e.type === 'message_delta') {
      stop_reason = e.delta.stop_reason ?? stop_reason;
      usage = { ...usage, ...e.usage };
    }
  }
  return { content: content.filter(Boolean), stop_reason, usage };
}

/** Runs one request through the product's mapper. Returns what the mapper made, the assistant blocks, and the raw events. */
export async function ask(core, key, built, mapperOptions) {
  const events = [];
  const out = [];
  const mapper = core.createStreamMapper(built.blocks, (e) => out.push(e), mapperOptions);
  for await (const e of streamMessages(key, built.params)) {
    events.push(e);
    mapper.push(e);
  }
  const message = assembleMessage(events);
  const result = mapper.finish(message);
  return { result, message, events: out, raw: events };
}

// ---- A small paper to ask about (original text for testing) ----

export const SAMPLE_PAGES = [
  ['Minimum wages and teen jobs: evidence from neighbouring counties',
   'Abstract. We study whether a rise in the minimum wage reduced teenage employment. We compare restaurants in counties on either side of a state border, using the years 2018 to 2022. We find no clear fall in jobs, and a rise in pay of about 6 percent.'],
  ['1. Introduction. Economists have long argued about the minimum wage. A simple model says that a higher price for labour means fewer workers are hired. Other models say that firms with market power may hire more when pay rises.',
   'This paper adds new evidence. We follow 1,204 restaurants for five years and compare those that faced the new wage with those just across the border that did not.'],
  ['2. Method. We use a difference-in-differences design. The key assumption is parallel trends: before the change, restaurants on both sides of the border were moving in the same way.',
   'We test this by comparing employment in the three years before the change. If the two groups drifted apart before the wage rose, the later gap could not be put down to the policy.'],
  ['3. Data. The data come from payroll records. Each restaurant is observed every quarter. We drop restaurants that open or close during the period, which removes 83 of the original 1,287.',
   'Wages are measured as the average hourly pay of workers aged 16 to 19.'],
  ['4. Results. Figure 2 shows the change in employment for the two groups. In the years before the change the points sit near zero. After the change the treated group does not fall below the control group.',
   'The estimated effect on employment is 0.4 percent, with a standard error of 1.1 percent. The estimated effect on pay is 6.2 percent.'],
  ['5. Conclusion. We find that the rise in the minimum wage raised pay and did not reduce teenage jobs in these restaurants. The result may not hold for much larger rises, or for other industries.'],
];

const CAPTION = 'Figure 2: Change in employment for treated and control restaurants, by year relative to the wage change.';

/** Paragraphs as the product's Passage shape, with offsets into a page's text. */
export function samplePassages(documentId = 'live-check-doc') {
  const out = [];
  SAMPLE_PAGES.forEach((paras, pageIndex) => {
    let offset = 0;
    for (const text of paras) {
      out.push({ documentId, pageIndex, start: offset, end: offset + text.length, textSource: 'pdfium', text, rank: 0, tokens: Math.ceil(text.length / 4) });
      offset += text.length + 1;
    }
  });
  return out;
}

const words = (s) => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];

/** The `n` paragraphs that share the most words with the question: a stand-in for the real retriever (slice B). */
export function topPassages(question, n = 5) {
  const q = new Set(words(question).filter((w) => w.length > 3));
  return samplePassages()
    .map((p) => ({ p, score: words(p.text).filter((w) => q.has(w)).length }))
    .sort((a, b) => b.score - a.score || a.p.pageIndex - b.p.pageIndex)
    .slice(0, n)
    .map((x, i) => ({ ...x.p, rank: i + 1 }));
}

export function sampleMap() {
  const all = samplePassages();
  return {
    title: SAMPLE_PAGES[0][0],
    abstract: all[1],
    headings: [{ text: 'Introduction', pageIndex: 1 }, { text: 'Method', pageIndex: 2 }, { text: 'Data', pageIndex: 3 }, { text: 'Results', pageIndex: 4 }, { text: 'Conclusion', pageIndex: 5 }],
    figures: [{ label: 'Figure 2', pageIndex: 4, caption: CAPTION }],
  };
}

export function samplePack(question, { figure = false, core } = {}) {
  const passages = topPassages(question, figure ? 3 : 5);
  const pack = { map: sampleMap(), focus: passages[0] ?? null, passages, figures: [], blocks: [], estimate: { inputTokens: 0, usd: 0 } };
  if (figure) {
    const png = barChartPng(840, 560);
    const caption = { documentId: 'live-check-doc', pageIndex: 4, start: 400, end: 400 + CAPTION.length, textSource: 'pdfium', text: CAPTION, rank: 1, tokens: Math.ceil(CAPTION.length / 4) };
    pack.figures.push({
      label: 'Figure 2', pageIndex: 4, caption, insideText: '[below] Years relative to the wage change, -3 -2 -1 0 1 2; [left, rotated] Change in employment, percent; [inside] Treated, Control',
      mentions: [passages[1]].filter(Boolean),
      image: { blob: new Blob([png]), mediaType: 'image/png', width: 840, height: 560, scale: 300 / 72, visualTokens: Math.ceil(840 / 28) * Math.ceil(560 / 28) },
    });
  }
  void core;
  return pack;
}

/** A plain bar chart as a PNG (no text), made here so the live check needs no image files. */
export function barChartPng(w, h) {
  const px = Buffer.alloc(w * h * 3, 255);
  const rect = (x0, y0, x1, y1, [r, g, b]) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * w + x) * 3; px[i] = r; px[i + 1] = g; px[i + 2] = b; }
  };
  rect(60, 40, 64, h - 60, [0, 0, 0]);
  rect(60, h - 64, w - 40, h - 60, [0, 0, 0]);
  const bars = [[0.2, [66, 133, 244], [234, 67, 53]], [0.1, [66, 133, 244], [234, 67, 53]], [0.0, [66, 133, 244], [234, 67, 53]], [0.15, [66, 133, 244], [234, 67, 53]], [0.3, [66, 133, 244], [234, 67, 53]], [0.25, [66, 133, 244], [234, 67, 53]]];
  bars.forEach(([hgt, c1, c2], i) => {
    const x = 90 + i * 118;
    rect(x, h - 64 - Math.round(hgt * 600) - 10, x + 40, h - 64, c1);
    rect(x + 46, h - 64 - Math.round((hgt * 0.9 + 0.02) * 600) - 10, x + 86, h - 64, c2);
  });
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; px.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3); }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ---- Picking models from the live list (no id is written anywhere in code) ----

const WEB_SEARCH_TOOLS = ['web_search_20260209', 'web_search_20250305'];

/** The newest active model of a line, as a ModelChoice. */
export function choose(list, line, webSearchTool, now = Date.now()) {
  const m = list
    .filter((x) => x.line === line && (x.lifecycle ?? 'active') === 'active')
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
  if (!m) return null;
  return {
    id: m.id, displayName: m.display_name, line: m.line, imageInput: m.capabilities?.image_input?.supported === true,
    webSearchTool, maxInputTokens: m.max_input_tokens ?? null, checkedAt: now,
  };
}

/** Which web search tool type this model accepts, newest first, found with free token counting. */
export async function probeWebSearch(key, modelId) {
  for (const type of WEB_SEARCH_TOOLS) {
    const r = await postJson('/v1/messages/count_tokens', key, { model: modelId, messages: [{ role: 'user', content: 'hi' }], tools: [{ type, name: 'web_search', max_uses: 1 }] });
    if (r.ok) return type;
  }
  return null;
}

export async function listModels(key) {
  const out = [];
  let after = '';
  for (let i = 0; i < 10; i++) {
    const page = await getJson(`/v1/models?limit=100${after ? `&after_id=${encodeURIComponent(after)}` : ''}`, key);
    out.push(...page.data);
    if (!page.has_more) break;
    after = page.last_id;
  }
  return out;
}

// A fake Anthropic for tests: replays recorded streams from e2e/fixtures/claude/, so every @Claude walkthrough runs with no key
// and no cost. It mounts on the fixture server under /claude, so the network gate (which allows only that origin) needs no change.
//
//   const replay = claudeReplay(server);   // once per fixture server
//   await replay.attach(page);             // test builds only: points the viewer's Anthropic calls here
//   replay.use('ask-passage');             // the scenario the next requests get
//   ...the owner asks Claude...
//   replay.requests()                      // what the app sent: sizes, blocks, breakpoints, images; never the key
//
// Routes: GET /claude/v1/models, POST /claude/v1/messages (streams), POST /claude/v1/messages/count_tokens. The double checks
// for an x-api-key header like the real API does (401 without one, 401 for a key that starts with BAD_KEY_PREFIX), but it never stores
// the key: records say only whether one was present. A key-shaped string in a request body is redacted in the record and flagged.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import type { FixtureServer } from './server';

export const CLAUDE_FIXTURES = fileURLToPath(new URL('../fixtures/claude/', import.meta.url));
/** Where the viewer's Anthropic calls go in a test build: `${origin}/claude`, and the SDK adds `/v1/...`. */
export const CLAUDE_PREFIX = '/claude';
/**
 * A key the double answers 401 to (for the "bad key" walkthroughs): any key that starts with this. Any other non-empty key is
 * accepted. It is joined at run time so that no key-shaped text is written in the repo, even a fake one.
 */
export const BAD_KEY_PREFIX = ['sk-ant', 'test-bad'].join('-');

// ---- Scenario files ----

/** One streamed event. `event` defaults to `data.type`. */
export interface ScenarioEvent { event?: string; data: unknown }

/**
 * What one call to POST /v1/messages gets. Either a stream (`events`, or `sse` naming a raw recording next to the scenario) or an
 * error (`status` other than 200 with `error`). Strings equal to "$model" become the model the request asked for, and an object
 * `{ "$cite": { "doc": "Relevant passages", "block": 0 } }` where a citation goes becomes a citation to that block of the request
 * (a trailing * in `doc` matches by prefix; `{ "searchResult": 0 }` cites the n-th search_result), so recordings do not depend on
 * how many headings the test document had.
 */
export interface ScenarioStep {
  status?: number;
  headers?: Record<string, string>;
  error?: { type: string; message: string };
  events?: ScenarioEvent[];
  sse?: string;
  /** Pause between events, in ms. */
  delayMs?: number;
  /** Send this many events, then keep the connection open and silent (a stuck stream; the tab is killed or Stop pressed). */
  stallAfter?: number;
  /** Send this many events, then cut the connection (a network failure). */
  dropAfter?: number;
  /** Skip the x-api-key check for this step. */
  noKeyNeeded?: boolean;
}

export interface Scenario {
  description?: string;
  /** True for fixtures written by hand to the documented wire format, until `scripts/claude/record.mjs` replaces them. */
  synthetic?: boolean;
  /** The answer to GET /v1/models. Without it the double answers with `models-default`. */
  models?: unknown;
  countTokens?: { input_tokens?: number; rejectToolTypes?: string[] };
  /** Consumed one per POST /v1/messages; the last one repeats. */
  steps?: ScenarioStep[];
}

export function loadScenario(name: string): Scenario {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`bad scenario name "${name}"`);
  return JSON.parse(readFileSync(`${CLAUDE_FIXTURES}${name}.json`, 'utf8')) as Scenario;
}

// ---- What a request looks like to a test ----

export interface ClaudeRequestRecord {
  seq: number;
  method: string;
  /** For example `/v1/messages`. */
  path: string;
  scenario: string | null;
  /** The parsed body with key-shaped strings replaced by [REDACTED-KEY]. Null for GET. */
  body: unknown;
  model: string | null;
  stream: boolean;
  /** Characters of text divided by 4, plus 28 x 28 tiles for each image. A rough size, the same rule the app's estimate uses. */
  approxInputTokens: number;
  imageTokens: number;
  messageCount: number;
  /** In order of appearance in the first user message. */
  contentTypes: string[];
  documentTitles: string[];
  documentCount: number;
  searchResultCount: number;
  textBlockCount: number;
  imageCount: number;
  /** Every cache_control in the request, top level included. Must be at most 4. */
  breakpoints: number;
  topLevelCacheControl: boolean;
  /** Hash of everything the first breakpoint caches (tools, system, and the first user message up to the block that has it). Equal hashes mean a cache hit. */
  prefixSha: string | null;
  toolNames: string[];
  webSearch: { type: string; max_uses: number | null } | null;
  /** Any of temperature, top_p, top_k found in the body: this must be empty. */
  samplingParams: string[];
  effort: string | null;
  maxTokens: number | null;
  /** The last text block of the last user message: the question. */
  question: string | null;
  /** 'present' or 'missing'. The key itself is never kept. */
  apiKey: 'present' | 'missing';
  /** A key-shaped string was found in the body. Must be false. */
  keyInBody: boolean;
  headers: { 'anthropic-version': string | null; 'anthropic-beta': string | null; 'content-type': string | null };
  /** What the double answered: the HTTP status. */
  status: number;
}

export interface ClaudeReplay {
  /** `${origin}/claude` */
  baseUrl: string;
  /** Chooses the scenario for the requests that follow and restarts its steps. */
  use(scenario: string | Scenario): void;
  requests(filter?: { path?: string }): ClaudeRequestRecord[];
  /** Forgets the captured requests (the scenario stays). */
  reset(): void;
  /** Test builds only: makes the viewer's Anthropic calls come here. Reloading or reopening the tab keeps it. */
  attach(page: Page): Promise<void>;
}

const KEY_SHAPE = /sk-ant-[A-Za-z0-9_-]{6,}/g;
const MAX_BODY = 48 * 1024 * 1024;
const IMAGE_TOKEN_CAP = 4784;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Width and height from the header of a base64 PNG or JPEG; null when it is neither. */
export function imageSize(base64: string): { width: number; height: number } | null {
  const bytes = Buffer.from(base64.slice(0, 200_000), 'base64');
  if (bytes.length > 24 && bytes.readUInt32BE(0) === 0x89504e47) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return null;
      const marker = bytes[i + 1];
      const len = bytes.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
      i += 2 + len;
    }
  }
  return null;
}

function countKey(value: unknown, key: string): number {
  if (Array.isArray(value)) return value.reduce<number>((n, v) => n + countKey(v, key), 0);
  if (!isRec(value)) return 0;
  let n = 0;
  for (const [k, v] of Object.entries(value)) n += (k === key ? 1 : 0) + countKey(v, key);
  return n;
}

function summarize(seq: number, method: string, path: string, scenario: string | null, bodyText: string, headers: IncomingMessage['headers']): Omit<ClaudeRequestRecord, 'status'> {
  const key = typeof headers['x-api-key'] === 'string' ? headers['x-api-key'] : '';
  const keyInBody = new RegExp(KEY_SHAPE.source).test(bodyText) || (key.length >= 8 && bodyText.includes(key));
  let redacted = bodyText.replace(KEY_SHAPE, '[REDACTED-KEY]');
  if (key.length >= 8) redacted = redacted.split(key).join('[REDACTED-KEY]');
  let body: unknown;
  try {
    body = bodyText ? JSON.parse(redacted) : null;
  } catch {
    body = null;
  }
  const b = isRec(body) ? body : {};
  const messages = Array.isArray(b.messages) ? (b.messages as unknown[]) : [];

  let chars = 0;
  let imageTokens = 0;
  let images = 0;
  let texts = 0;
  let docs = 0;
  let searchResults = 0;
  const docTitles: string[] = [];
  const walk = (node: unknown) => {
    if (typeof node === 'string') return;
    if (Array.isArray(node)) return void node.forEach(walk);
    if (!isRec(node)) return;
    switch (node.type) {
      case 'text':
        texts += 1;
        chars += typeof node.text === 'string' ? node.text.length : 0;
        return;
      case 'image': {
        images += 1;
        const src = isRec(node.source) ? node.source : {};
        const size = typeof src.data === 'string' ? imageSize(src.data) : null;
        imageTokens += size ? Math.min(IMAGE_TOKEN_CAP, Math.ceil(size.width / 28) * Math.ceil(size.height / 28)) : 0;
        return;
      }
      case 'document': {
        docs += 1;
        if (typeof node.title === 'string') docTitles.push(node.title);
        chars += typeof node.context === 'string' ? node.context.length : 0;
        walk(isRec(node.source) ? node.source.content : null);
        return;
      }
      case 'search_result':
        searchResults += 1;
        chars += typeof node.title === 'string' ? node.title.length : 0;
        walk(node.content);
        return;
      case 'tool_result':
        walk(node.content);
        return;
      case 'tool_use':
        chars += JSON.stringify(node.input ?? {}).length;
        return;
      default:
    }
  };
  chars += JSON.stringify(b.tools ?? []).length + (typeof b.system === 'string' ? b.system.length : JSON.stringify(b.system ?? '').length);
  for (const m of messages) walk(isRec(m) ? (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content) : null);

  // The first user message, up to and including the first block that carries a breakpoint, is breakpoint 1's prefix.
  const first = messages[0];
  const content = isRec(first) && Array.isArray(first.content) ? (first.content as unknown[]) : [];
  const upTo = content.findIndex((c) => isRec(c) && c.cache_control !== undefined);
  const prefix = upTo >= 0 ? content.slice(0, upTo + 1) : null;
  const tools = Array.isArray(b.tools) ? (b.tools as unknown[]).filter(isRec) : [];
  const web = tools.find((t) => typeof t.type === 'string' && t.name === 'web_search');
  const last = messages[messages.length - 1];
  const lastContent = isRec(last) ? (typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : (last.content as unknown[])) : [];
  const lastText = [...(Array.isArray(lastContent) ? lastContent : [])].reverse().find((c) => isRec(c) && c.type === 'text');
  const output = isRec(b.output_config) ? b.output_config : {};

  return {
    seq, method, path, scenario, body,
    model: typeof b.model === 'string' ? b.model : null,
    stream: b.stream === true,
    approxInputTokens: Math.ceil(chars / 4) + imageTokens,
    imageTokens,
    messageCount: messages.length,
    contentTypes: content.map((c) => (isRec(c) && typeof c.type === 'string' ? c.type : '?')),
    documentTitles: docTitles,
    documentCount: docs,
    searchResultCount: searchResults,
    textBlockCount: texts,
    imageCount: images,
    breakpoints: countKey(b, 'cache_control'),
    topLevelCacheControl: isRec(b.cache_control),
    prefixSha: prefix ? createHash('sha256').update(JSON.stringify([b.tools ?? null, b.system ?? null, prefix])).digest('hex').slice(0, 16) : null,
    toolNames: tools.map((t) => (typeof t.name === 'string' ? t.name : '?')),
    webSearch: web ? { type: String(web.type), max_uses: typeof web.max_uses === 'number' ? web.max_uses : null } : null,
    samplingParams: ['temperature', 'top_p', 'top_k'].filter((k) => k in b),
    effort: typeof output.effort === 'string' ? output.effort : null,
    maxTokens: typeof b.max_tokens === 'number' ? b.max_tokens : null,
    question: isRec(lastText) && typeof lastText.text === 'string' ? lastText.text : null,
    apiKey: key ? 'present' : 'missing',
    keyInBody,
    headers: {
      'anthropic-version': typeof headers['anthropic-version'] === 'string' ? headers['anthropic-version'] : null,
      'anthropic-beta': typeof headers['anthropic-beta'] === 'string' ? headers['anthropic-beta'] : null,
      'content-type': typeof headers['content-type'] === 'string' ? headers['content-type'] : null,
    },
  };
}

// ---- Placeholders in recorded data ----

interface CiteContext { request: Rec | null }

/** The request's document blocks in order, with their text blocks, for `$cite`. */
function requestDocs(request: Rec | null): { title: string; blocks: string[] }[] {
  const out: { title: string; blocks: string[] }[] = [];
  const messages = request && Array.isArray(request.messages) ? (request.messages as unknown[]) : [];
  for (const m of messages) {
    if (!isRec(m) || !Array.isArray(m.content)) continue;
    for (const c of m.content as unknown[]) {
      if (!isRec(c) || c.type !== 'document') continue;
      const src = isRec(c.source) && Array.isArray(c.source.content) ? (c.source.content as unknown[]) : [];
      out.push({ title: str(c.title), blocks: src.map((s) => (isRec(s) && typeof s.text === 'string' ? s.text : '')) });
    }
  }
  return out;
}

function requestSearchResults(request: Rec | null): { title: string; source: string; text: string }[] {
  const out: { title: string; source: string; text: string }[] = [];
  const messages = request && Array.isArray(request.messages) ? (request.messages as unknown[]) : [];
  for (const m of messages) {
    if (!isRec(m) || !Array.isArray(m.content)) continue;
    for (const c of m.content as unknown[]) {
      if (!isRec(c) || c.type !== 'tool_result' || !Array.isArray(c.content)) continue;
      for (const r of c.content as unknown[]) {
        if (!isRec(r) || r.type !== 'search_result') continue;
        const parts = Array.isArray(r.content) ? (r.content as unknown[]) : [];
        out.push({ title: str(r.title), source: str(r.source), text: parts.map((p) => (isRec(p) && typeof p.text === 'string' ? p.text : '')).join('') });
      }
    }
  }
  return out;
}

function resolveCite(spec: Rec, ctx: CiteContext): Rec {
  if (typeof spec.searchResult === 'number') {
    const found = requestSearchResults(ctx.request)[spec.searchResult];
    if (!found) throw new Error(`scenario cites search_result ${spec.searchResult}, but the request held ${requestSearchResults(ctx.request).length}`);
    return { type: 'search_result_location', cited_text: found.text, search_result_index: spec.searchResult, source: found.source, title: found.title, start_block_index: 0, end_block_index: 1 };
  }
  const want = str(spec.doc);
  const block = typeof spec.block === 'number' ? spec.block : 0;
  const docs = requestDocs(ctx.request);
  const index = docs.findIndex((d) => (want.endsWith('*') ? d.title.startsWith(want.slice(0, -1)) : d.title === want));
  const doc = docs[index];
  if (!doc || block >= doc.blocks.length) {
    throw new Error(`scenario cites block ${block} of "${want}", but the request held ${docs.map((d) => `"${d.title}" (${d.blocks.length})`).join(', ') || 'no documents'}`);
  }
  return { type: 'content_block_location', cited_text: doc.blocks[block], document_index: index, document_title: doc.title, start_block_index: block, end_block_index: block + 1 };
}

function resolveData(value: unknown, model: string, ctx: CiteContext): unknown {
  if (value === '$model') return model;
  if (Array.isArray(value)) return value.map((v) => resolveData(v, model, ctx));
  if (!isRec(value)) return value;
  if (isRec(value.$cite)) return resolveCite(value.$cite, ctx);
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveData(v, model, ctx)]));
}

function parseSse(text: string): ScenarioEvent[] {
  return text.split(/\r?\n\r?\n/).flatMap((chunk) => {
    const lines = chunk.split(/\r?\n/);
    const event = lines.find((l) => l.startsWith('event:'))?.slice(6).trim();
    const data = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
    return data ? [{ ...(event ? { event } : {}), data: JSON.parse(data) as unknown }] : [];
  });
}

// ---- The double ----

const replays = new WeakMap<FixtureServer, ClaudeReplay>();

export function claudeReplay(server: FixtureServer): ClaudeReplay {
  const existing = replays.get(server);
  if (existing) return existing;

  const records: ClaudeRequestRecord[] = [];
  let seq = 0;
  let name: string | null = null;
  let scenario: Scenario | null = null;
  let cursor = 0;

  const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store', 'request-id': `req_fixture_${seq}`, ...headers });
    res.end(text);
  };
  const apiError = (res: ServerResponse, status: number, type: string, message: string, headers?: Record<string, string>) =>
    json(res, status, { type: 'error', error: { type, message } }, headers);

  async function readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) throw new Error('request body too large for the double');
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  async function stream(res: ServerResponse, step: ScenarioStep, record: ClaudeRequestRecord) {
    const model = record.model ?? 'fixture-model';
    const ctx: CiteContext = { request: isRec(record.body) ? record.body : null };
    const events = step.events ?? (step.sse ? parseSse(readFileSync(`${CLAUDE_FIXTURES}${step.sse}`, 'utf8')) : []);
    // Every event is resolved before the 200 header goes out. A scenario that cites a block the request did not hold then fails with
    // a readable 500 (the handler's catch), not with a connection cut after the header, which would hide the reason.
    const frames = events.map((ev) => {
      const data = resolveData(ev.data, model, ctx);
      const type = ev.event ?? (isRec(data) && typeof data.type === 'string' ? data.type : 'message');
      return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    });
    record.status = 200;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'request-id': `req_fixture_${record.seq}`, ...step.headers });
    // destroy() right after write() can discard bytes still in the buffer, so a "drop" waits until what was written has gone out.
    const flush = () => new Promise<void>((done) => res.write('', () => done()));
    const cut = async () => {
      await flush();
      res.destroy();
    };
    for (let i = 0; i < frames.length; i++) {
      if (step.stallAfter === i) {
        await new Promise<void>((done) => res.once('close', done)); // hold until the client goes away
        return;
      }
      if (step.dropAfter === i) return cut();
      if (res.destroyed) return;
      res.write(frames[i]);
      if (step.delayMs) await sleep(step.delayMs);
    }
    if (step.stallAfter === frames.length) await new Promise<void>((done) => res.once('close', done));
    else if (step.dropAfter === frames.length) await cut();
    else res.end();
  }

  async function handler(req: IncomingMessage, res: ServerResponse, fullPath: string): Promise<void> {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', '*');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-expose-headers', 'request-id, retry-after');
    if (req.method === 'OPTIONS') return void res.writeHead(204).end();
    const path = fullPath.slice(CLAUDE_PREFIX.length);
    const method = req.method ?? 'GET';
    seq += 1;

    let bodyText: string;
    try {
      bodyText = method === 'POST' ? await readBody(req) : '';
    } catch (e) {
      return apiError(res, 413, 'request_too_large', (e as Error).message);
    }
    const base = summarize(seq, method, path, name, bodyText, req.headers);
    const record: ClaudeRequestRecord = { ...base, status: 0 };
    records.push(record);
    const answer = <T>(status: number, send: () => T): T => {
      record.status = status;
      return send();
    };

    const key = typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : '';
    const step = path === '/v1/messages' && scenario?.steps ? scenario.steps[Math.min(cursor, scenario.steps.length - 1)] : undefined;
    if (!key && !step?.noKeyNeeded) return answer(401, () => apiError(res, 401, 'authentication_error', 'x-api-key header is required'));
    if (key.startsWith(BAD_KEY_PREFIX)) return answer(401, () => apiError(res, 401, 'authentication_error', 'invalid x-api-key'));

    if (method === 'GET' && (path === '/v1/models' || path.startsWith('/v1/models/'))) {
      const models = scenario?.models ?? loadScenario('models-default').models;
      return answer(200, () => json(res, 200, models));
    }
    if (method === 'POST' && path === '/v1/messages/count_tokens') {
      const rejected = scenario?.countTokens?.rejectToolTypes ?? [];
      const bad = (Array.isArray(isRec(record.body) ? record.body.tools : null) ? ((record.body as Rec).tools as unknown[]) : []).filter(isRec).find((t) => typeof t.type === 'string' && rejected.includes(t.type));
      if (bad) return answer(400, () => apiError(res, 400, 'invalid_request_error', `This model does not accept the tool type ${String(bad.type)}.`));
      return answer(200, () => json(res, 200, { input_tokens: scenario?.countTokens?.input_tokens ?? record.approxInputTokens }));
    }
    if (method === 'POST' && path === '/v1/messages') {
      if (!scenario?.steps || !step) return answer(404, () => apiError(res, 404, 'not_found_error', 'The replay double has no scenario with steps: call claudeReplay(server).use(name) first.'));
      cursor += 1;
      if (step.status && step.status !== 200) {
        const e = step.error ?? { type: 'api_error', message: 'Something went wrong.' };
        return answer(step.status, () => apiError(res, step.status!, e.type, e.message, step.headers));
      }
      try {
        await stream(res, step, record);
      } catch (e) {
        if (!res.headersSent) {
          record.status = 500;
          apiError(res, 500, 'api_error', (e as Error).message);
        } else res.destroy();
      }
      return;
    }
    return answer(404, () => apiError(res, 404, 'not_found_error', `The replay double has no route ${method} ${path}.`));
  }

  server.mount(CLAUDE_PREFIX, handler);
  const replay: ClaudeReplay = {
    baseUrl: `${server.origin}${CLAUDE_PREFIX}`,
    use(s) {
      name = typeof s === 'string' ? s : '(inline)';
      scenario = typeof s === 'string' ? loadScenario(s) : s;
      cursor = 0;
    },
    requests: (filter) => records.filter((r) => !filter?.path || r.path === filter.path),
    reset() {
      records.length = 0;
    },
    async attach(page) {
      const set = await page.evaluate((url) => {
        const hook = (globalThis as { __sopClaude?: { setBaseUrl(u: string | null): void } }).__sopClaude;
        if (!hook) return false;
        hook.setBaseUrl(url);
        return true;
      }, replay.baseUrl);
      if (!set) throw new Error('This page has no Claude test hook: attach() only works on a viewer page of a test build (pnpm e2e builds one).');
    },
  };
  replays.set(server, replay);
  return replay;
}

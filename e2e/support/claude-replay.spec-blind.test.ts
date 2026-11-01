/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- these tests read wire JSON from an API we do not own, and cast modules that did not exist when they were written */
// Spec-blind tests for slice E: the recorded-response double (e2e/support/claude-replay.ts), its recordings
// (e2e/fixtures/claude/), the recorder (scripts/claude/record.mjs) and the test-only base URL module.
//
// Sources:
//   plan Phase 4, slice E: "A fake Anthropic that replays recorded streams"; "fixture-server routes
//     /claude/v1/{models,messages,messages/count_tokens} replay a named scenario; claudeReplay(server).use(name), and .requests()
//     returns the captured bodies (token size, blocks, breakpoints, images, no key in the body)"; "the recorder reads a key from
//     an environment variable only, scrubs ids and headers, and refuses to write anything that looks like a key"; "the live
//     workflow ... runs the model list, a text question, a figure question, a web search, a follow-up that must show cache reads,
//     and Think harder";
//   plan section 3 "Tests": CI and every walkthrough run against the double and never use a live key;
//   plan A7: the base URL hook exists in test builds only; plan section 9: "the recorder refuses key-like output";
//   plan Gate 1 item 10 and done-when 4: nothing reaches Anthropic or the replay server without a Claude action;
//   frontier check: the Models API returns `line`, `lifecycle` and `capabilities` (image_input, server_tools.web_search).
//
// The plan says "no spec-blind tests" for E because it is a security read. These are the checks that need no knowledge of the
// code: what the double does on the wire, what the recordings hold, and what the recorder does with no key. Scenario names are
// not in the plan, so the recordings are found by listing the fixtures folder and trying each name.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import http from 'node:http';
import { join, relative, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FAKE_KEY, KEY_SHAPES, accumulate, looksLikeKey, parseSse,
  type CreateStreamMapper, type Obj,
} from '../../packages/core/test/spec-blind/claude-kit';
import { createStreamMapper } from '../../packages/core/src/claude/stream-map';
import { claudeReplay } from './claude-replay';
import { startFixtureServer, type FixtureServer } from './server';

const ROOT = join(import.meta.dirname, '..', '..');
const FIXTURES = join(ROOT, 'e2e', 'fixtures', 'claude');
type Server = FixtureServer & { close(): Promise<void> };
type Replay = { use(name: string): unknown; requests(): unknown[] };

// ---------------------------------------------------------------------------------------------------------------------
// Small tools

interface Raw { status: number; headers: http.IncomingHttpHeaders; text: string }
function raw(server: Server, method: string, path: string, o: { headers?: Record<string, string>; body?: unknown } = {}): Promise<Raw> {
  const { hostname, port } = new URL(server.origin);
  const body = o.body === undefined ? undefined : JSON.stringify(o.body);
  return new Promise((ok, fail) => {
    const req = http.request({ hostname, port, path, method, headers: { ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}), ...o.headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => ok({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', fail);
    if (body) req.write(body);
    req.end();
  });
}

const KEY_HEADERS = { 'x-api-key': FAKE_KEY, 'anthropic-version': '2026-10-21', 'anthropic-dangerous-direct-browser-access': 'true' };
const ASK = { model: 'fixture-model-default-0001', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'ZQ_CAPTURE_SENTINEL a plain question' }] };
const ask = (server: Server, extra: Obj = {}): Promise<Raw> => raw(server, 'POST', '/claude/v1/messages', { headers: KEY_HEADERS, body: { ...ASK, ...extra } });
const asJson = (r: Raw): Obj | null => { try { return JSON.parse(r.text) as Obj; } catch { return null; } };

/** Every file under the fixtures folder, as text, with its path from the repo root. */
function fixtureFiles(): { path: string; text: string }[] {
  if (!existsSync(FIXTURES)) return [];
  return (readdirSync(FIXTURES, { recursive: true }) as string[])
    .filter((p) => statSync(join(FIXTURES, p)).isFile() && !/\.(png|jpe?g|gif|webp|pdf)$/i.test(p))
    .map((p) => ({ path: relative(ROOT, join(FIXTURES, p)).split(sep).join('/'), text: readFileSync(join(FIXTURES, p), 'utf8') }));
}
const scenarioNames = (): string[] => {
  if (!existsSync(FIXTURES)) return [];
  const names = new Set<string>();
  for (const p of readdirSync(FIXTURES, { recursive: true }) as string[]) {
    const parts = p.split(sep);
    names.add(parts[0]!.replace(/\.[^.]+$/, ''));
    names.add((parts.at(-1) ?? '').replace(/(\.[^.]+)+$/, ''));
  }
  return [...names].filter(Boolean);
};

const KNOWN_EVENTS = new Set(['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop', 'ping', 'error']);
const DELTAS: Record<string, string[]> = {
  text: ['text_delta', 'citations_delta'], thinking: ['thinking_delta', 'signature_delta'],
  tool_use: ['input_json_delta'], server_tool_use: ['input_json_delta'], web_search_tool_result: [],
};
/** What is wrong with a stream by the Messages streaming grammar. Empty means well formed. */
function grammarProblems(events: Obj[]): string[] {
  const problems: string[] = [];
  if (events[0]?.type !== 'message_start') problems.push('does not start with message_start');
  const open = new Map<number, string>();
  let next = 0; let sawDelta = false; let stopped = false;
  for (const ev of events) {
    if (!KNOWN_EVENTS.has(String(ev.type))) problems.push(`unknown event ${String(ev.type)}`);
    if (stopped && ev.type !== 'ping') problems.push(`${String(ev.type)} after message_stop`);
    if (ev.type === 'content_block_start') {
      if (ev.index !== next) problems.push(`block index ${String(ev.index)}, expected ${next}`);
      next++; open.set(ev.index, String(ev.content_block?.type));
    } else if (ev.type === 'content_block_delta') {
      const kind = open.get(ev.index);
      if (kind === undefined) problems.push(`delta for block ${String(ev.index)} that is not open`);
      else if (!(DELTAS[kind] ?? []).includes(String(ev.delta?.type))) problems.push(`${String(ev.delta?.type)} inside a ${kind} block`);
    } else if (ev.type === 'content_block_stop') {
      if (!open.delete(ev.index)) problems.push(`stop for block ${String(ev.index)} that is not open`);
    } else if (ev.type === 'message_delta') sawDelta = true;
    else if (ev.type === 'message_stop') stopped = true;
  }
  if (!events.some((e) => e.type === 'error')) {
    if (open.size) problems.push(`blocks left open: ${[...open.keys()].join(',')}`);
    if (!sawDelta) problems.push('no message_delta');
    if (!stopped) problems.push('no message_stop');
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------------
// Finding the recordings by trying each name against a throwaway double

interface Found { messages: { name: string; events: Obj[]; wire: string }[]; models: { name: string; body: Obj }[] }
let found: Found;
let server: Server;
const firstScenario = (): string => {
  const name = found.messages[0]?.name;
  if (!name) throw new Error('no scenario answers POST /claude/v1/messages with a stream, so there is nothing to replay');
  return name;
};
let replay: Replay;

beforeAll(async () => {
  server = await startFixtureServer();
  replay = claudeReplay(server as never) as Replay;
  found = { messages: [], models: [] };
  for (const name of scenarioNames()) {
    try { await replay.use(name); } catch { continue; }
    const m = await ask(server);
    if (m.status === 200 && /text\/event-stream/.test(String(m.headers['content-type']))) found.messages.push({ name, events: parseSse(m.text).events, wire: m.text });
    const l = await raw(server, 'GET', '/claude/v1/models', { headers: KEY_HEADERS });
    const body = l.status === 200 ? asJson(l) : null;
    if (body && Array.isArray(body['data'])) found.models.push({ name, body });
  }
});
afterAll(async () => { await server.close(); });

describe('the recordings cover what the walkthroughs need (plan slice E live-check list, Gate 1)', () => {
  it('has a model list and several streams to replay', () => {
    expect(scenarioNames().length, 'no files under e2e/fixtures/claude').toBeGreaterThan(0);
    expect(found.models.length, 'no scenario answers GET /claude/v1/models').toBeGreaterThanOrEqual(1);
    expect(found.messages.length, 'fewer than 3 scenarios answer POST /claude/v1/messages with a stream').toBeGreaterThanOrEqual(3);
  });

  it('includes cited page answers, a web search with a cited source, and a follow-up that reads the cache', () => {
    const all = found.messages.flatMap((m) => m.events);
    const cites = (type: string) => all.some((e) => e.type === 'content_block_delta' && e.delta?.type === 'citations_delta' && e.delta.citation?.type === type);
    expect(cites('content_block_location'), 'no stream cites a passage (Gate 1 item 1)').toBe(true);
    expect(all.some((e) => e.type === 'content_block_start' && e.content_block?.type === 'server_tool_use' && e.content_block?.name === 'web_search'), 'no web search (item 4)').toBe(true);
    expect(cites('web_search_result_location'), 'no web source is cited (item 4)').toBe(true);
    expect(all.some((e) => e.type === 'message_start' && Number(e.message?.usage?.cache_read_input_tokens) > 0), 'no stream shows cache reads (item 9, done-when 3)').toBe(true);
  });
});

describe('every recorded stream is a well-formed Messages stream, and the mapper can finish each one', () => {
  it('follows the grammar: block order, deltas inside their block, a closing message_delta and message_stop', () => {
    for (const m of found.messages) {
      const { mismatches } = parseSse(m.wire);
      expect(mismatches, `${m.name}: event name differs from the data's type`).toEqual([]);
      expect(grammarProblems(m.events), m.name).toEqual([]);
    }
  });

  it('replays through the stream mapper to a finished reply (no crash, a done or an error, never stuck)', () => {
    const create = createStreamMapper as unknown as CreateStreamMapper;
    for (const m of found.messages) {
      const emitted: unknown[] = [];
      const mapper = create([], (e) => emitted.push(e));
      for (const ev of m.events) mapper.push(ev);
      const out = mapper.finish(accumulate(m.events));
      const errored = m.events.some((e) => e.type === 'error') || m.events.some((e) => e.type === 'message_delta' && e.delta?.stop_reason === 'refusal');
      expect(out.status, m.name).toBe(errored ? 'error' : 'done');
      expect(looksLikeKey(JSON.stringify([emitted, out])), m.name).toBeNull();
    }
  });
});

describe('the recordings are scrubbed (plan: "scrubs ids and headers, and refuses to write anything that looks like a key")', () => {
  // The three checks below are only worth anything if they catch what they are meant to catch.
  const HEADER_LINE = /^\s*"?(?:x-api-key|authorization|anthropic-organization-id|request-id|cf-ray|set-cookie|anthropic-ratelimit-[\w-]+)"?\s*[:=]/im;
  const REAL_ID = /\b(?:msg|req|toolu|srvtoolu)_[0-9A-Za-z]{20,}\b/;
  const ORG_ID = /\b(?:org|wrkspc|apikey)_[0-9A-Za-z]{10,}\b/;

  it('the scanners catch planted examples (positive controls)', () => {
    expect(looksLikeKey(FAKE_KEY)).not.toBeNull();
    expect(looksLikeKey('Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345')).not.toBeNull();
    expect(HEADER_LINE.test('x-api-key: anything')).toBe(true);
    expect(HEADER_LINE.test('"request-id": "req_011CZ..."')).toBe(true);
    expect(REAL_ID.test('msg_01XFDUDYJgAACzvnptvVoYEL')).toBe(true);
    expect(ORG_ID.test('org_0123456789abcdef')).toBe(true);
    expect(KEY_SHAPES.length).toBeGreaterThan(1);
  });

  it('no recording holds a key, a header that carries identity, a real message id or an organisation id', () => {
    const files = fixtureFiles();
    expect(files.length, 'no recordings found').toBeGreaterThan(0);
    for (const f of files) {
      expect(looksLikeKey(f.text), `${f.path} holds something shaped like a key`).toBeNull();
      expect(HEADER_LINE.exec(f.text)?.[0], `${f.path} holds a header line`).toBeUndefined();
      expect(REAL_ID.exec(f.text)?.[0], `${f.path} holds an unscrubbed id`).toBeUndefined();
      expect(ORG_ID.exec(f.text)?.[0], `${f.path} holds an organisation id`).toBeUndefined();
    }
  });
});

describe('the models list (frontier check: line, lifecycle, capabilities; slice G reads it to preselect Haiku and Opus)', () => {
  it('lists models with unique ids, a line, a lifecycle and a capability tree, and has an active Haiku and an active Opus', () => {
    const data = found.models[0]?.body['data'] as Obj[] | undefined;
    expect(data, 'no models list').toBeDefined();
    expect(data!.length).toBeGreaterThan(0);
    expect(new Set(data!.map((m) => m['id'])).size).toBe(data!.length);
    for (const m of data!) {
      expect(typeof m['id'], 'id').toBe('string');
      expect(String(m['id']).length).toBeGreaterThan(0);
      expect(typeof m['display_name'], `${String(m['id'])} display_name`).toBe('string');
      expect(m['line'] === null || typeof m['line'] === 'string', `${String(m['id'])} line`).toBe(true);
      expect(typeof m['lifecycle'], `${String(m['id'])} lifecycle`).toBe('string');
      expect(typeof m['capabilities']?.image_input?.supported, `${String(m['id'])} capabilities.image_input.supported`).toBe('boolean');
    }
    for (const line of ['haiku', 'opus']) expect(data!.some((m) => m['line'] === line && m['lifecycle'] === 'active'), `no active ${line}`).toBe(true);
  });
});

describe('what the double does with a request', () => {
  it('captures what was sent, and never the key, not in what it captured and not in what it answered', async () => {
    const s = await startFixtureServer();
    try {
      const r = claudeReplay(s as never) as Replay;
      await r.use(firstScenario());
      const body = {
        ...ASK,
        cache_control: { type: 'ephemeral' },
        messages: [{ role: 'user', content: [
          { type: 'document', title: 't', citations: { enabled: true }, cache_control: { type: 'ephemeral' }, source: { type: 'content', content: [{ type: 'text', text: 'ZQ_CAPTURE_DOC passage text' }] } },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
          { type: 'text', text: 'ZQ_CAPTURE_SENTINEL why?' },
        ] }],
      };
      const res = await raw(s, 'POST', '/claude/v1/messages', { headers: KEY_HEADERS, body });
      expect(res.status).toBe(200);
      const captured = r.requests();
      expect(captured).toHaveLength(1);
      const dump = JSON.stringify(captured);
      expect(dump).toContain('ZQ_CAPTURE_SENTINEL');
      expect(dump).toContain('ZQ_CAPTURE_DOC');
      for (const where of [dump, res.text, JSON.stringify(res.headers)]) {
        expect(where).not.toContain('SPECBLINDFAKEKEY');
        expect(looksLikeKey(where)).toBeNull();
      }
    } finally {
      await s.close();
    }
  });

  it('counts requests one by one, and a preflight is not a request', async () => {
    const s = await startFixtureServer();
    try {
      const r = claudeReplay(s as never) as Replay;
      expect(r.requests()).toEqual([]); // nothing has been asked, nothing is recorded
      await r.use(firstScenario());
      expect(r.requests()).toEqual([]);
      await raw(s, 'OPTIONS', '/claude/v1/messages', { headers: { origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop', 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-api-key,content-type' } });
      expect(r.requests()).toEqual([]);
      await ask(s);
      await ask(s);
      expect(r.requests()).toHaveLength(2);
    } finally {
      await s.close();
    }
  });

  it('serves a count_tokens answer (free token counting for the calibration): a positive whole number that grows with the request', async () => {
    const s = await startFixtureServer();
    try {
      const r = claudeReplay(s as never) as Replay;
      await r.use(firstScenario());
      const small = await raw(s, 'POST', '/claude/v1/messages/count_tokens', { headers: KEY_HEADERS, body: { model: ASK.model, messages: [{ role: 'user', content: 'short' }] } });
      const big = await raw(s, 'POST', '/claude/v1/messages/count_tokens', { headers: KEY_HEADERS, body: { model: ASK.model, messages: [{ role: 'user', content: 'a longer question '.repeat(500) }] } });
      expect(small.status).toBe(200);
      const [a, b] = [asJson(small)!['input_tokens'], asJson(big)!['input_tokens']] as number[];
      expect(Number.isInteger(a) && a! > 0).toBe(true);
      expect(b!).toBeGreaterThanOrEqual(a!);
    } finally {
      await s.close();
    }
  });

  it('an unknown scenario name is an error, never a quiet fallback to some other recording', async () => {
    const s = await startFixtureServer();
    try {
      const r = claudeReplay(s as never) as Replay;
      let threw = false;
      try { await r.use('no-such-scenario-was-ever-recorded'); } catch { threw = true; }
      if (!threw) expect((await ask(s)).status).toBeGreaterThanOrEqual(400);
    } finally {
      await s.close();
    }
  });

  it('a reader that goes away mid-stream (Stop) does not break the double', async () => {
    const s = await startFixtureServer();
    const crashes: string[] = [];
    const note = (e: unknown) => { crashes.push(String(e)); };
    process.on('uncaughtException', note);
    process.on('unhandledRejection', note);
    try {
      const r = claudeReplay(s as never) as Replay;
      await r.use(firstScenario());
      const abort = new AbortController();
      const res = await fetch(s.url('/claude/v1/messages'), { method: 'POST', headers: { 'content-type': 'application/json', ...KEY_HEADERS }, body: JSON.stringify(ASK), signal: abort.signal });
      const reader = res.body!.getReader();
      await reader.read();
      abort.abort();
      await reader.cancel().catch(() => undefined);
      await new Promise((done) => setTimeout(done, 200));
      expect((await ask(s)).status).toBe(200); // still serving
      expect(crashes).toEqual([]);
    } finally {
      process.off('uncaughtException', note);
      process.off('unhandledRejection', note);
      await s.close();
    }
  });
});

describe('browser access: the viewer page is on another origin, so every route must answer a CORS preflight', () => {
  const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
  const list = (v: string | string[] | undefined): string[] => String(v ?? '').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean);

  it.each([
    { path: '/claude/v1/messages', method: 'POST' },
    { path: '/claude/v1/messages/count_tokens', method: 'POST' },
    { path: '/claude/v1/models', method: 'GET' },
  ])('$method $path: the preflight allows the SDK\'s headers and the method', async ({ path, method }) => {
    const wanted = ['content-type', 'x-api-key', 'anthropic-version', 'anthropic-dangerous-direct-browser-access'];
    const res = await raw(server, 'OPTIONS', path, { headers: { origin: ORIGIN, 'access-control-request-method': method, 'access-control-request-headers': wanted.join(',') } });
    expect([200, 204]).toContain(res.status);
    const allowOrigin = String(res.headers['access-control-allow-origin']);
    expect([ORIGIN, '*']).toContain(allowOrigin);
    const headers = list(res.headers['access-control-allow-headers']);
    for (const h of wanted) expect(headers.includes(h) || headers.includes('*'), `allow-headers has ${h}`).toBe(true);
    const methods = list(res.headers['access-control-allow-methods']);
    expect(methods.includes(method.toLowerCase()) || methods.includes(method) || methods.includes('*') || methods.map((m) => m.toUpperCase()).includes(method)).toBe(true);
  });

  it('the stream itself carries the CORS header and the event-stream type', async () => {
    await replay.use(firstScenario());
    const res = await raw(server, 'POST', '/claude/v1/messages', { headers: { ...KEY_HEADERS, origin: ORIGIN }, body: ASK });
    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'])).toMatch(/^text\/event-stream/);
    expect([ORIGIN, '*']).toContain(String(res.headers['access-control-allow-origin']));
  });
});

describe('the recorder (scripts/claude/record.mjs): key from the environment only, nothing written without one', () => {
  const script = join(ROOT, 'scripts', 'claude', 'record.mjs');

  it('has no key in its source, never takes one on the command line, and guards what it writes against key shapes', () => {
    expect(existsSync(script), 'scripts/claude/record.mjs is missing').toBe(true);
    const src = readFileSync(script, 'utf8').replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, '$1');
    expect(looksLikeKey(src.replace(/sk-ant-\[[^\]]*\][^\s'"`]*/g, ''))).toBeNull(); // a pattern is fine, a key is not
    expect(src).toMatch(/process\.env/);
    expect(src).not.toMatch(/--(?:api-?)?key\b/i);
    expect(src).toMatch(/sk-ant|sk-\[|key-?like|looks?Like/i); // some check for key-shaped text before writing
  });

  it('with no key set it stops with a plain message, writes nothing and prints no key', () => {
    const before = fixtureFiles().map((f) => `${f.path}:${f.text.length}`).sort();
    const run = spawnSync(process.execPath, [script], {
      cwd: ROOT, encoding: 'utf8', timeout: 20_000,
      env: { PATH: process.env['PATH'] ?? '', HOME: process.env['TMPDIR'] ?? '/tmp', NODE_ENV: 'test' },
    });
    expect(run.error, 'it should exit by itself, not hang').toBeUndefined();
    expect(run.status).not.toBe(0);
    const out = `${run.stdout}\n${run.stderr}`;
    expect(out.trim().length).toBeGreaterThan(0);
    expect(out).toMatch(/key/i);
    expect(looksLikeKey(out)).toBeNull();
    expect(fixtureFiles().map((f) => `${f.path}:${f.text.length}`).sort()).toEqual(before);
  });
});

describe('the test-only base URL module (plan A7; slice K proves production has none)', () => {
  const walk = (dir: string): string[] => (existsSync(dir) ? (readdirSync(dir, { recursive: true }) as string[]).map((p) => join(dir, p)).filter((p) => statSync(p).isFile()) : []);

  it('exists, and only the Anthropic client imports it, never an entry point, the store, the library or Settings', () => {
    const module = join(ROOT, 'apps', 'extension', 'src', 'testing', 'claude-base-url.ts');
    expect(existsSync(module), 'apps/extension/src/testing/claude-base-url.ts is missing').toBe(true);
    const importers = walk(join(ROOT, 'apps', 'extension', 'src'))
      .filter((p) => /\.(ts|tsx|js|mjs)$/.test(p) && !/\.(test|spec-blind)\b|\.spec-blind\./.test(p) && p !== module)
      .filter((p) => /claude-base-url/.test(readFileSync(p, 'utf8')))
      .map((p) => relative(ROOT, p).split(sep).join('/'))
      .filter((p) => !p.startsWith('apps/extension/src/testing/'));
    expect(importers.every((p) => p === 'apps/extension/src/viewer/claude/client.ts'), `unexpected importers: ${importers.join(', ')}`).toBe(true);
  });
});

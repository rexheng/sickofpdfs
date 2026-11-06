// Settings → Claude (plan §4 slice G): checking a pasted key with Anthropic, and keeping it on this computer.
//
// The key is the most sensitive thing the extension holds. The rules this file keeps:
// - It goes only to the local-only store (`setSecret('anthropic_api_key')`, Task 29), never to the library, a setting, a
//   message, a log or an error. Nothing here logs, and no error or answer it gives carries the key or a piece of it, apart
//   from `savedKeyEnding`, which is the last 4 characters the owner sees as "Key saved ····abcd".
// - It is sent only to api.anthropic.com, in the `x-api-key` header, and only when the owner presses a button: "Check and save"
//   (three small calls: the Models list, then a free token count for each chosen model, everyday and Think harder, that finds
//   which web search tool it takes),
//   "Check again" (the same calls), or a new model choice (free token counting, model-discovery.ts). None carries document text.
//   Opening Settings sends nothing and reads no key.
// - Reading never creates the local-only database: with no database there is no key and no spend.
//
// These calls use plain `fetch` with an explicit key: the key is checked BEFORE it is stored, so the viewer's client
// (slice D, `viewer/claude/client.ts`, the only file that imports the SDK) cannot make them; it reads the stored key.
import { LOCAL_ONLY_DB, type LocalOnlyStore, openLocalOnlyStore } from '../local-only/secrets-store';

const API_ORIGIN = 'https://api.anthropic.com';
/** The API version the SDK sends (research 03 §5a; scripts/claude/lib.mjs uses the same). */
const API_VERSION = '2026-10-21';
/** A check that has not answered by then has failed (no network, or a stuck connection). */
const TIMEOUT_MS = 20_000;
/** The Models list answers up to 1,000 models a page, so one call is the whole list. Pages after that are followed, up to this. */
const MODELS_PER_PAGE = 1000;
const MAX_PAGES = 3;

/** Why a call to Anthropic did not work, in the owner's terms. ClaudeSettingsSection says each one in plain words. */
export type ApiProblem = 'bad-key' | 'not-allowed' | 'network' | 'busy' | 'server';

export type Answer<T> = { ok: true; value: T } | { ok: false; problem: ApiProblem };

function problemOf(status: number): ApiProblem {
  if (status === 401) return 'bad-key';
  if (status === 403) return 'not-allowed';
  if (status === 429 || status === 529) return 'busy'; // 529: Anthropic is overloaded, which the owner meets as "busy" too
  return 'server';
}

/** One call to Anthropic with this key. Answers the response, or the problem. Never throws, never logs, never keeps the key. */
async function call(path: string, key: string, init: { method?: 'GET' | 'POST'; body?: unknown } = {}): Promise<Response | ApiProblem> {
  const headers: Record<string, string> = {
    'x-api-key': key,
    'anthropic-version': API_VERSION,
    // The extension page calls Anthropic directly (spec: "Calls go straight from the viewer tab to Anthropic"), as the SDK's
    // dangerouslyAllowBrowser does.
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  try {
    return await fetch(`${API_ORIGIN}${path}`, {
      method: init.method ?? 'GET',
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // offline, a refused connection, or the timeout: the error says nothing more that the owner can use
    return 'network';
  }
}

/**
 * Checks a key: lists the models it may use (GET /v1/models). This is the "Check and save" call. Answers the raw model
 * objects, newest first as Anthropic lists them (model-discovery.ts reads them), or why the key could not be checked.
 */
export async function listModels(key: string): Promise<Answer<unknown[]>> {
  const out: unknown[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const query = `limit=${MODELS_PER_PAGE}${after === null ? '' : `&after_id=${encodeURIComponent(after)}`}`;
    const res = await call(`/v1/models?${query}`, key);
    if (typeof res === 'string') return { ok: false, problem: res };
    if (!res.ok) return { ok: false, problem: problemOf(res.status) };
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { ok: false, problem: 'server' };
    }
    const b = (body ?? {}) as { data?: unknown; has_more?: unknown; last_id?: unknown };
    if (!Array.isArray(b.data)) return { ok: false, problem: 'server' };
    out.push(...(b.data as unknown[]));
    if (b.has_more !== true || typeof b.last_id !== 'string') break;
    after = b.last_id;
  }
  return { ok: true, value: out };
}

/**
 * Free token counting (POST /v1/messages/count_tokens), for the web search probe. Answers whether Anthropic accepted the
 * request (true), refused it as a bad request (false: here, a tool type this model does not take), or another problem.
 */
export async function countTokensAccepts(key: string, body: unknown): Promise<Answer<boolean>> {
  const res = await call('/v1/messages/count_tokens', key, { method: 'POST', body });
  if (typeof res === 'string') return { ok: false, problem: res };
  // the body is not needed; it is read so the connection is freed
  await res.arrayBuffer().catch(() => null);
  if (res.ok) return { ok: true, value: true };
  if (res.status === 400) return { ok: true, value: false };
  return { ok: false, problem: problemOf(res.status) };
}

// ---- What the owner pastes ----

/** The pasted text as a key: spaces, line breaks and quotes around it removed (copying from a page or a file can add them). */
export function cleanKey(pasted: string): string {
  return pasted.replace(/\s+/g, '').replace(/^["'`“‘]+|["'`”’]+$/g, '');
}

/** The shortest a key can be. Anthropic's keys are much longer; this only catches a half-copied one. */
const MIN_KEY_LENGTH = 20;

/** Plain words when the text cannot be a key (checked before anything is sent), or null. */
export function keyShapeProblem(clean: string): string | null {
  if (clean === '') return 'Paste your key first.';
  if (!/^[A-Za-z0-9_-]+$/.test(clean)) return 'That doesn’t look like a Claude key. A key has only letters, numbers and dashes. Copy it again from the Anthropic Console.';
  if (clean.length < MIN_KEY_LENGTH) return 'That looks too short to be a whole key. Copy all of it again from the Anthropic Console.';
  return null;
}

// ---- The local-only store ----

let opened: Promise<LocalOnlyStore> | null = null;

/** Whether the local-only database exists. Reading must not create it (nothing was ever kept then). */
export async function localStoreExists(): Promise<boolean> {
  if (chrome.extension.inIncognitoContext) return false;
  try {
    return (await indexedDB.databases()).some((db) => db.name === LOCAL_ONLY_DB);
  } catch {
    return true; // cannot tell: open it (a new one holds nothing)
  }
}

async function store(): Promise<LocalOnlyStore> {
  opened ??= openLocalOnlyStore();
  try {
    return await opened;
  } catch (e) {
    opened = null;
    throw e;
  }
}

/** The stored key, for a call the owner asked for. Null when there is none. Never keep what it answers. */
export async function readSavedKey(): Promise<string | null> {
  if (!(await localStoreExists())) return null;
  return (await store()).getSecret('anthropic_api_key');
}

/** The last 4 characters of the stored key, for "Key saved ····abcd"; null when no key is saved. */
export async function savedKeyEnding(): Promise<string | null> {
  const key = await readSavedKey();
  return key === null || key === '' ? null : key.slice(-4);
}

/** Keeps a checked key in the local-only store (creating the database the first time). */
export async function saveKey(key: string): Promise<void> {
  await (await store()).setSecret('anthropic_api_key', key);
}

/** Removes the key from this computer. */
export async function deleteKey(): Promise<void> {
  if (!(await localStoreExists())) return;
  await (await store()).deleteSecret('anthropic_api_key');
}

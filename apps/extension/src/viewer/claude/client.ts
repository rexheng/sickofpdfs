// The one door to Anthropic (plan §3): the only file that imports the SDK (an ESLint rule enforces it) and the only viewer file
// that reads the key.
//
// How the key is kept safe here:
// - It is read from the local-only store (`getSecret('anthropic_api_key')`, Task 29) on every call, never cached, and handed to
//   a fresh SDK client that lives for that one call. Deleting the key in Settings takes effect on the next question.
// - It goes only in the `x-api-key` header the SDK sends to api.anthropic.com. It is never put in a request body, a log, an
//   error, a message to another context or a store row.
// - Every error that leaves this file is a `ClaudeCallError`: the HTTP status, the API's error type and a scrubbed detail. The
//   SDK's own error (which can quote the request) never escapes.
// - Reading never creates the local-only database: with no database there is no key ("no-key"), and nothing is made.
//
// The calls go straight from the viewer tab (an extension page) to Anthropic, with the SDK's direct-browser mode, because the
// service worker would cut long streams (contracts §6). The SDK looks `fetch` up at call time, so a test build's base-URL
// hook (src/testing/claude-base-url.ts, test builds only) can send the calls to the recorded-response double instead.
import Anthropic from '@anthropic-ai/sdk';
import type { MessagesParams } from '@sop/core';
import { LOCAL_ONLY_DB, openLocalOnlyStore } from '../../local-only/secrets-store';
import { ClaudeCallError, scrubKeyLike } from './errors';

/** One streamed Messages request: the raw stream events as the API sends them, then the whole message. */
export interface ClaudeCall extends AsyncIterable<unknown> {
  /** The final message (the SDK puts the stream together). Rejects with a ClaudeCallError like the stream does. */
  final(): Promise<unknown>;
}

export interface ClaudeClient {
  /** Starts one streamed request. Aborting `signal` ends it with a ClaudeCallError of kind 'abort'. */
  stream(params: MessagesParams, o: { signal: AbortSignal }): ClaudeCall;
}

/** The SDK's retry policy (408, 409, 429, 5xx and dropped connections), before a stream starts. Plan §4 D: twice. */
const MAX_RETRIES = 2;
/** A request that has not answered by then has failed. Streams of a long Think harder answer stay well inside it. */
const TIMEOUT_MS = 10 * 60_000;

/** Whether the local-only database exists, without creating it (as Settings checks). */
async function localStoreExists(): Promise<boolean> {
  if (typeof chrome !== 'undefined' && chrome.extension?.inIncognitoContext) return false;
  try {
    return (await indexedDB.databases()).some((db) => db.name === LOCAL_ONLY_DB);
  } catch {
    return true; // cannot tell: opening it is harmless (a new one holds nothing)
  }
}

/** The stored key, or null. Read fresh for every call and never kept. */
export async function readKey(): Promise<string | null> {
  if (!(await localStoreExists())) return null;
  try {
    const key = await (await openLocalOnlyStore()).getSecret('anthropic_api_key');
    return key === null || key.trim() === '' ? null : key;
  } catch {
    return null;
  }
}

/** Whether a key is saved, for the entry's status. Reads the key and drops it at once. */
export async function hasKey(): Promise<boolean> {
  return (await readKey()) !== null;
}

/** Turns anything the SDK throws into a ClaudeCallError that carries no API text and no key. */
function callError(e: unknown, key: string, signal: AbortSignal): ClaudeCallError {
  if (e instanceof ClaudeCallError) return e;
  const detail = scrubKeyLike(e instanceof Error ? `${e.name}: ${e.message}` : String(e), key).slice(0, 300);
  if (signal.aborted || e instanceof Anthropic.APIUserAbortError) return new ClaudeCallError({ kind: 'abort', status: null, type: null, detail });
  if (e instanceof Anthropic.APIConnectionError) return new ClaudeCallError({ kind: 'connection', status: null, type: null, detail });
  if (e instanceof Anthropic.APIError) {
    const type = typeof e.type === 'string' ? e.type : null;
    return new ClaudeCallError({ kind: 'api', status: typeof e.status === 'number' ? e.status : null, type, detail });
  }
  // A stream that stopped without an error the SDK could name (the connection dropped part-way, for example).
  return new ClaudeCallError({ kind: 'connection', status: null, type: null, detail });
}

/**
 * A client for one question, or `{ error: 'no-key' }` when no key is saved. Call it for each request: it reads the key every
 * time, so the key lives in memory only while a request runs.
 */
export async function createClaudeClient(): Promise<ClaudeClient | { error: 'no-key' }> {
  const key = await readKey();
  if (key === null) return { error: 'no-key' };
  return {
    stream(params, { signal }) {
      const sdk = new Anthropic({
        apiKey: key,
        dangerouslyAllowBrowser: true,
        maxRetries: MAX_RETRIES,
        timeout: TIMEOUT_MS,
        // The key goes in `x-api-key`, the header Settings' key check uses too (key-check.ts). SDK 1.3.0 would send it as a Bearer
        // token; the null takes that header out, so the key is sent once, in one known place.
        defaultHeaders: { 'x-api-key': key, Authorization: null },
        // Looked up at call time (a test build wraps fetch to reach the recorded-response double).
        fetch: (input: string | URL | Request, init?: RequestInit) => globalThis.fetch(input, { ...init, credentials: 'omit', referrerPolicy: 'no-referrer' }),
      });
      const { betas, ...body } = params;
      // The request builder (core) makes exactly the wire body; the SDK's own types lag the API's newest fields, so it is passed through.
      const s = betas
        ? sdk.beta.messages.stream({ ...body, betas } as unknown as Parameters<typeof sdk.beta.messages.stream>[0], { signal })
        : sdk.messages.stream(body as unknown as Parameters<typeof sdk.messages.stream>[0], { signal });
      return {
        async *[Symbol.asyncIterator]() {
          try {
            for await (const event of s as AsyncIterable<unknown>) yield event;
          } catch (e) {
            throw callError(e, key, signal);
          }
        },
        async final() {
          try {
            return (await s.finalMessage());
          } catch (e) {
            throw callError(e, key, signal);
          }
        },
      };
    },
  };
}

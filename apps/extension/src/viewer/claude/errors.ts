// What went wrong with a Claude call, in the owner's plain words (contract §3 `ReplyError`), and the scrubbing that keeps the
// key out of every error that leaves the client.
//
// Rules:
// - The API's own error text is never shown or stored. The owner sees one of the fixed sentences in `REPLY_ERROR_MESSAGES`.
// - Anything that could carry text from a request (an exception message, a URL) is scrubbed of key-shaped text before it goes
//   anywhere, even to the console. This file never logs.
import { REPLY_ERROR_MESSAGES, replyError, replyErrorFromApi, type ReplyError } from '@sop/core';

/** Anything shaped like an Anthropic key. Joined at run time so no key-shaped text sits in the source. */
const KEY_SHAPE = new RegExp(`${['sk', 'ant'].join('-')}-[A-Za-z0-9_-]{4,}`, 'g');

/** `text` with the key (when given) and anything key-shaped replaced by "[key]". */
export function scrubKeyLike(text: string, key?: string | null): string {
  let out = text.replace(KEY_SHAPE, '[key]');
  if (key && key.length >= 8) out = out.split(key).join('[key]');
  return out;
}

/** How a call failed, as the client reports it: no message from the API, no key, only what decides the owner's words. */
export interface ClaudeCallFailure {
  kind: 'abort' | 'connection' | 'api';
  /** HTTP status, when the API answered. */
  status: number | null;
  /** The API's error type (`authentication_error`, `rate_limit_error`, `overloaded_error`, ...), when it gave one. */
  type: string | null;
  /** For a developer, scrubbed of key-shaped text. Never shown to the owner. */
  detail: string;
}

export class ClaudeCallError extends Error implements ClaudeCallFailure {
  readonly kind: ClaudeCallFailure['kind'];
  readonly status: number | null;
  readonly type: string | null;
  readonly detail: string;
  constructor(f: ClaudeCallFailure) {
    super(`claude call failed: ${f.kind}${f.status !== null ? ` ${f.status}` : ''}${f.type ? ` ${f.type}` : ''}`);
    this.name = 'ClaudeCallError';
    this.kind = f.kind;
    this.status = f.status;
    this.type = f.type;
    this.detail = f.detail;
  }
}

/** "Your chosen model is no longer available. Pick one in Settings." (plan §3) */
export const MODEL_GONE_MESSAGE = 'Your chosen model is no longer available. Pick one in Settings.';
/** A request the API would not take (a bad request): plain words, no API text. */
export const BAD_REQUEST_MESSAGE = 'Claude could not take this question. Press Try again, or ask in fewer words.';

/** The owner's words for a failed call. `cancelled` when the owner pressed Stop (or the tab is going). */
export function replyErrorOf(e: unknown, o: { stopped?: boolean } = {}): ReplyError {
  if (o.stopped) return replyError('cancelled');
  if (e instanceof ClaudeCallError) {
    if (e.kind === 'abort') return replyError('cancelled');
    if (e.kind === 'connection') return replyError('network');
    if (e.status === 404 || e.type === 'not_found_error') return { code: 'server', message: MODEL_GONE_MESSAGE };
    if (e.status === 400 || e.type === 'invalid_request_error') return { code: 'server', message: BAD_REQUEST_MESSAGE };
    return replyErrorFromApi(e.type, e.status);
  }
  return replyError('server');
}

/** The plain words of a code, for places that only know the code. */
export const messageOf = (code: ReplyError['code']): string => REPLY_ERROR_MESSAGES[code];

// ---- Privacy refusals: said in the viewer's note bar, never stored, nothing sent ----

export type PrivateReason = 'unsaved' | 'no-text' | 'not-learning' | 'incognito';

/** Why Claude will not read this PDF, in short plain sentences (CLAUDE.md: private documents are never touched). */
export const PRIVATE_MESSAGES: Readonly<Record<PrivateReason, string>> = {
  'unsaved': 'Claude only reads PDFs in your library. This one isn’t saved, so nothing was sent.',
  'no-text': 'Claude doesn’t read this PDF. It looks private (it has card, bank or ID numbers), so nothing was sent.',
  'not-learning': 'Claude doesn’t read this PDF. It looked private when you opened it, so nothing was sent.',
  'incognito': 'Claude doesn’t work in Incognito windows. Nothing was sent.',
};

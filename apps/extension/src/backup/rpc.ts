// How an extension page asks the backup writer (in the offscreen document) to do something, and hears the answer.
//
// A BroadcastChannel is shared by every page of this extension and by nothing else: a web page or a content script runs in another
// origin and cannot reach it. A request carries a random id; the writer answers on the same channel with that id. A page that
// hears no answer in time says "busy" and goes on; the request itself is never lost where it matters (a forgotten reading's
// request is also kept in `sop-handles` until it is done).
import type { BackupCounts } from '@sop/core';

export const RPC_CHANNEL = 'sop-backup-rpc';
/** The writer posts here whenever the status record changes; pages read the record again. */
export const STATUS_CHANNEL = 'sop-backup-status';

export type RpcRequest =
  /** Back up now. `force` is "Back up anyway". `now` is honoured in test builds only. */
  | { type: 'run'; id: string; force?: boolean; now?: number }
  /** A folder was chosen, or cleared: look at it again. With a folder, the first backup starts at once. */
  | { type: 'configure'; id: string; now?: number }
  /** A reading was forgotten: remove it from every backup file (ruling R75). */
  | { type: 'scrub'; id: string; documentId: string }
  /** Finish the removals waiting for the chosen folder and for folders the owner moved away from, now ("Change folder", "Turn off", "Try now"). */
  | { type: 'drain'; id: string };

export type RunSummary =
  | { ok: true; bytes: number; counts: BackupCounts; wrote: { pdfs: number; notes: number }; missingPdfs: number; damagedPdfs: number; at: number }
  | { ok: false; reason: 'no-folder' | 'permission' | 'held' | 'failed' | 'busy'; message: string; /** Test builds only: what went wrong, for a test to read. */ detail?: string };

export type ScrubSummary =
  | { status: 'removed' | 'no-backup' }
  /** `gone`: the folder no longer exists, so the removal was dropped (R88). */
  | { status: 'pending'; reason: 'permission' | 'failed' | 'busy' | 'unreadable' | 'gone'; message: string };

export interface RpcReply {
  type: 'reply';
  id: string;
  result: RunSummary | ScrubSummary;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A request that is well formed; null for anything else on the channel. */
export function asRequest(x: unknown): RpcRequest | null {
  if (!isRecord(x) || typeof x.id !== 'string' || x.id === '' || x.id.length > 64) return null;
  switch (x.type) {
    case 'run':
      return { type: 'run', id: x.id, ...(x.force === true ? { force: true } : {}), ...(typeof x.now === 'number' && Number.isFinite(x.now) ? { now: x.now } : {}) };
    case 'configure':
      return { type: 'configure', id: x.id, ...(typeof x.now === 'number' && Number.isFinite(x.now) ? { now: x.now } : {}) };
    case 'scrub':
      return typeof x.documentId === 'string' && /^[0-9a-f]{64}$/.test(x.documentId) ? { type: 'scrub', id: x.id, documentId: x.documentId } : null;
    case 'drain':
      return { type: 'drain', id: x.id };
    default:
      return null;
  }
}

export function asReply(x: unknown): RpcReply | null {
  return isRecord(x) && x.type === 'reply' && typeof x.id === 'string' && isRecord(x.result) ? (x as unknown as RpcReply) : null;
}

/** Sends `request` and waits for its answer, or for `timeoutMs`. Resolves to null when nobody answered. */
export function ask<R extends RunSummary | ScrubSummary>(request: RpcRequest, timeoutMs: number): Promise<R | null> {
  return new Promise<R | null>((resolve) => {
    const channel = new BroadcastChannel(RPC_CHANNEL);
    const done = (value: R | null): void => {
      clearTimeout(timer);
      channel.close();
      resolve(value);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    channel.onmessage = (e: MessageEvent) => {
      const reply = asReply(e.data);
      if (reply !== null && reply.id === request.id) done(reply.result as R);
    };
    channel.postMessage(request);
  });
}

export const newRequestId = (): string => crypto.randomUUID();

// How viewer tabs reach the background OCR of saved readings (the offscreen page's OCR worker, host.ts and bg-worker.ts), and
// hear how far it is. A BroadcastChannel is shared by every page and worker of this extension and by nothing else (a web page or
// a content script runs in another origin). Messages carry a reading's fingerprint, page numbers and counts only: never text.
// A PDF that is not saved is never named here: its recognition stays inside its own tab.
//
//   tab → OCR   { type: 'ocr:start', documentId, visible, direction }   read this saved reading (pages already read are skipped)
//   tab → OCR   { type: 'ocr:hint', documentId, visible, direction }    these pages are on screen now: read them next
//   tab → OCR   { type: 'ocr:pause' | 'ocr:resume', documentId }
//   any → OCR   { type: 'ocr:ask', documentId }                         say how far you are
//   OCR → all   { type: 'ocr:progress', progress }                      after every page, and in answer to an ask
import type { DocumentId, OcrProgress } from '@sop/core';

export const OCR_CHANNEL = 'sop-ocr';

export interface OcrHint {
  visible: number[];
  direction: 1 | -1;
}

export type OcrMessage =
  | ({ type: 'ocr:start'; documentId: DocumentId } & OcrHint)
  | ({ type: 'ocr:hint'; documentId: DocumentId } & OcrHint)
  | { type: 'ocr:pause' | 'ocr:resume' | 'ocr:ask'; documentId: DocumentId }
  | { type: 'ocr:progress'; progress: OcrProgress };

const SHA = /^[0-9a-f]{64}$/;
const STATES = new Set<OcrProgress['state']>(['idle', 'running', 'paused', 'done', 'error', 'off']);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
/** The most pages one hint names. */
const MAX_VISIBLE = 16;

function hintOf(x: Record<string, unknown>): OcrHint | null {
  if (!Array.isArray(x.visible) || (x.direction !== 1 && x.direction !== -1)) return null;
  return { visible: x.visible.filter(isCount).slice(0, MAX_VISIBLE), direction: x.direction };
}

/** A message that is well formed; null for anything else on the channel. */
export function asOcrMessage(x: unknown): OcrMessage | null {
  if (!isRecord(x)) return null;
  if (x.type === 'ocr:progress') {
    const p = x.progress;
    if (!isRecord(p) || typeof p.documentId !== 'string' || !SHA.test(p.documentId) || !STATES.has(p.state as OcrProgress['state'])) return null;
    if (!isCount(p.total) || !isCount(p.done) || !isCount(p.keptOld) || typeof p.upgrading !== 'boolean') return null;
    const progress: OcrProgress = {
      documentId: p.documentId as DocumentId,
      state: p.state as OcrProgress['state'],
      total: p.total,
      done: p.done,
      error: typeof p.error === 'string' ? p.error.slice(0, 200) : null,
      upgrading: p.upgrading,
      keptOld: p.keptOld,
    };
    return { type: 'ocr:progress', progress };
  }
  if (typeof x.documentId !== 'string' || !SHA.test(x.documentId)) return null;
  const documentId = x.documentId as DocumentId;
  switch (x.type) {
    case 'ocr:start':
    case 'ocr:hint': {
      const h = hintOf(x);
      return h === null ? null : { type: x.type, documentId, ...h };
    }
    case 'ocr:pause':
    case 'ocr:resume':
    case 'ocr:ask':
      return { type: x.type, documentId };
    default:
      return null;
  }
}

/** Sends one message on the channel. */
export function postOcr(message: OcrMessage): void {
  const channel = new BroadcastChannel(OCR_CHANNEL);
  channel.postMessage(message);
  channel.close();
}

/** Calls `cb` with the background OCR's progress for `documentId` whenever it changes, starting with where it is now. */
export function onOcrProgress(documentId: DocumentId, cb: (p: OcrProgress) => void): () => void {
  const channel = new BroadcastChannel(OCR_CHANNEL);
  channel.onmessage = (e: MessageEvent) => {
    const m = asOcrMessage(e.data);
    if (m?.type === 'ocr:progress' && m.progress.documentId === documentId) cb(m.progress);
  };
  channel.postMessage({ type: 'ocr:ask', documentId } satisfies OcrMessage);
  return () => channel.close();
}

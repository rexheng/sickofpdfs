// CL15: "+ New" → Upload PDF on the web. One PDF from this computer or phone goes into the owner's library and cloud.
//
// The same checks as Chrome run first, here in the browser, before anything is sent:
//   1. it is a PDF, and its SHA-256 (the reading's id) is read as the file is read;
//   2. a reading the library holds already is not saved again (only its PDF goes up, if the cloud lacks it);
//   3. the viewer's own save (save-controller.ts), with the learning filter and the owner's synced allow and deny lists: a
//      learning PDF is saved, a receipt, bill or private paper is refused with the filter's reason, and "not sure" asks the
//      owner (there is no MiniLM tie-breaker on the web). The save also reads every page for card, bank or ID numbers (R91).
// Only then: the reading's row goes to the cloud (a sync round), the PDF uploads (one PUT up to 32 MiB, else in 32 MiB parts
// that the server remembers, so a lost connection resumes at the part it stopped in), then its page text.
//
// Nothing about a refused PDF leaves the browser, and nothing is kept on this computer: the PDF is read into memory only.
import type { FilterDecision, Sha256 } from '@sop/core';
import { createTransfers, SyncHttpError } from '@sop/core/sync-client';
import { createEmbedPdfBackend, engineAssets, type LoadedPdf, loadPdfSource, type PdfBackend, PdfPasswordError } from '@sop/viewer';
import { looksLikePdf } from '@ext/library/shell/open-file';
import type { StoreClient } from '@ext/store/client';
import { createViewerFilter } from '@ext/viewer/filter/async-filter';
import { createRulesSource } from '@ext/viewer/filter/rules-source';
import { createSaveController } from '@ext/viewer/save/save-controller';
import type { WebSync } from '../sync/engine';
import { progressFetch } from './progress-fetch';

export type UploadStep =
  | { kind: 'reading' }
  | { kind: 'checking' }
  /** "Not sure": waits for the owner's answer. */
  | { kind: 'asking'; reason: string | null }
  | { kind: 'uploading'; sent: number; total: number }
  /** The connection broke: it goes on from where it stopped when the browser is back online. */
  | { kind: 'waiting'; sent: number; total: number }
  | { kind: 'text' }
  | { kind: 'done'; sha: string; already: boolean; note: string | null }
  /** Refused, with the reason in plain words. Nothing was sent. */
  | { kind: 'refused'; why: string }
  | { kind: 'failed'; why: string };

export interface UploadHooks {
  step(s: UploadStep): void;
  /** "Not sure" (or a reason the filter gave): true saves it as the owner's own choice. */
  ask(reason: string | null): Promise<boolean>;
  store: StoreClient;
  sync: WebSync;
  signal: AbortSignal;
}

let engine: PdfBackend | null = null;
/** The PDF engine, made on first use and kept for later uploads (the same files as the viewer: pdf/ in the build). */
function backend(): PdfBackend {
  engine ??= createEmbedPdfBackend(engineAssets((p) => `${location.origin}/${p}`), { workers: 1, startNow: true });
  return engine;
}

/** The reason a filter decision or the save gave, as a short line, or null. */
const reasonOf = (d: FilterDecision | null, extra: string | null): string | null => extra ?? d?.reasons[0] ?? null;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

/** Resolves when the browser is online again (at once if it is), after at least `ms`. */
async function backOnline(ms: number, signal: AbortSignal): Promise<void> {
  await sleep(ms, signal);
  if (navigator.onLine || signal.aborted) return;
  await new Promise<void>((resolve) => {
    const done = () => (removeEventListener('online', done), resolve());
    addEventListener('online', done);
    signal.addEventListener('abort', done, { once: true });
  });
}

const transient = (e: unknown) => e instanceof SyncHttpError && (e.failure === 'offline' || e.failure === 'busy' || e.failure === 'rate-limited');

export async function uploadPdf(file: File, h: UploadHooks): Promise<UploadStep> {
  const end = (s: UploadStep): UploadStep => {
    h.step(s);
    return s;
  };
  h.step({ kind: 'reading' });
  if (!(await looksLikePdf(file))) return end({ kind: 'refused', why: 'This file isn’t a PDF.' });
  let loaded: LoadedPdf;
  try {
    loaded = await loadPdfSource({ kind: 'file', file }, { signal: h.signal });
  } catch {
    return end({ kind: 'failed', why: 'This file couldn’t be read. Try again.' });
  }
  const sha = loaded.sha256;
  const known = await h.store.resolveFingerprint(sha).catch(() => null);
  if (known !== null && known !== sha) return end({ kind: 'done', sha: known, already: true, note: 'This PDF is already in your library.' });

  if (known === null) {
    h.step({ kind: 'checking' });
    const saved = await saveWithFilter(loaded, h);
    if (saved.kind !== 'saved') return end(saved.step);
    if (saved.documentId !== sha) return end({ kind: 'done', sha: saved.documentId, already: true, note: 'This PDF is already in your library.' });
  }
  if (h.signal.aborted) return end({ kind: 'failed', why: 'Stopped.' });
  return end(await send(sha, loaded.blob, known !== null, h));
}

type Saved = { kind: 'saved'; documentId: string } | { kind: 'stop'; step: UploadStep };

/** The viewer's save, run here: the filter decides, "not sure" asks, and the reading's rows are written to this tab's library. */
async function saveWithFilter(loaded: LoadedPdf, h: UploadHooks): Promise<Saved> {
  const engine = backend();
  let open;
  try {
    open = await engine.open(await loaded.blob.arrayBuffer());
  } catch (e) {
    if (e instanceof PdfPasswordError) return { kind: 'stop', step: { kind: 'refused', why: 'This PDF has a password. Open it in Chrome to add it to your library.' } };
    return { kind: 'stop', step: { kind: 'refused', why: 'This PDF looks damaged, so it can’t be added.' } };
  }
  const store = h.store;
  // The owner's synced allow and deny lists. "Never save this file" is kept only on the computer it was chosen on.
  const rules = createRulesSource({ local: () => Promise.resolve(null), localExists: () => Promise.resolve(false), store: () => Promise.resolve(store) });
  const filter = createViewerFilter({ fingerprint: loaded.sha256, rules, tieBreaker: null });
  const save = createSaveController({
    opened: { loaded, open, password: null },
    backend: engine,
    store,
    blobs: null, // the PDF goes to the cloud below, never to this computer
    filter: (input) => filter.filter(input),
    fileChoice: () => filter.fileChoice(),
    rules,
    incognito: false,
    location: null,
    now: () => Date.now(),
  });
  try {
    await save.start();
    const why = () => reasonOf(save.decision, save.whyNotSaved);
    if (save.state.kind === 'not-learning') return { kind: 'stop', step: { kind: 'refused', why: refusal(why()) } };
    if (save.state.kind !== 'saved') {
      // "Not sure": the owner decides. Their Save is the same as Chrome's "Save to library".
      h.step({ kind: 'asking', reason: why() });
      if (!(await h.ask(why()))) return { kind: 'stop', step: { kind: 'refused', why: 'You chose to leave it out. Nothing was sent.' } };
      h.step({ kind: 'checking' });
      await save.requestSave();
    }
    if (save.state.kind !== 'saved') return { kind: 'stop', step: { kind: 'refused', why: refusal(why()) } };
    return { kind: 'saved', documentId: save.documentId() ?? loaded.sha256 };
  } catch {
    return { kind: 'stop', step: { kind: 'failed', why: 'It couldn’t be saved. Try again.' } };
  } finally {
    save.dispose();
    void engine.close(open.doc).catch(() => {});
  }
}

/** The plain line for a refused PDF. */
function refusal(reason: string | null): string {
  return reason === null ? 'Not added: it doesn’t look like a reading. Nothing was sent.' : `Not added: ${reason}. Nothing was sent.`;
}

/** The reading's row to the cloud, then its PDF (resuming after a broken connection), then its page text. */
async function send(sha: string, blob: Blob, alreadyKnown: boolean, h: UploadHooks): Promise<UploadStep> {
  const total = blob.size;
  let partsDone = 0;
  let inFlight = 0;
  const report = (kind: 'uploading' | 'waiting') => h.step({ kind, sent: Math.min(total, partsDone + inFlight), total });
  const fetchWithProgress = progressFetch((loaded) => {
    inFlight = loaded;
    report('uploading');
  });
  const t = createTransfers({ server: location.origin, token: () => Promise.resolve('cookie-session'), fetch: fetchWithProgress });
  report('uploading');
  let uploaded = false;
  for (let tries = 0; ; tries++) {
    if (h.signal.aborted) return { kind: 'failed', why: 'Stopped.' };
    try {
      // The row first: the cloud takes a PDF only for a reading it holds.
      await h.sync.now();
      if ((await t.headBlob(sha)) === null) {
        await t.putBlob(sha, blob, (sent) => {
          partsDone = sent;
          inFlight = 0;
          report('uploading');
        });
        uploaded = true;
      }
      break;
    } catch (e) {
      inFlight = 0;
      const unknown = e instanceof SyncHttpError && e.code === 'unknown_document';
      if (!transient(e) && !(unknown && tries < 3) && !(!(e instanceof SyncHttpError) && tries < 20)) {
        const why = e instanceof SyncHttpError && e.failure === 'quota' ? 'Your cloud reached its daily limit. Try again tomorrow.' : 'Your cloud refused this PDF. Try again later.';
        return { kind: 'failed', why };
      }
      if (tries > 200) return { kind: 'failed', why: 'Your cloud couldn’t be reached. Try again later.' };
      report('waiting');
      await backOnline(Math.min(30_000, 1000 * 2 ** Math.min(tries, 5)), h.signal);
    }
  }
  await h.store.setSyncState(`needBlob:${sha}`, null).catch(() => {});
  // The page text, so search on the web, on claude.ai and on a new computer finds it. Chrome sends text the same way.
  if (alreadyKnown && !uploaded) return { kind: 'done', sha, already: true, note: 'This PDF is already in your library.' };
  h.step({ kind: 'text' });
  let note: string | null = alreadyKnown ? 'It was in your library already. Its PDF is in your cloud now.' : null;
  try {
    const text = await h.store.textForSync(sha as Sha256);
    if (text !== null) {
      await t.putText(sha, text.extractor, text.pages);
      await h.store.setSyncState(`textSent:${sha}`, text.source);
    }
  } catch (e) {
    if (e instanceof SyncHttpError && e.code === 'text_stays_local') {
      // a PDF whose text stays out of search (card or bank numbers, D9): nothing to send
    } else {
      note = 'Saved. Its words aren’t searchable yet: sending them failed. Your notes are safe.';
    }
  }
  h.sync.kick();
  return { kind: 'done', sha, already: false, note };
}

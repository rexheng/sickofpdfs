// PDFs with fillable fields reopen in Chrome's own viewer, where they can be filled in (Task 31). The spec's order:
// such a PDF is "classified first and saved if they are learning PDFs, then reopen in Chrome's own viewer to be
// filled, through a one-time allow rule for that link and tab". If the link can't be fetched again (a one-time link,
// a file picked from disk), our view stays, with a banner.
//
// "Fillable" is `hasFillableFields`: text boxes, choices and check boxes a person can fill in, or XFA. The link boxes
// LaTeX's hyperref adds to most papers (a bare /AcroForm) do not count.
import { hasFillableFields, type PdfBackend, type SaveController } from '@sop/viewer';
import { sendRuntimeMessage } from '../../shared/send-message';
import type { OpenedDocument } from '../open-document';
import { openInChrome } from '../open-in-chrome';

export type FormBounceAction = 'stay' | 'bounce' | 'stay-with-banner';

/** How long the "Opening it in Chrome's viewer…" notice shows before the tab goes there. */
export const FORM_NOTICE_MS = 1500;
/** The probe reads this much of the PDF: enough for its `%PDF-` header. */
const PROBE_BYTES = 1024;
/** A probe that gets no answer in this time counts as "can't be fetched again". */
const PROBE_TIMEOUT_MS = 5000;
/** How long the viewer waits for the service worker's Referer set-up before it probes anyway. */
const PREPARE_TIMEOUT_MS = 2000;

export function decideFormBounce(i: { fillable: boolean; source: string | null; refetchable: boolean }): FormBounceAction {
  if (!i.fillable) return 'stay';
  return i.source !== null && i.refetchable ? 'bounce' : 'stay-with-banner';
}

const PDF_MAGIC = '%PDF-';

/**
 * Can Chrome's viewer load `source` again? For http(s): a GET of its first 1024 bytes answers 200 or 206 and holds the
 * `%PDF-` header there. For a file: an XHR read succeeds. Anything else (another scheme, an error, no answer) is false.
 */
export async function probeRefetch(source: string): Promise<boolean> {
  if (/^https?:/i.test(source)) return withTimeout(probeWeb(source), PROBE_TIMEOUT_MS);
  if (/^file:/i.test(source)) return withTimeout(probeFile(source), PROBE_TIMEOUT_MS);
  return false;
}

async function probeWeb(url: string): Promise<boolean> {
  const abort = new AbortController();
  try {
    const res = await fetch(url, { headers: { Range: `bytes=0-${PROBE_BYTES - 1}` }, credentials: 'include', cache: 'no-store', signal: abort.signal });
    if (res.status !== 200 && res.status !== 206) return false;
    if (res.body === null) return false;
    // A server that ignores Range sends the whole file: read only the start of it.
    const reader = res.body.getReader();
    let head = '';
    while (head.length < PROBE_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      head += String.fromCharCode(...value.subarray(0, PROBE_BYTES - head.length));
    }
    return head.includes(PDF_MAGIC);
  } catch {
    return false;
  } finally {
    abort.abort(); // drops the rest of the body
  }
}

function probeFile(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    const settle = (ok: boolean) => {
      xhr.onprogress = null;
      xhr.onload = null;
      xhr.onerror = null;
      resolve(ok);
      xhr.abort();
    };
    xhr.open('GET', url);
    xhr.responseType = 'arraybuffer';
    // The first bytes arriving prove it can be read; the rest of the file is not needed.
    xhr.onprogress = (e) => e.loaded > 0 && settle(true);
    xhr.onload = () => settle(xhr.status === 0 || (xhr.status >= 200 && xhr.status < 300));
    xhr.onerror = () => settle(false);
    xhr.send();
  });
}

function withTimeout(p: Promise<boolean>, ms: number): Promise<boolean> {
  return Promise.race([p, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))]);
}

/** takeover:prepare-fetch, so the probe carries the Referer the tab's navigation had (Task 16). Errors mean none. */
async function prepareFetch(url: string): Promise<void> {
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, PREPARE_TIMEOUT_MS));
  await Promise.race([sendRuntimeMessage({ type: 'takeover:prepare-fetch', url }).catch(() => {}), timeout]);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Waits for the save decision (`save.start()`, which runs once). Then, for a form that can be fetched again, `onAction`
 * hears 'bounce' (the notice shows), and after FORM_NOTICE_MS the tab reopens it in Chrome's viewer. One that cannot,
 * or that Chrome refuses: 'stay-with-banner'. Resolves with the action taken.
 */
export async function runFormBounce(ctx: {
  opened: OpenedDocument;
  backend: PdfBackend;
  save: SaveController;
  source: string | null;
  onAction?: (action: FormBounceAction) => void;
}): Promise<FormBounceAction> {
  await ctx.save.start().catch(() => {}); // classified first, and saved if it is a learning PDF
  let fillable: boolean;
  try {
    fillable = hasFillableFields(await ctx.backend.getFormInfo(ctx.opened.open.doc));
  } catch {
    return 'stay'; // the engine could not walk the form: reading it here is still fine
  }
  // A picked file has no address of its own to reopen (its `source` may name a file that could not be read).
  const source = ctx.opened.loaded.sourceUrl === null ? null : ctx.source;
  let refetchable = false;
  if (fillable && source !== null) {
    if (/^https?:/i.test(source)) await prepareFetch(source);
    refetchable = await probeRefetch(source);
  }
  const action = decideFormBounce({ fillable, source, refetchable });
  if (action === 'stay') return action;
  ctx.onAction?.(action);
  if (action === 'stay-with-banner' || source === null) return action;
  await sleep(FORM_NOTICE_MS);
  if (await openInChrome(source)) return 'bounce';
  ctx.onAction?.('stay-with-banner');
  return 'stay-with-banner';
}

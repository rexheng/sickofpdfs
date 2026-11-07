// The message protocol between the page and the engine worker (engine.worker.ts), and the page side of it.
//
//   page → worker  { type: 'init', wasmUrl, fontBaseUrl }      worker → page  { type: 'ready' } | { type: 'init-error', error }
//   page → worker  { id, method, args }                         worker → page  { id, ok: true, value } | { id, ok: false, error }
//                                                               worker → page  { type: 'fatal', reason, message }
//
// `method` is one of ENGINE_METHODS. An ImageBitmap, an ArrayBuffer or a Uint8Array result travels by transfer, not by copy. `fatal` means the
// wasm module can no longer be trusted (a trap, or out of memory); the page then ends the worker.
import { PdfEngineCrashedError, PdfFormatError, PdfPasswordError, type EngineFailure } from '../errors';
import type { EngineAssets } from '../engine-config';
import type { Sha256 } from '@sop/core';
import type {
  FormInfo,
  GlyphOutline,
  GlyphShapeOptions,
  GlyphShapes,
  OutlineItem,
  PageGeometry,
  PageGlyphs,
  PageObjectList,
  PageSize,
  PdfAnnotation,
  PdfAnnotationPlan,
  PdfLink,
  PdfMetadata,
  PdfRect,
  SearchHit,
  StructElement,
  TextRun,
  TextRunList,
  TileRequest,
  WriteAnnotationsOptions,
} from '../types';

/** What openDocument tells the page (OpenResult without the handle, which the page makes). */
export interface OpenedDocument {
  pageCount: number;
  pages: PageSize[];
  metadata: PdfMetadata;
  encrypted: boolean;
}

/** The calls the worker serves; SopPdfiumNative implements them. Every method takes the document's id first. */
export interface EngineApi {
  openDocument(docId: string, bytes: ArrayBuffer, password?: string): OpenedDocument;
  closeDoc(docId: string): void;
  renderBitmap(docId: string, req: TileRequest): Promise<ImageBitmap>;
  getGlyphs(docId: string, pageIndex: number): PageGlyphs;
  getPageText(docId: string, pageIndex: number): string;
  getPageChars(docId: string, pageIndex: number): string;
  getPageCopyText(docId: string, pageIndex: number): { text: string; charCount: number };
  getTextRange(docId: string, pageIndex: number, start: number, count: number): string;
  getTextRangeRects(docId: string, pageIndex: number, start: number, count: number): PdfRect[];
  searchPage(docId: string, pageIndex: number, query: string, opts: { matchCase: boolean; wholeWord: boolean }): SearchHit[];
  getLinks(docId: string, pageIndex: number): PdfLink[];
  getOutline(docId: string): OutlineItem[];
  getFormInfo(docId: string): FormInfo;
  listPageObjects(docId: string, pageIndex: number, opts?: { recurseForms?: boolean; maxObjects?: number; budgetMs?: number }): PageObjectList;
  getStructTree(docId: string, pageIndex: number): StructElement[];
  /** With opts.budgetMs, the budgeted form (TextRunList); without, every run. */
  getTextRuns(docId: string, pageIndex: number, opts?: { budgetMs?: number }): TextRun[] | TextRunList;
  getGlyphOutlines(docId: string, pageIndex: number, charStart: number, charCount: number): GlyphOutline[];
  getGlyphShapes(docId: string, pageIndex: number, charStart: number, charCount: number, opts?: GlyphShapeOptions): GlyphShapes;
  hashImageObject(docId: string, pageIndex: number, objectIndex: number): Promise<Sha256 | null>;
  // Phase 8 (slice 8.2). PdfiumNative has its own getPageGeometry, getSignatures and saveAsCopy, hence these names.
  getPageBoxes(docId: string, pageIndex: number): PageGeometry;
  readAnnots(docId: string, pageIndex: number): PdfAnnotation[];
  getSignatureCount(docId: string): number;
  hideAnnots(docId: string, items: { pageIndex: number; objectNumber: number }[], hidden: boolean): void;
  /** Not on an open document: the first argument is only a label. The source Blob is cloned (by reference), the result transferred. */
  writeAnnotsCopy(job: string, source: Blob | ArrayBuffer, plan: PdfAnnotationPlan[], opts: WriteAnnotationsOptions): Promise<Uint8Array>;
}
export type EngineMethod = keyof EngineApi;

/** The only methods the worker will call (it never calls other PdfiumNative methods by name). */
export const ENGINE_METHODS: readonly EngineMethod[] = [
  'openDocument',
  'closeDoc',
  'renderBitmap',
  'getGlyphs',
  'getPageText',
  'getPageChars',
  'getPageCopyText',
  'getTextRange',
  'getTextRangeRects',
  'searchPage',
  'getLinks',
  'getOutline',
  'getFormInfo',
  'listPageObjects',
  'getStructTree',
  'getTextRuns',
  'getGlyphOutlines',
  'getGlyphShapes',
  'hashImageObject',
  'getPageBoxes',
  'readAnnots',
  'getSignatureCount',
  'hideAnnots',
  'writeAnnotsCopy',
];

export interface InitMessage {
  type: 'init';
  wasmUrl: string;
  fontBaseUrl: string;
}
export interface CallMessage {
  id: number;
  method: EngineMethod;
  args: unknown[];
}
export interface WireError {
  name: string;
  message: string;
  wrongPassword?: boolean;
}
export type WorkerMessage =
  | { type: 'ready' }
  | { type: 'init-error'; error: WireError }
  | { type: 'fatal'; reason: EngineFailure; message: string }
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: WireError };

export function toWireError(err: unknown): WireError {
  if (err instanceof PdfPasswordError) return { name: err.name, message: err.message, wrongPassword: err.wrongPassword };
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: 'Error', message: String(err) };
}

export function fromWireError(w: WireError): Error {
  if (w.name === 'PdfPasswordError') return new PdfPasswordError(w.wrongPassword === true, w.message);
  if (w.name === 'PdfFormatError') return new PdfFormatError(w.message);
  if (w.name === 'RangeError') return new RangeError(w.message);
  if (w.name === 'TypeError') return new TypeError(w.message);
  const err = new Error(w.message);
  if (w.name !== 'Error') err.name = w.name;
  return err;
}

export const abortError = () => new DOMException('The call was aborted.', 'AbortError');

interface Call {
  id: number;
  method: EngineMethod;
  args: unknown[];
  transfer: Transferable[];
  resolve(value: unknown): void;
  reject(err: unknown): void;
  /** Rejected already (aborted): its reply, if one comes, is dropped. */
  settled: boolean;
  dispose(): void;
}

export interface EngineWorkerOptions {
  /** Time allowed from creating the worker to PDFium being ready. */
  startTimeoutMs: number;
  /** Watchdog: a call that gets no answer in this time means the worker hangs. */
  hangTimeoutMs: number;
}

/**
 * The page side of one engine worker. Calls go to the worker one at a time, in order; the rest wait in a queue here, so
 * an aborted call that has not started never reaches PDFium.
 *
 * The worker is declared dead, and ended, when it reports an uncaught error, a reply cannot be read, it reports a fatal
 * wasm failure, or the call in progress gets no answer within hangTimeoutMs (the watchdog). Then the call in progress
 * and every queued call reject with one PdfEngineCrashedError, later calls reject with it at once, and the death
 * listeners run.
 */
export class EngineWorker {
  private readonly queue: Call[] = [];
  private current: Call | null = null;
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  private failureError: PdfEngineCrashedError | null = null;
  private readonly deathListeners: ((err: PdfEngineCrashedError) => void)[] = [];
  private nextId = 1;

  private constructor(
    private readonly worker: Worker,
    private readonly opts: EngineWorkerOptions,
  ) {
    worker.addEventListener('message', (e: MessageEvent<WorkerMessage>) => this.onMessage(e.data));
    worker.addEventListener('error', (e) => {
      e.preventDefault();
      this.die('crashed', e.message || 'an uncaught error in the worker');
    });
    worker.addEventListener('messageerror', () => this.die('crashed', 'a reply could not be read'));
  }

  /** Starts PDFium in `worker` and resolves once it is ready. Rejects with PdfEngineCrashedError if it cannot start. */
  static start(worker: Worker, assets: EngineAssets, opts: EngineWorkerOptions): Promise<EngineWorker> {
    return new Promise((resolve, reject) => {
      const fail = (reason: EngineFailure, detail: string) => {
        clearTimeout(timer);
        worker.removeEventListener('message', onInit);
        worker.removeEventListener('error', onLoadError);
        worker.terminate();
        reject(new PdfEngineCrashedError(reason, `the engine did not start: ${detail}`));
      };
      const timer = setTimeout(() => fail('hung', `no answer in ${opts.startTimeoutMs} ms`), opts.startTimeoutMs);
      const onLoadError = (e: ErrorEvent) => {
        e.preventDefault();
        fail('crashed', e.message || 'the worker failed to load');
      };
      const onInit = ({ data }: MessageEvent<WorkerMessage>) => {
        if ('type' in data && data.type === 'init-error') fail('crashed', data.error.message);
        if (!('type' in data) || data.type !== 'ready') return;
        clearTimeout(timer);
        worker.removeEventListener('message', onInit);
        worker.removeEventListener('error', onLoadError);
        resolve(new EngineWorker(worker, opts));
      };
      worker.addEventListener('message', onInit);
      worker.addEventListener('error', onLoadError);
      worker.postMessage({ type: 'init', wasmUrl: assets.wasmUrl, fontBaseUrl: assets.fontBaseUrl } satisfies InitMessage);
    });
  }

  /** Why the worker died; null while it is alive. */
  get failure(): PdfEngineCrashedError | null {
    return this.failureError;
  }

  onDeath(listener: (err: PdfEngineCrashedError) => void): void {
    this.deathListeners.push(listener);
  }

  call<M extends EngineMethod>(
    method: M,
    args: Parameters<EngineApi[M]>,
    opts: { transfer?: Transferable[]; signal?: AbortSignal } = {},
  ): Promise<Awaited<ReturnType<EngineApi[M]>>> {
    if (this.failureError) return Promise.reject(this.failureError);
    const { signal } = opts;
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        if (call.settled) return;
        call.settled = true;
        call.dispose();
        const queued = this.queue.indexOf(call);
        if (queued >= 0) this.queue.splice(queued, 1);
        reject(abortError());
      };
      const call: Call = {
        id: this.nextId++,
        method,
        args,
        transfer: opts.transfer ?? [],
        resolve,
        reject,
        settled: false,
        dispose: () => signal?.removeEventListener('abort', onAbort),
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(call);
      this.pump();
    });
  }

  private pump(): void {
    if (this.failureError || this.current) return;
    const call = this.queue.shift();
    if (!call) return;
    this.current = call;
    this.watchdog = setTimeout(() => this.die('hung', `no answer to ${call.method} in ${this.opts.hangTimeoutMs} ms`), this.opts.hangTimeoutMs);
    try {
      this.worker.postMessage({ id: call.id, method: call.method, args: call.args } satisfies CallMessage, call.transfer);
    } catch (err) {
      // The arguments could not be cloned: the worker never saw the call.
      clearTimeout(this.watchdog);
      this.current = null;
      if (!call.settled) {
        call.settled = true;
        call.dispose();
        call.reject(err);
      }
      this.pump();
    }
  }

  private onMessage(data: WorkerMessage): void {
    if ('type' in data) {
      if (data.type === 'fatal') this.die(data.reason, data.message);
      return;
    }
    const call = this.current;
    if (!call || call.id !== data.id) {
      if (data.ok && data.value instanceof ImageBitmap) data.value.close();
      return;
    }
    clearTimeout(this.watchdog);
    this.current = null;
    if (call.settled) {
      // Aborted while PDFium worked on it: drop the result.
      if (data.ok && data.value instanceof ImageBitmap) data.value.close();
    } else {
      call.settled = true;
      call.dispose();
      if (data.ok) call.resolve(data.value);
      else call.reject(fromWireError(data.error));
    }
    this.pump();
  }

  private die(reason: EngineFailure, detail: string): void {
    if (this.failureError) return;
    const err = new PdfEngineCrashedError(reason, detail);
    this.failureError = err;
    clearTimeout(this.watchdog);
    this.worker.terminate();
    const waiting = [...(this.current ? [this.current] : []), ...this.queue];
    this.current = null;
    this.queue.length = 0;
    for (const call of waiting) {
      if (call.settled) continue;
      call.settled = true;
      call.dispose();
      call.reject(err);
    }
    for (const listener of this.deathListeners) listener(err);
  }
}

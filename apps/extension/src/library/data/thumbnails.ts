// First-page thumbnails for the grid: drawn once from the saved copy of a library PDF, then kept as small WebP files in
// the extension's private file storage (OPFS `thumbs/<documentId>.webp`).
//
// Privacy: a thumbnail is made only for a document the library lists, and only from its saved copy (the blob store),
// so an unsaved PDF never gets one. When a document is forgotten its thumbnail goes too: at once when this page hears
// of it, and otherwise on the next start, which removes every thumbnail whose document is gone.
import type { DocumentId } from '@sop/core';
import { createEmbedPdfBackend, ENGINE_WORKERS, engineAssets, type PdfBackend } from '@sop/viewer';

/** The folder at the root of OPFS. The blob store has `pdf/` and `tmp/`; this is its own. */
const DIR = 'thumbs';
/** Drawn this many device px wide: sharp in a stretched grid card at 2× and still small (about 20–60 KB). */
const WIDTH_PX = 480;
/** Larger copies are not opened just for a picture; their card keeps the PDF tile. */
const MAX_BYTES = 256 * 1024 * 1024;
const QUALITY = 0.82;

export interface ThumbnailCache {
  /** An object URL for the first page of `id`, drawn and kept first if need be; null when it cannot be drawn. */
  get(id: DocumentId): Promise<string | null>;
  /** Removes the thumbnails of these documents (they were forgotten). */
  forget(ids: readonly DocumentId[]): Promise<void>;
  /** Removes every kept thumbnail whose document the library no longer holds. */
  sweep(): Promise<void>;
}

export interface ThumbnailDeps {
  savedPdf(id: DocumentId): Promise<Blob | null>;
  hasDocument(id: DocumentId): Promise<boolean>;
  /** The engine, made on first use. Default: one engine worker of this page's own. */
  backend?: () => PdfBackend;
}

const ID = /^[0-9a-f]{64}$/;
const fileName = (id: DocumentId) => `${id}.webp`;

async function folder(create: boolean): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(DIR, { create });
  } catch {
    return null;
  }
}

export function createThumbnailCache(deps: ThumbnailDeps): ThumbnailCache {
  let engine: PdfBackend | null = null;
  const backend = () => {
    engine ??= deps.backend?.() ?? createEmbedPdfBackend(engineAssets((p) => chrome.runtime.getURL(p)), { workers: ENGINE_WORKERS });
    return engine;
  };
  const urls = new Map<DocumentId, string>();
  const pending = new Map<DocumentId, Promise<string | null>>();
  /** Drawing failed (no copy, a password, a damaged file): not tried again while this page is open. */
  const failed = new Set<DocumentId>();
  // One drawing at a time: the cards ask in the order they come into view.
  let queue: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };

  const kept = async (id: DocumentId): Promise<File | null> => {
    const dir = await folder(false);
    if (dir === null) return null;
    try {
      return await (await dir.getFileHandle(fileName(id))).getFile();
    } catch {
      return null;
    }
  };

  const draw = async (id: DocumentId): Promise<Blob | null> => {
    const pdf = await deps.savedPdf(id);
    if (pdf === null || pdf.size > MAX_BYTES) return null;
    const engine = backend();
    const opened = await engine.open(await pdf.arrayBuffer());
    try {
      const page = opened.pages[0];
      if (page === undefined) return null;
      const sideways = page.rotation === 90 || page.rotation === 270;
      const width = sideways ? page.height : page.width;
      const bitmap = await engine.renderTile(opened.doc, { pageIndex: 0, scale: WIDTH_PX / width, viewRotation: 0, withAnnotations: true });
      try {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
        return await canvas.convertToBlob({ type: 'image/webp', quality: QUALITY });
      } finally {
        bitmap.close();
      }
    } finally {
      void engine.close(opened.doc).catch(() => {});
    }
  };

  const keep = async (id: DocumentId, image: Blob): Promise<void> => {
    const dir = await folder(true);
    if (dir === null) return;
    const writable = await (await dir.getFileHandle(fileName(id), { create: true })).createWritable();
    await writable.write(image);
    await writable.close();
  };

  const load = async (id: DocumentId): Promise<string | null> => {
    const file = await kept(id);
    if (file !== null) return URL.createObjectURL(file);
    const image = await inTurn(() => draw(id));
    if (image === null) return null;
    // The document may have been forgotten while it was drawn: then nothing is kept.
    if (!(await deps.hasDocument(id))) return null;
    await keep(id, image).catch(() => {});
    return URL.createObjectURL(image);
  };

  return {
    get(id) {
      const ready = urls.get(id);
      if (ready !== undefined) return Promise.resolve(ready);
      if (failed.has(id) || !ID.test(id)) return Promise.resolve(null);
      let job = pending.get(id);
      if (job === undefined) {
        job = load(id)
          .catch(() => null)
          .then((url) => {
            pending.delete(id);
            if (url === null) failed.add(id);
            else urls.set(id, url);
            return url;
          });
        pending.set(id, job);
      }
      return job;
    },
    async forget(ids) {
      const dir = await folder(false);
      for (const id of ids) {
        const url = urls.get(id);
        if (url !== undefined) URL.revokeObjectURL(url);
        urls.delete(id);
        failed.delete(id);
        await dir?.removeEntry(fileName(id)).catch(() => {});
      }
    },
    async sweep() {
      const dir = await folder(false);
      if (dir === null) return;
      const names: string[] = [];
      for await (const name of dir.keys()) names.push(name);
      const gone: DocumentId[] = [];
      for (const name of names) {
        const id = name.replace(/\.webp$/, '') as DocumentId;
        if (!ID.test(id) || name !== fileName(id)) await dir.removeEntry(name).catch(() => {}); // not ours: never kept
        else if (!(await deps.hasDocument(id))) gone.push(id);
      }
      await this.forget(gone);
    },
  };
}

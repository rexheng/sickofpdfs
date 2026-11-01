// Where the library keeps its first-page thumbnails: OPFS `thumbs/<documentId>.webp` (library/data/thumbnails.ts draws
// them). They are a copy of a page, so when a document is forgotten or purged its thumbnail must go too (R13, ruling
// R76). The store worker removes it; the library tab also removes it when it hears of the delete, and sweeps on start.

/** The folder at the root of OPFS. The blob store has `pdf/` and `tmp/`; the thumbnails have their own. */
export const THUMBS_DIR = 'thumbs';

const ID = /^[0-9a-f]{64}$/;

export const thumbnailFileName = (documentId: string): string => `${documentId}.webp`;

/** Removes a document's thumbnail, if there is one. Rejects only when one is there and cannot be removed. */
export async function deleteThumbnailFile(documentId: string): Promise<void> {
  if (!ID.test(documentId)) return;
  let dir: FileSystemDirectoryHandle;
  try {
    dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(THUMBS_DIR);
  } catch {
    return; // no thumbnails folder: nothing to remove
  }
  try {
    await dir.removeEntry(thumbnailFileName(documentId));
  } catch (e) {
    if (e instanceof DOMException && e.name === 'NotFoundError') return;
    throw e;
  }
}

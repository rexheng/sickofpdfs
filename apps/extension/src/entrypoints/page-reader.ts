// "Save this page to library" (spec R103): the script the action menu puts into the current tab, only when the owner clicks
// "Save this page to library" (chrome.scripting with the activeTab grant). It answers the page's article (webclip/reader.ts)
// and leaves a small object in the extension's own isolated world, so the save can read the article's pictures next. The
// page's own scripts cannot see that world. Nothing is sent anywhere.
import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { type ImageResult, PAGE_GLOBAL, type ReadResult } from '../webclip/article';
import { readImage, readPage } from '../webclip/reader';

export interface PageReader {
  readImage(ref: number, src: string): Promise<ImageResult>;
}

export default defineUnlistedScript((): ReadResult => {
  // The pictures as they are now, so the indexes the article names stay right if the page adds more later.
  const live = Array.from(document.images);
  const reader: PageReader = { readImage: (ref, src) => readImage(live, ref, src) };
  (globalThis as Record<string, unknown>)[PAGE_GLOBAL] = reader;
  return readPage(document, live);
});

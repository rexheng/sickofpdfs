// "Save this page to library" (spec R103): makes the PDF in the saving tab (save-page.html), on this computer. It reads the
// article's pictures from the page's tab (through the page script the menu put there), loads the bundled fonts from the
// extension's own files, and typesets the article (typeset.ts). Nothing is downloaded.
import { articleImages, type Article, type ImageRef, type ImageResult, PAGE_GLOBAL } from './article';
import { type GlyphPicture, typesetArticle, type TypesetFonts, type TypesetResult } from './typeset';

/** How many pictures are read from the page at once. */
const PARALLEL = 3;

/** Reads one picture through the page script, in the page's tab. `{ ok: false }` when the tab or the picture is gone. */
async function readOne(tabId: number, ref: ImageRef): Promise<ImageResult> {
  try {
    const [answer] = await chrome.scripting.executeScript({
      target: { tabId },
      // Runs in the page script's own isolated world, where it left its reader (entrypoints/page-reader.ts).
      func: async (index: number, src: string, key: string) => {
        const reader = (globalThis as Record<string, unknown>)[key] as { readImage?: (i: number, s: string) => Promise<unknown> } | undefined;
        return reader?.readImage === undefined ? { ok: false } : reader.readImage(index, src);
      },
      args: [ref.ref, ref.src, PAGE_GLOBAL],
    });
    const r = answer?.result as ImageResult | undefined;
    return r !== undefined && r.ok && typeof r.dataUrl === 'string' && /^data:image\/(?:png|jpeg);base64,/u.test(r.dataUrl) ? r : { ok: false };
  } catch {
    return { ok: false };
  }
}

/** Every picture of the article, read from the page; `progress` hears how many are done. */
export async function readPictures(tabId: number, article: Article, progress: (done: number, total: number) => void): Promise<Map<ImageRef, ImageResult>> {
  const refs = articleImages(article);
  const out = new Map<ImageRef, ImageResult>();
  let next = 0;
  let done = 0;
  progress(0, refs.length);
  const worker = async () => {
    while (next < refs.length) {
      const ref = refs[next++];
      out.set(ref, await readOne(tabId, ref));
      progress(++done, refs.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, refs.length) }, worker));
  // In reading order, as the typesetter numbers them.
  return new Map(refs.map((r) => [r, out.get(r) ?? { ok: false }]));
}

/** The bundled fonts, from the extension's own files. */
export async function loadFonts(): Promise<TypesetFonts> {
  const get = async (name: string) => new Uint8Array(await (await fetch(chrome.runtime.getURL(`pdf/${name}`))).arrayBuffer());
  const [regular, bold, italic, boldItalic, mono] = await Promise.all([
    get('NotoSans-Regular.ttf'),
    get('NotoSans-Bold.ttf'),
    get('NotoSans-Italic.ttf'),
    get('NotoSans-BoldItalic.ttf'),
    get('NotoSansMono-Regular.ttf'),
  ]);
  return { regular, bold, italic, boldItalic, mono };
}

/** The fonts of this computer that may have emoji and Chinese, Japanese or Korean letters. Nothing is downloaded. */
const PICTURE_FONTS = '"Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Sans CJK SC", "PingFang SC", "Hiragino Sans", "Microsoft YaHei", sans-serif';
const PICTURE_PX = 64;

/** Draws characters the bundled fonts lack (an emoji, a Chinese name) with this computer's fonts, as small PNGs. */
export async function drawGlyphPictures(clusters: readonly string[]): Promise<Map<string, GlyphPicture>> {
  const out = new Map<string, GlyphPicture>();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (ctx === null) return out;
  for (const c of clusters) {
    ctx.font = `${PICTURE_PX}px ${PICTURE_FONTS}`;
    const m = ctx.measureText(c);
    const ascent = m.fontBoundingBoxAscent || PICTURE_PX * 0.92;
    const descent = m.fontBoundingBoxDescent || PICTURE_PX * 0.24;
    if (!(m.width > 0)) continue;
    canvas.width = Math.ceil(m.width);
    canvas.height = Math.ceil(ascent + descent);
    ctx.font = `${PICTURE_PX}px ${PICTURE_FONTS}`;
    ctx.fillStyle = '#1f1f1f';
    ctx.textBaseline = 'alphabetic';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillText(c, 0, ascent);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (blob === null) continue;
    out.set(c, { png: new Uint8Array(await blob.arrayBuffer()), width: m.width / PICTURE_PX, ascent: ascent / PICTURE_PX, descent: descent / PICTURE_PX });
  }
  return out;
}

/** The article as a PDF. */
export async function makePdf(article: Article, pictures: ReadonlyMap<ImageRef, ImageResult>, savedAt: number): Promise<TypesetResult> {
  return typesetArticle({ article, images: pictures, savedAt, locale: navigator.language, fonts: await loadFonts(), glyphPictures: drawGlyphPictures });
}

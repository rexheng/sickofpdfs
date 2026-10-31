import { FontCharset } from '@embedpdf/models';
import type { FontFallbackConfig, FontVariant } from '@embedpdf/engines/pdfium';

// The fallback fonts wxt.config.ts copies into the extension's pdf/ folder.
const LATIN: { file: string; weight: number; italic: boolean }[] = [
  { file: 'NotoSans-Regular.ttf', weight: 400, italic: false },
  { file: 'NotoSans-Italic.ttf', weight: 400, italic: true },
  { file: 'NotoSans-Bold.ttf', weight: 700, italic: false },
  { file: 'NotoSans-BoldItalic.ttf', weight: 700, italic: true },
];
const CJK = 'NotoSansHans-Regular.otf';

/**
 * Bundled fallback fonts as absolute URLs only. It holds no function, so it can be posted to the
 * stock blob worker (structured clone), which then fetches each font with a synchronous XHR.
 */
export function bundledFontUrls(fontBaseUrl: string): FontFallbackConfig {
  const base = fontBaseUrl.replace(/\/+$/, '');
  const latin: FontVariant[] = LATIN.map(({ file, weight, italic }) => ({ url: `${base}/${file}`, weight, italic }));
  const cjk = `${base}/${CJK}`;
  return {
    defaultFont: latin,
    fonts: {
      [FontCharset.SHIFTJIS]: cjk,
      [FontCharset.HANGEUL]: cjk,
      [FontCharset.GB2312]: cjk,
      [FontCharset.CHINESEBIG5]: cjk,
    },
  };
}

/** The same fonts with a loader, for our own worker. SpikeNative records every URL the loader is asked for. */
export function bundledFontFallback(fontBaseUrl: string): FontFallbackConfig {
  return { ...bundledFontUrls(fontBaseUrl), fontLoader: loadFontSync };
}

// PDFium asks for font bytes synchronously; synchronous XHR is allowed in workers.
function loadFontSync(url: string): Uint8Array | null {
  const xhr = new XMLHttpRequest();
  xhr.open('GET', url, false);
  xhr.responseType = 'arraybuffer';
  xhr.send();
  return xhr.status === 200 ? new Uint8Array(xhr.response as ArrayBuffer) : null;
}

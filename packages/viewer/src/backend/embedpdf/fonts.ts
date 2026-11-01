// The fallback fonts PDFium uses for text whose font is not embedded (ported from the Phase 0 spike, P0-1). They are
// the files copy-engine-assets.mjs puts in the extension's pdf/ folder, listed in engine-files.json.
import type { FontFallbackConfig, FontVariant } from '@embedpdf/engines/pdfium';
import { FontCharset } from '@embedpdf/models';
import files from './engine-files.json';

/**
 * Every bundled font as an absolute URL, with a synchronous loader (PDFium asks for font bytes synchronously, and
 * synchronous XHR is allowed in workers). Latin text uses Noto Sans in four styles; Chinese, Japanese and Korean
 * charsets all use Noto Sans Hans.
 */
export function bundledFontFallback(fontBaseUrl: string): FontFallbackConfig {
  const base = fontBaseUrl.replace(/\/+$/, '');
  const latin: FontVariant[] = files.fonts
    .filter((f) => f.role === 'latin')
    .map((f) => ({ url: `${base}/${f.file}`, weight: f.weight, italic: f.italic }));
  const cjkFile = files.fonts.find((f) => f.role === 'cjk')?.file;
  if (!cjkFile || latin.length === 0) throw new Error('engine-files.json lists no Latin or no CJK font');
  const cjk = `${base}/${cjkFile}`;
  return {
    defaultFont: latin,
    fonts: {
      [FontCharset.SHIFTJIS]: cjk,
      [FontCharset.HANGEUL]: cjk,
      [FontCharset.GB2312]: cjk,
      [FontCharset.CHINESEBIG5]: cjk,
    },
    fontLoader: loadFontSync,
  };
}

function loadFontSync(url: string): Uint8Array | null {
  const xhr = new XMLHttpRequest();
  xhr.open('GET', url, false);
  xhr.responseType = 'arraybuffer';
  xhr.send();
  return xhr.status === 200 ? new Uint8Array(xhr.response as ArrayBuffer) : null;
}

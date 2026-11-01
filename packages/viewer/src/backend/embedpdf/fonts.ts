// The fonts PDFium uses for text whose font is not embedded in the PDF (ported from the Phase 0 spike, P0-1).
//
// - The 14 standard PDF fonts (Times, Helvetica and Courier in four styles each, Symbol and ZapfDingbats) are drawn with
//   PDFium's own built-in copies, as Chrome's viewer does. They have the standard widths, so each letter is drawn where
//   the PDF places it. Before it asks for a font, PDFium turns the usual other names (Arial, Times New Roman, Courier
//   New and their PostScript names) into these 14.
// - Every other font that is not embedded uses the bundled files that copy-engine-assets.mjs puts in the extension's
//   pdf/ folder (engine-files.json): Noto Sans in four styles for Latin, Greek and Cyrillic, and Noto Sans Hans for
//   Chinese, Japanese and Korean.
import { FontFallbackManager, type FontFallbackConfig, type FontLoader, type FontVariant } from '@embedpdf/engines/pdfium';
import { FontCharset } from '@embedpdf/models';
import type { WrappedPdfiumModule } from '@embedpdf/pdfium';
import files from './engine-files.json';

/**
 * The face names PDFium asks for when a PDF uses one of the 14 standard fonts without embedding it (checked against
 * this wasm: "Arial,Bold", "ArialMT", "TimesNewRomanPS-BoldMT", "Times New Roman" and "CourierNew" all arrive as these
 * names). Symbol and ZapfDingbats normally never reach MapFont, because PDFium uses its own copies directly; a TrueType
 * "Symbol" can, so both are listed (Chrome refuses "Symbol" for the same reason).
 */
export const BUILT_IN_FACES: ReadonlySet<string> = new Set([
  'Courier', 'Courier-Bold', 'Courier-BoldOblique', 'Courier-Oblique',
  'Helvetica', 'Helvetica-Bold', 'Helvetica-BoldOblique', 'Helvetica-Oblique',
  'Times-Roman', 'Times-Bold', 'Times-BoldItalic', 'Times-Italic',
  'Symbol', 'ZapfDingbats',
]);

/**
 * EmbedPDF's font fallback, except that it answers "no font" (0) for the 14 standard fonts. PDFium then draws them with
 * its built-in copies instead of Noto Sans, whose different letter widths broke the spacing ("IDIOSY NCRATIC").
 */
export class BundledFontFallback extends FontFallbackManager {
  protected override mapFont(weight: number, bItalic: number, charset: number, pitchFamily: number, face: string): number {
    return BUILT_IN_FACES.has(face) ? 0 : super.mapFont(weight, bItalic, charset, pitchFamily, face);
  }
}

/**
 * Every bundled font as an absolute URL, with a synchronous loader (PDFium asks for font bytes synchronously, and
 * synchronous XHR is allowed in workers). Latin text uses Noto Sans in four styles; Chinese, Japanese and Korean
 * charsets all use Noto Sans Hans.
 */
export function bundledFontFallback(fontBaseUrl: string, fontLoader: FontLoader = loadFontSync): FontFallbackConfig {
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
    fontLoader,
  };
}

/**
 * Gives PDFium its fonts for text that is not embedded. Call it once, after the engine is created (its constructor
 * starts PDFium) and before any document is opened. `fontLoader` is for Node scripts, which read the files from disk.
 */
export function installBundledFonts(module: WrappedPdfiumModule, fontBaseUrl: string, fontLoader?: FontLoader): BundledFontFallback {
  const fallback = new BundledFontFallback(bundledFontFallback(fontBaseUrl, fontLoader));
  fallback.initialize(module);
  return fallback;
}

function loadFontSync(url: string): Uint8Array | null {
  const xhr = new XMLHttpRequest();
  xhr.open('GET', url, false);
  xhr.responseType = 'arraybuffer';
  xhr.send();
  return xhr.status === 200 ? new Uint8Array(xhr.response as ArrayBuffer) : null;
}

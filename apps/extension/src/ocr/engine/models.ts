// The models the OCR engine runs, the engine's name and version, and its threads (Phase 7.0 Decision: PP-OCRv6 tiny on wasm;
// threads measured in ocrspeed, 2026-11-07).
// The files are put in the build at models/ocr/ by scripts/fetch-ocr-models.mjs (pinned by commit and sha256); the worker reads
// them from the extension's own folder, never from the network.
//
// `OCR_ENGINE_VERSION` names the models AND this code's way of turning them into words (reading order, word boxes). Change it
// whenever either changes: stored pages carry it (page_ocr.engine_version, page_text.source 'ocr:<engine>@<version>'), and a
// newer version reads the pages again (the upgrade rule keeps a page's old text when a note on it would not re-anchor).

export const OCR_ENGINE_ID = 'ppocr';
export const OCR_ENGINE_VERSION = '6-tiny.1';

/** Folder of the models in the extension (under its origin). */
export const OCR_MODELS_DIR = 'models/ocr/';
export const DET_MODEL = 'PP-OCRv6_tiny_det';
export const REC_MODEL = 'PP-OCRv6_tiny_rec';

/** Pages are drawn for recognition at this resolution (accuracy is flat from 100 to 300 dpi; 150 keeps memory low). */
export const OCR_RENDER_DPI = 150;
/** The detector's input is at most this many px on its longest side. */
export const OCR_DET_MAX_SIDE = 1280;
/** Lines recognised per batch: the page can be stopped between two batches. Larger batches were no faster and changed some words. */
export const OCR_REC_BATCH = 8;
export const OCR_WIDTH_BUCKET = 32;
/** The most threads the recogniser uses: past 4 a page is hardly faster, and the reading tab loses its core. */
export const OCR_MAX_THREADS = 4;

/**
 * The threads the recogniser runs on: one core fewer than the computer has (the reading tab keeps one), 1 to OCR_MAX_THREADS.
 * Threads need a cross-origin isolated page (SharedArrayBuffer): anywhere else it is 1. `asked` (the speed checks) is held
 * to the same limits.
 */
export function ocrThreads(cores: number | undefined, isolated: boolean, asked?: number): number {
  if (!isolated) return 1;
  const want = asked !== undefined && Number.isFinite(asked) ? Math.floor(asked) : (cores && cores > 0 ? cores : 2) - 1;
  return Math.max(1, Math.min(OCR_MAX_THREADS, want));
}

/** One pass reads English, French, German and the other Latin-script languages: there is no language choice. */
export const OCR_LANGS = ['en', 'fr', 'de'];

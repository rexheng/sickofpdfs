// The models the OCR engine runs, and the engine's name and version (Phase 7.0 Decision: PP-OCRv6 tiny, wasm, one thread).
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
/** Lines recognised per batch: the page can be stopped between two batches. */
export const OCR_REC_BATCH = 8;
export const OCR_WIDTH_BUCKET = 32;
/** One pass reads English, French, German and the other Latin-script languages: there is no language choice. */
export const OCR_LANGS = ['en', 'fr', 'de'];

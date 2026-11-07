// Phase 7: text recognition for scanned pages (contracts §9). Pure; the engine and the service are in apps/extension/src/ocr.
export type { OcrEngine, OcrPageKind, OcrPageResult, OcrProgress, OcrService, OcrWord, PageImageSource } from './types';
export { ocrSource } from './types';
export { JOINED_HYPHEN, ocrAngle, ocrLines, ocrPlainText, ocrText, ocrToPageGlyphs } from './to-glyphs';
export { ocrRects } from './rects';
export { searchOcr } from './search';
export { countWords, needsOcr, OCR_MAX_WORDS, OCR_MIN_IMAGE_COVERAGE } from './needs-ocr';

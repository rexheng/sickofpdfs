// The layout model (Phase 7.4): PP-DocLayout-S, 4.7 MiB, found by scripts/fetch-ocr-models.mjs in models/ocr/PP-DocLayout-S/.
// It draws boxes round the parts of a page (text, titles, figures, tables, charts, formulas). We keep three kinds.
export const LAYOUT_MODEL_DIR = 'PP-DocLayout-S';
export const LAYOUT_MODEL_FILE = 'pp_doclayout_s.onnx';
/** Names the model and the way its boxes are read. Change it when either changes (stored figures carry it). */
export const LAYOUT_DETECTOR = 'layout-model@pp-doclayout-s.1';
/** The model's input is a fixed square this many px on a side. */
export const LAYOUT_INPUT = 480;
/** The page is drawn for it at this resolution (it is shrunk to 480 px anyway; more px only cost memory). */
export const LAYOUT_RENDER_DPI = 100;

/** The model's 23 classes, in its own order. */
export const LAYOUT_LABELS = [
  'paragraph_title', 'image', 'text', 'number', 'abstract', 'content', 'figure_title', 'formula', 'table', 'table_title',
  'reference', 'doc_title', 'footnote', 'header', 'algorithm', 'footer', 'seal', 'chart_title', 'chart', 'formula_number',
  'header_image', 'footer_image', 'aside_text',
] as const;
export type LayoutLabel = (typeof LAYOUT_LABELS)[number];

/** A box the model found, in pixels of the image it was given. */
export interface LayoutBox {
  label: LayoutLabel;
  score: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

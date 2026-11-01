// @sop/viewer: the PDF engine adapter (Task 15), loading (Task 20), layout, render scheduling and the view state
// (Task 21). The React components are in '@sop/viewer/react' (src/react/index.ts), so code that only needs these types
// and functions (the e2e test hooks, Node scripts) never loads a stylesheet.
export type * from './backend/types';
export { PdfEngineCrashedError, PdfFormatError, PdfPasswordError, type EngineFailure } from './backend/errors';
export { hasFillableFields } from './backend/forms';
// Phase 2 S12: figure detection.
export {
  analysePage,
  CAPTION_PATTERN,
  DETECTOR_VERSION,
  FIND_FIGURES_BUDGET_MS,
  findFigures,
  RULES as FIGURE_RULES,
  type FigureInput,
  type FindFiguresOptions,
  type PageAnalysis,
} from './figures/find-figures';
export { createFigureService, isOutlined, OUTLINE_RULE, TEXT_RUNS_BUDGET_MS, type FigureService, type FigureServiceOptions, type PageFigureStore } from './figures/figure-service';
export { DHASH_COLUMNS, DHASH_ROWS, normToPdfRect, regionGrey9x8 } from './figures/region-dhash';
export { ENGINE_WORKERS, type EngineAssets } from './backend/engine-config';
export { engineAssets } from './backend/embedpdf/assets';
export { createEmbedPdfBackend, type EmbedPdfBackendOptions } from './backend/embedpdf/backend';
export { createPageTextProvider, type PageTextProvider, type PageTextProviderImpl } from './text/page-text';
export * from './marks/geometry';
export * from './marks/card-layout';

export { MAX_OPEN_BYTES } from './source/limits';
export { PdfLoadError, type PdfLoadErrorCode } from './source/errors';
export { displayNameFor } from './source/file-name';
export { loadPdfSource, type LoadedPdf, type PdfSourceRef } from './source/load-source';

export {
  clampScale,
  MAX_SCALE,
  MIN_SCALE,
  PAGE_GAP,
  PT_TO_CSS,
  resolveScale,
  stepZoom,
  wheelZoom,
  ZOOM_STEPS,
  type Spread,
  type ZoomMode,
} from './layout/zoom';
export { computeLayout, visibleRange, type PageBox, type PageLayout } from './layout/page-layout';
export { RenderScheduler, type RenderKind, type RenderSchedulerOptions } from './render/scheduler';
export { ScanDetector } from './render/scan-detect';
export { createViewerStore, INITIAL_VIEWER_SNAPSHOT, useViewerState, type ViewerSnapshot, type ViewerStore } from './react/viewer-state';
export type { PagePoint } from './layout/page-space';
export type { FindController, FindState, JumpHistory, SaveController, SaveState, ViewPosition } from './contracts';

// The text layer (Task 22): items from PDFium glyphs, the layer, and the DOM selection ↔ char ranges.
export {
  buildTextItems,
  DRIFT_PX,
  glyphUnits,
  lineAt,
  lineBreakJoins,
  normalizeCopiedText,
  PDFIUM_HYPHEN,
  TEXT_LAYER_FONT_FAMILY,
  textModelRange,
  wordAt,
  type GlyphUnit,
  type TextItem,
} from './text-layer/items';
export { loadTextLayerFont, measureTextLayerText, renderTextLayer, TEXT_LAYER_CLASS, type TextLayerHandle } from './text-layer/text-layer';
export { charAtPoint, charRangeFromDomRange, domPositionOfChar, getSelectionRanges, selectCharRanges, type CharRange } from './text-layer/char-map';

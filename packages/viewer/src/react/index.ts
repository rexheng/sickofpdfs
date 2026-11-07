// @sop/viewer/react: the viewer's React components. They import CSS modules, so they live behind their own entry.
export { LinkLayer, type LinkLayerProps, PageLinks, type PageLinksProps } from './LinkLayer';
export { OutlinePanel, type OutlinePanelProps } from './OutlinePanel';
export { ThumbnailRail, type ThumbnailRailProps } from './ThumbnailRail';
export { PageList, type PageListApi, type PageListDocument, type PageListProps } from './PageList';
export type { PageLayerContext } from './PageView';
export type { PagePaint } from './page-driver';
export {
  PAGE_END,
  TextLayer,
  TextLayerController,
  type PageTextLayer,
  type TextLayerControllerOptions,
  type TextLayerProps,
  type TextLayerSource,
  type TextSelectionSource,
} from './TextLayer';
export { CARET_SCAN_NOTE, CaretBrowsing, type CaretHost } from './caret-browsing';
export { FindBar, type FindBarProps } from './FindBar';
export { FindHighlights, type FindHighlightsProps } from './FindHighlights';
export { MarkLayer, markPaths, type MarkLayerItem, type MarkLayerPage, type MarkLayerProps, type MarkLayerSource, type MarkLayerStyle, type MarkPath } from './MarkLayer';
export { BoldLayer, displayMatrix, drawBoldRange, STRONG_UNDERLINE_EM, type BoldLayerProps, type BoldRange, type BoldTextSource, type DrawnRange } from '../marks/BoldLayer';
export { type BoldGlyph, boldGlyphs, paintBold } from '../marks/bold-painter';
export { pageToDevice } from '../marks/synthetic-bold';
export { type InkPatch, type InkWord, paintInk, planInk } from '../marks/scan-ink';
export { ScanInkPages, ScanInkWatch, type ScanInkSource } from './scan-ink-pages';
export { BoldCanvas, type BoldLook, PLAIN_LOOK, useBoldCanvas } from './BoldCanvas';
export {
  WORD_STARTS_PERF_MARK,
  WordStartsController,
  WordStartsLayer,
  type WordStartsControllerOptions,
  type WordStartsLayerProps,
  type WordStartsPage,
} from './WordStartsLayer';
export { FigureLayer, type FigureLayerNote, type FigureLayerPage, type FigureLayerProps, type FigureLayerSource } from './FigureLayer';
export { FiguresTab, type FiguresTabItem, type FiguresTabProps } from './FiguresTab';

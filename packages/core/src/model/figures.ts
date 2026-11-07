import type { PdfRect } from '../../../viewer/src/backend/types';

/** A figure or table found on a page by the detector (Task 5's shape). Rects are in points, unrotated page space. */
export interface DetectedFigure {
  kind: 'image' | 'vector' | 'mixed' | 'table' | 'unknown';
  rect: PdfRect;
  /** The caption's label, e.g. "Figure 1" or "Table IV". Null for an uncaptioned figure. */
  label: string | null;
  /** The caption's first line and the lines of its block. Null when uncaptioned. */
  captionRect: PdfRect | null;
  /** high: tagged, caption-linked, or one large image or form XObject. medium: an uncaptioned vector cluster. */
  confidence: 'high' | 'medium';
  /** Set when a model found it (a scanned page: Phase 7.4's layout model); absent for the object-and-caption detector. */
  detector?: string;
}

/** The JSON stored in page_figures.figures. A derived cache: never synced or backed up. */
export interface PageFigure extends DetectedFigure {
  index: number;
  objectIndices: number[];
  caption: { start: number; end: number; text: string } | null;
  imageSha256: string | null;
}

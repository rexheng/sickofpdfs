// Normative anchor JSON. The v1 union is Phase 1 Task 28's; Phase 2 adds two optional v2 fields.
// An absent v2 field means the v1 meaning.

/** 0–1 of the crop box, unrotated, origin top-left. */
export type NormRect = [x0: number, y0: number, x1: number, y1: number];

/** A PDFium char index on that page. */
export interface CharPos {
  page: number;
  index: number;
}

/** prefix and suffix are up to 32 chars each. */
export interface TextQuote {
  quote: string;
  prefix: string;
  suffix: string;
}

export interface FigureFingerprint {
  label: string | null;
  captionQuote: (TextQuote & { position: CharPos }) | null;
  imageSha256: string | null;
  dHash: string;
  detector: 'tagged' | 'objects' | 'caption' | 'manual' | 'layout-model';
  detectorVersion: string;
  /** v2: indices into listPageObjects(page, { recurseForms: true }). A hint only, never proof. */
  objectIndices?: number[];
}

export type Anchor =
  | {
      kind: 'text';
      quote: TextQuote;
      start: CharPos;
      /** Exclusive. */
      end: CharPos;
      rects: { page: number; rects: NormRect[] }[];
      /** v2: 'pdfium' (default) or 'ocr:<engine>@<version>'. */
      textSource?: string;
    }
  | { kind: 'area'; page: number; rect: NormRect; dHash: string }
  | { kind: 'figure'; page: number; rect: NormRect; figure: FigureFingerprint; sub?: { rect?: NormRect; point?: [number, number] } }
  | { kind: 'point'; page: number; point: [number, number] }
  | { kind: 'page'; page: number }
  | { kind: 'document' };

// The one interface every candidate sits behind (plan 7.0): recognize(image) -> OcrWord[].
// Boxes are in PIXELS of the image given to recognize(); the bench converts to points with the render scale.

export interface RgbaImage {
  /** RGBA, 4 bytes a pixel, row-major. */
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

export interface PxBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OcrWord {
  text: string;
  box: PxBox;
  /** 0..1 */
  confidence: number;
  /** Reading-order line number on the page. */
  line: number;
  /** Reading-order block (column / paragraph group) number on the page. */
  block: number;
}

export interface RecognizeTimings {
  /** Milliseconds by stage, e.g. { det, crops, rec, post } for PP-OCR. */
  [stage: string]: number;
}

export interface OcrEngine {
  readonly id: string;
  init(): Promise<void>;
  recognize(image: RgbaImage): Promise<OcrWord[]>;
  /** Stage timings of the last recognize() call. */
  lastTimings(): RecognizeTimings;
  /** Facts worth recording (backend actually used, model sizes, output classes, ...). */
  info(): Record<string, unknown>;
  dispose(): Promise<void>;
}

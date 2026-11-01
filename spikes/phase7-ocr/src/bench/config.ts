// Engine configurations the bench can run. One object per measured configuration; `id` names its results folder.

export interface PpocrConfig {
  kind: 'ppocr';
  id: string;
  /** folder names under models/ppocr/ */
  det: string;
  rec: string;
  backend: 'wasm' | 'webgpu';
  /** ORT wasm threads (1 = single thread). Ignored by webgpu except for its CPU-side ops. */
  threads: number;
  detMaxSide: number;
  recBatch?: number;
  widthBucket?: number;
}

export interface TesseractConfig {
  kind: 'tesseract';
  id: string;
  langs: string[];
  /** 'fast' (the plan's choice) or 'best' (accuracy ceiling, not shippable at 15 MB a language). */
  data: 'fast' | 'best';
  /** number of Tesseract workers; pages are recognised one at a time unless the bench runs pages in parallel. */
  workers: number;
}

export type EngineConfig = PpocrConfig | TesseractConfig;

export interface ImageSpec {
  /** path under the server's rendered/ folder, without extension */
  key: string;
}

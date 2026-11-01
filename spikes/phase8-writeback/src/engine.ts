// Loads the product's engine (SopPdfiumNative, packages/viewer/src/backend/embedpdf/sop-native.ts) in Node, on the same
// pdfium.wasm the extension ships, and exposes the pieces the write-back recipes need.
//
// Run through `node --experimental-transform-types --import ./loader/register.mjs` (see package.json): the loader lets
// Node run the repo's extensionless TypeScript imports.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WrappedPdfiumModule } from '@embedpdf/pdfium';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(here, '../../..');
export const ASSETS = process.env.SOP_ASSETS ?? '/home/user/sickofpdfs/test-assets';
const viewerRequire = createRequire(resolve(REPO, 'packages/viewer/package.json'));

export interface Engine {
  mod: WrappedPdfiumModule;
  native: WritebackBase;
}

/** The product class, loaded lazily so a failed import names its path. */
type SopNativeCtor = new (m: WrappedPdfiumModule, o?: object) => {
  openDocument(id: string, bytes: ArrayBuffer, password?: string): { pageCount: number; pages: { width: number; height: number; rotation: number }[]; encrypted: boolean };
  closeDoc(id: string): void;
  getPageChars(id: string, page: number): string;
  getTextRangeRects(id: string, page: number, start: number, count: number): { x: number; y: number; width: number; height: number }[];
  getGlyphOutlines(id: string, page: number, start: number, count: number): { charIndex: number; d: string; fill: number[] | null; stroke: number[] | null }[];
  searchPage(id: string, page: number, q: string, o: { matchCase: boolean; wholeWord: boolean }): { start: number; count: number }[];
};
export type WritebackBase = InstanceType<SopNativeCtor>;

export async function loadEngine(): Promise<{ mod: WrappedPdfiumModule; SopPdfiumNative: SopNativeCtor }> {
  const { init } = (await import(viewerRequire.resolve('@embedpdf/pdfium'))) as typeof import('@embedpdf/pdfium');
  const wasmBinary = readFileSync(viewerRequire.resolve('@embedpdf/pdfium/pdfium.wasm'));
  const mod = await init({ wasmBinary });
  const { SopPdfiumNative } = (await import(resolve(REPO, 'packages/viewer/src/backend/embedpdf/sop-native.ts'))) as { SopPdfiumNative: SopNativeCtor };
  return { mod, SopPdfiumNative };
}

export const toArrayBuffer = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

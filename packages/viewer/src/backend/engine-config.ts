// The Phase 0 engine decision as code (docs/spikes/phase0-report.md, Decision section: ENGINE = embedpdf-v2 with the
// v2-file worker, ENGINE_WORKERS = 1, ruling R25). This is the only place the worker count is written; Tasks 20 and 21
// import it from @sop/viewer.

/** How many engine workers the viewer starts. With 2, each document opens in both and pages go by pageIndex % 2. */
export const ENGINE_WORKERS: 1 | 2 = 1;

/**
 * Where the engine's files are. The extension ships them in its `pdf/` folder (apps/extension/scripts/
 * copy-engine-assets.mjs), so both are chrome-extension:// URLs in the product. Nothing is fetched from anywhere else.
 */
export interface EngineAssets {
  /** pdfium.wasm. */
  wasmUrl: string;
  /** The folder holding the fallback fonts (NotoSans-*.ttf, NotoSansHans-Regular.otf), with or without a trailing slash. */
  fontBaseUrl: string;
}

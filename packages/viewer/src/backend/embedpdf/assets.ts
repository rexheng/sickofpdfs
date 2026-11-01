import type { EngineAssets } from '../engine-config';

/**
 * The engine's file URLs, from a resolver for extension paths. The extension passes chrome.runtime.getURL; a test
 * page passes a resolver for the same files under apps/extension/public/. Nothing points into node_modules.
 */
export function engineAssets(resolve: (path: string) => string): EngineAssets {
  return { wasmUrl: resolve('pdf/pdfium.wasm'), fontBaseUrl: resolve('pdf/') };
}

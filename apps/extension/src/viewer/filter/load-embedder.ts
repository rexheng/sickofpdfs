// Loads the MiniLM embedder from the extension's own files (onnxruntime-web, plain wasm, one thread). Shared by the tie-breaker's worker
// (embed.worker.ts, in a viewer tab) and the categoriser's worker (categorise/controller.ts, in the offscreen document), so the same
// model, the same runtime and the same checks serve both.
//
// No network: the folder must be under the worker's own origin, and the files are put there at build time
// (scripts/fetch-minilm.mjs, scripts/copy-ort-assets.mjs). It reads them with `fetch` of an address in that folder, which Chrome serves from
// the extension package. An error it throws names the stage that failed, never a text.
import { createEmbedder, type Embedder, type OnnxRuntime } from './embedder';

/** The folder must be under this worker's own origin: the model never comes from anywhere else. */
export function ownFolder(base: string): string {
  const url = new URL(base);
  if (url.origin !== self.location.origin || !url.pathname.endsWith('/')) throw new Error('asset folder is not a folder of this extension');
  return url.href;
}

async function bytesOf(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`cannot read ${url.slice(url.lastIndexOf('/') + 1)} (HTTP ${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Starts the runtime and the model (about a second, cold). Call `dispose()` on the result to free the model's memory. */
export async function loadEmbedder(base: string): Promise<Embedder> {
  const folder = ownFolder(base);
  const ort = (await import(/* @vite-ignore */ `${folder}ort/ort.wasm.min.mjs`)) as OnnxRuntime;
  ort.env.logLevel = 'error';
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = `${folder}ort/`;
  const [model, vocab] = await Promise.all([bytesOf(`${folder}models/minilm/model_quantized.onnx`), bytesOf(`${folder}models/minilm/vocab.txt`)]);
  return createEmbedder(ort, model, new TextDecoder().decode(vocab));
}

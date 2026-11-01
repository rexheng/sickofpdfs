// The tie-breaker's worker (module worker, started by tie-breaker.ts in the viewer tab). It loads onnxruntime-web (plain
// wasm, one thread) and the MiniLM model from the extension's own files on the first request, turns each text into a vector
// and answers with its cosine similarity to the closest reference sentence of each kind (prototypes.ts).
//
// No network: it only fetches and imports addresses under its own origin (the extension's, or the test page's), and the
// files are put there at build time (scripts/fetch-minilm.mjs, scripts/copy-ort-assets.mjs). It logs nothing, and an error
// it reports names the stage that failed, never the text.
import type { Embedder, OnnxRuntime } from './embedder';
import { createEmbedder } from './embedder';
import { loadPrototypes, similaritiesTo, type Prototypes } from './prototypes';
import type { EmbedRequest, EmbedResponse } from './tie-breaker';

interface Ready {
  embedder: Embedder;
  prototypes: Prototypes;
}

let ready: Promise<Ready> | null = null;

/** The folder must be under this worker's own origin: the model never comes from anywhere else. */
function ownFolder(base: string): string {
  const url = new URL(base);
  if (url.origin !== self.location.origin || !url.pathname.endsWith('/')) throw new Error('asset folder is not a folder of this extension');
  return url.href;
}

async function bytesOf(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`cannot read ${url.slice(url.lastIndexOf('/') + 1)} (HTTP ${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

function load(base: string): Promise<Ready> {
  return (async () => {
    const folder = ownFolder(base);
    const ort = (await import(/* @vite-ignore */ `${folder}ort/ort.wasm.min.mjs`)) as OnnxRuntime;
    ort.env.logLevel = 'error';
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = `${folder}ort/`;
    const [model, vocab] = await Promise.all([bytesOf(`${folder}models/minilm/model_quantized.onnx`), bytesOf(`${folder}models/minilm/vocab.txt`)]);
    const embedder = await createEmbedder(ort, model, new TextDecoder().decode(vocab));
    return { embedder, prototypes: loadPrototypes() };
  })();
}

const reply = (message: EmbedResponse): void => self.postMessage(message);

// One text at a time: the runtime runs one inference per session at once, and the answers then come back in order.
let queue: Promise<void> = Promise.resolve();

self.onmessage = (event: MessageEvent<EmbedRequest>) => {
  const { id, base, text } = event.data;
  queue = queue.then(async () => {
    try {
      ready ??= load(base);
      const { embedder, prototypes } = await ready;
      const sim = similaritiesTo(await embedder.embed(text), prototypes);
      reply({ id, ok: true, learning: sim.learning, notLearning: sim.notLearning });
    } catch (error) {
      // A failed start may be tried again by the next request.
      ready = null;
      reply({ id, ok: false, error: error instanceof Error ? error.message.slice(0, 200) : 'unknown error' });
    }
  });
};

// The tie-breaker's worker (module worker, started by tie-breaker.ts in the viewer tab). It loads onnxruntime-web (plain
// wasm, one thread) and the MiniLM model from the extension's own files on the first request, turns each text into a vector
// and answers with its cosine similarity to the closest reference sentence of each kind (prototypes.ts).
//
// No network: it only fetches and imports addresses under its own origin (the extension's, or the test page's), and the
// files are put there at build time (scripts/fetch-minilm.mjs, scripts/copy-ort-assets.mjs). It logs nothing, and an error
// it reports names the stage that failed, never the text.
import type { Embedder } from './embedder';
import { loadEmbedder } from './load-embedder';
import { loadPrototypes, similaritiesTo, type Prototypes } from './prototypes';
import type { EmbedRequest, EmbedResponse } from './tie-breaker';

interface Ready {
  embedder: Embedder;
  prototypes: Prototypes;
}

let ready: Promise<Ready> | null = null;

function load(base: string): Promise<Ready> {
  return loadEmbedder(base).then((embedder) => ({ embedder, prototypes: loadPrototypes() }));
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

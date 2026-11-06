// The meaning half of @Claude's passage search (module worker, started by context.ts in the viewer tab). It loads the same bundled
// MiniLM model and runtime as the learning filter's tie-breaker (`loadEmbedder`, from the extension's own files) on the first
// request, and turns each text into its unit-length vector.
//
// No network: it only reads addresses under its own origin, and the files are put there at build time. It keeps no text and logs
// nothing; an error it reports names the stage that failed, never a text.
import type { Embedder } from '../filter/embedder';
import { loadEmbedder } from '../filter/load-embedder';

export interface PassageEmbedRequest {
  id: number;
  /** The folder holding ort/ and models/minilm/. */
  base: string;
  texts: string[];
}

export type PassageEmbedResponse = { id: number; ok: true; vectors: Float32Array[] } | { id: number; ok: false; error: string };

let ready: Promise<Embedder> | null = null;
let queue: Promise<void> = Promise.resolve();

const reply = (message: PassageEmbedResponse, transfer: Transferable[] = []): void => self.postMessage(message, { transfer });

self.onmessage = (event: MessageEvent<PassageEmbedRequest>) => {
  const { id, base, texts } = event.data;
  // One request at a time: the runtime runs one inference per session at once.
  queue = queue.then(async () => {
    try {
      ready ??= loadEmbedder(base);
      const embedder = await ready;
      const vectors: Float32Array[] = [];
      for (const text of texts) vectors.push(await embedder.embed(text));
      reply({ id, ok: true, vectors }, vectors.map((v) => v.buffer));
    } catch (error) {
      ready = null; // a failed start may be tried again by the next request
      reply({ id, ok: false, error: error instanceof Error ? error.message.slice(0, 200) : 'unknown error' });
    }
  });
};

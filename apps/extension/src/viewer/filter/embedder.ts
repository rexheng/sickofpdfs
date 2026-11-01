// The model half of the tie-breaker: all-MiniLM-L6-v2 (int8) on onnxruntime-web, one thread, plain wasm. It turns a
// text into one unit-length vector of 384 numbers (mean of the token vectors, then scaled to length 1), the way the
// research run did (docs/research/04, B.4). The worker (embed.worker.ts) and the build check (scripts/minilm-prototypes.mjs)
// both use it, so the vectors stored in prototypes.ts and the vectors made at run time come from the same code.
//
// The runtime is passed in, not imported: the worker loads it from the extension's own files, the build check from node_modules.
import type * as Ort from 'onnxruntime-web';
import { createWordPiece } from './wordpiece';

export type OnnxRuntime = typeof Ort;

/** Characters of a text the model reads (the research run read the first 2,000 characters of pages 1 and 2). */
export const MAX_TEXT_CHARS = 2000;

export interface Embedder {
  /** The unit-length vector of the text's first MAX_TEXT_CHARS characters. White space is collapsed first. */
  embed(text: string): Promise<Float32Array>;
  /** Frees the model's memory. */
  dispose(): Promise<void>;
}

/** White space collapsed, and only the first MAX_TEXT_CHARS characters kept. */
export function prepareText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_CHARS);
}

export async function createEmbedder(ort: OnnxRuntime, modelBytes: Uint8Array, vocabText: string): Promise<Embedder> {
  const tokenizer = createWordPiece(vocabText);
  const session = await ort.InferenceSession.create(modelBytes, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
    intraOpNumThreads: 1,
    interOpNumThreads: 1,
  });
  const needsTypes = session.inputNames.includes('token_type_ids');
  const output = session.outputNames[0];
  if (output === undefined) throw new Error('the model has no output');

  async function embed(text: string): Promise<Float32Array> {
    const ids = tokenizer.encode(prepareText(text));
    const n = ids.length;
    const feeds: Record<string, Ort.Tensor> = {
      input_ids: new ort.Tensor('int64', BigInt64Array.from(ids, (id) => BigInt(id)), [1, n]),
      attention_mask: new ort.Tensor('int64', new BigInt64Array(n).fill(1n), [1, n]),
    };
    if (needsTypes) feeds.token_type_ids = new ort.Tensor('int64', new BigInt64Array(n), [1, n]);
    const result = await session.run(feeds);
    const hidden = result[output];
    if (hidden === undefined) throw new Error('the model gave no output');
    const size = hidden.dims[2];
    if (size === undefined || size <= 0) throw new Error('the model output has an unexpected shape');
    const data = hidden.data as Float32Array;
    // Mean of the token vectors (every token is real: there is no padding), then scaled to length 1.
    const mean = new Float32Array(size);
    for (let t = 0; t < n; t++) for (let k = 0; k < size; k++) mean[k] = (mean[k] ?? 0) + (data[t * size + k] ?? 0) / n;
    let norm = 0;
    for (let k = 0; k < size; k++) norm += (mean[k] ?? 0) ** 2;
    norm = Math.sqrt(norm);
    if (!(norm > 0)) throw new Error('the model gave an empty vector');
    for (let k = 0; k < size; k++) mean[k] = (mean[k] ?? 0) / norm;
    return mean;
  }

  return { embed, dispose: () => session.release() };
}

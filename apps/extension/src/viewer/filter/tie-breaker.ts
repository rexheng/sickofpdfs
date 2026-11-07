// Step 3 of the learning filter (spec, "Learning filter and privacy"): when the score cannot decide, a small bundled model
// (all-MiniLM-L6-v2, int8, 23 MB) compares the PDF's text with a few reference sentences and core's `nudge` moves the score by
// at most 2 points. This file is the viewer's side of it: `createTieBreaker()` gives an object that starts the model in a worker
// on the first question and ends it when it is disposed.
//
//   const tieBreaker = createTieBreaker();
//   try {
//     const sim = await tieBreaker.similarities(tieBreakerText(input.sampleText));
//     decision = nudge(decision, sim);          // core: moves only an "unsure" verdict that carries a score
//   } catch {
//     // the model could not run: the verdict stays "unsure" and the chip asks. Never save on a failure.
//   } finally {
//     tieBreaker.dispose();
//   }
//
// What it never does:
// - It never touches the network. The model, its vocabulary and the runtime are files of the extension (public/models/minilm/
//   and public/ort/, put there at build time); the worker refuses any address outside its own origin.
// - It never decides. It returns two numbers. The only thing that can use them is `nudge`, which leaves every verdict but
//   "unsure" alone, so a hard block, a list, a force save and the owner's own choice are never touched by the model.
// - It never keeps or reports the text. The worker turns it into numbers and forgets it; nothing is logged.
//
// It runs in the viewer tab only (never in the store or the offscreen page), on one thread (it is small, and the cores are
// left to the reading tab and the OCR), and is ended after use.
import type { Similarities } from '@sop/core';

export type { Similarities };

export interface TieBreaker {
  /**
   * How close the text is to study material (`learning`) and to paperwork (`notLearning`): the cosine similarity to the
   * closest reference sentence of each kind. Starts the worker and loads the model on the first call (about a second).
   * Rejects when the model cannot run (a missing file, a timeout, a worker that died) or when the tie-breaker was disposed.
   */
  similarities(text: string): Promise<Similarities>;
  /** Ends the worker and frees the model. Waiting calls reject. Safe to call twice. */
  dispose(): void;
}

export interface TieBreakerOptions {
  /** The folder the model and runtime are in, ending in "/": `chrome.runtime.getURL('')` by default. Tests give their own. */
  assetBase?: string;
  /** Makes the worker. The default is this folder's embed.worker.ts as a module worker. */
  createWorker?: () => Worker;
  /** How long one call may take before the worker is ended and the call rejects. Default 30 seconds. */
  timeoutMs?: number;
}

export const TIE_BREAKER_TIMEOUT_MS = 30_000;
/** Pages of text the model reads: the first two (the research run, docs/research/04 B.4). */
export const TIE_BREAKER_PAGES = 2;

/** What to hand to `similarities`: the text of the first pages of the filter's sample. */
export function tieBreakerText(sampleText: readonly string[]): string {
  return sampleText.slice(0, TIE_BREAKER_PAGES).join(' ');
}

/** What the viewer sends the worker. */
export interface EmbedRequest {
  id: number;
  /** The folder holding ort/ and models/minilm/. */
  base: string;
  text: string;
}

/** What the worker answers. An error carries a plain-words stage and the runtime's message, never the text. */
export type EmbedResponse = { id: number; ok: true; learning: number; notLearning: number } | { id: number; ok: false; error: string };

const defaultWorker = (): Worker => new Worker(new URL('./embed.worker.ts', import.meta.url), { type: 'module', name: 'sop-tie-breaker' });

function defaultBase(): string {
  const url = typeof chrome !== 'undefined' ? chrome.runtime?.getURL?.('') : undefined;
  return url && url !== '' ? url : new URL('/', globalThis.location.href).href;
}

interface Waiting {
  resolve(sim: Similarities): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export function createTieBreaker(options: TieBreakerOptions = {}): TieBreaker {
  const timeoutMs = options.timeoutMs ?? TIE_BREAKER_TIMEOUT_MS;
  const waiting = new Map<number, Waiting>();
  let worker: Worker | null = null;
  let nextId = 1;
  let disposed = false;

  /** Ends the worker and rejects every call that is waiting for it. */
  function stop(reason: Error): void {
    const ended = worker;
    worker = null;
    ended?.terminate();
    for (const [id, w] of [...waiting]) {
      waiting.delete(id);
      clearTimeout(w.timer);
      w.reject(reason);
    }
  }

  function start(): Worker {
    if (worker !== null) return worker;
    const made = (options.createWorker ?? defaultWorker)();
    made.onmessage = (event: MessageEvent<EmbedResponse>) => {
      const answer = event.data;
      const w = waiting.get(answer.id);
      if (w === undefined) return;
      waiting.delete(answer.id);
      clearTimeout(w.timer);
      if (answer.ok) w.resolve({ learning: answer.learning, notLearning: answer.notLearning });
      else w.reject(new Error(`the tie-breaker could not run: ${answer.error}`));
    };
    const died = (): void => {
      if (worker === made) stop(new Error('the tie-breaker stopped unexpectedly'));
    };
    made.onerror = died;
    made.onmessageerror = died;
    worker = made;
    return made;
  }

  return {
    similarities(text) {
      if (disposed) return Promise.reject(new Error('the tie-breaker was disposed'));
      // Nothing to compare: no push either way, and no reason to load the model.
      if (text.trim() === '') return Promise.resolve({ learning: 0, notLearning: 0 });
      return new Promise<Similarities>((resolve, reject) => {
        let target: Worker;
        try {
          target = start();
        } catch (error) {
          reject(error instanceof Error ? error : new Error('the tie-breaker could not start'));
          return;
        }
        const id = nextId++;
        const timer = setTimeout(() => stop(new Error('the tie-breaker took too long')), timeoutMs);
        waiting.set(id, { resolve, reject, timer });
        const request: EmbedRequest = { id, base: options.assetBase ?? defaultBase(), text };
        try {
          target.postMessage(request);
        } catch {
          waiting.delete(id);
          clearTimeout(timer);
          reject(new Error('the tie-breaker could not be asked'));
        }
      });
    },
    dispose() {
      disposed = true;
      stop(new Error('the tie-breaker was disposed'));
    },
  };
}

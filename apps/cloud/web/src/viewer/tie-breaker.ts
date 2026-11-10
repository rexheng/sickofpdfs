// The web's version of apps/extension/src/viewer/filter/tie-breaker.ts (swapped in by vite.config.ts). The extension breaks a
// "not sure" tie with a small language model (MiniLM) that runs on the computer. The web does not ship it (plan CL15): every call
// says it cannot run, so the filter keeps "not sure", and the owner is asked.
import type { Similarities } from '@sop/core';

export type { Similarities };

export interface TieBreaker {
  similarities(text: string): Promise<Similarities>;
  dispose(): void;
}

export interface TieBreakerOptions {
  assetBase?: string;
  createWorker?: () => Worker;
  timeoutMs?: number;
}

export const TIE_BREAKER_TIMEOUT_MS = 30_000;
export const TIE_BREAKER_PAGES = 2;

export function tieBreakerText(sampleText: readonly string[]): string {
  return sampleText.slice(0, TIE_BREAKER_PAGES).join(' ');
}

export interface EmbedRequest {
  id: number;
  base: string;
  text: string;
}
export type EmbedResponse = { id: number; ok: true; learning: number; notLearning: number } | { id: number; ok: false; error: string };

export function createTieBreaker(options: TieBreakerOptions = {}): TieBreaker {
  void options;
  return {
    similarities: () => Promise.reject(new Error('no-model: the web library has no tie-breaker')),
    dispose: () => {},
  };
}

// Shared helpers for the spec-blind auto-categoriser tests (packages/core/src/categorise/*.spec-blind.test.ts).
// Test code only: nothing in src/ imports this file.
//
// It imports only the Doc TYPE from the interface file (categorise-interface.md: `export interface Doc` in topics.ts).
//
// The vectors are synthetic. A "group" is a set of docs scattered tightly round one axis of a small space. Groups on
// different axes are at right angles (cosine about 0), so "which docs belong together" has one obvious answer for any
// sensible clustering: no threshold from the spec is needed. Every random number is seeded, so every run is identical.
import type { Doc } from '../../src/categorise/topics';

export type { Doc };

/** Seeded random numbers in [0, 1) (mulberry32). */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rand: () => number): number {
  const u = 1 - rand();
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function normalise(v: ArrayLike<number>): Float32Array {
  const out = Float32Array.from(v);
  let sum = 0;
  for (const x of out) sum += x * x;
  const norm = Math.sqrt(sum);
  if (norm > 0) for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / Math.sqrt(na * nb);
}

/** The unit vector along one axis of a `dim`-dimensional space. */
export function axisVector(dim: number, axis: number): Float32Array {
  const v = new Float32Array(dim);
  v[axis] = 1;
  return v;
}

/**
 * `centre` plus random noise whose length is about `noise` (the centre has length 1), normalised again.
 * noise 0.15 gives a cosine of about 0.99 to the centre and about 0.98 between two such vectors.
 */
export function scatter(centre: Float32Array, noise: number, rand: () => number): Float32Array {
  const sigma = noise / Math.sqrt(centre.length);
  const v = Float32Array.from(centre);
  for (let i = 0; i < v.length; i++) v[i] += sigma * gauss(rand);
  return normalise(v);
}

/** The unit vector at `degrees` from `base`, turned towards `orth` (which must be a unit vector at right angles to `base`). */
export function atAngle(base: Float32Array, orth: Float32Array, degrees: number): Float32Array {
  const rad = (degrees * Math.PI) / 180;
  const v = new Float32Array(base.length);
  for (let i = 0; i < v.length; i++) v[i] = Math.cos(rad) * base[i] + Math.sin(rad) * orth[i];
  return normalise(v);
}

/** A seeded shuffle that leaves the input alone. */
export function shuffled<T>(items: readonly T[], seed: number): T[] {
  const rand = seeded(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function makeDoc(id: string, vector: Float32Array, title = '', abstract = ''): Doc {
  return { id, vector, text: { title, abstract } };
}

/** Everything about the docs that a function must leave alone (order, ids, vectors, text), as one string. */
export function snapshot(docs: readonly Doc[]): string {
  return JSON.stringify(docs.map((d) => [d.id, Array.from(d.vector), d.text.title, d.text.abstract]));
}

/** Code-unit order, so the result never depends on the machine's locale. */
export const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

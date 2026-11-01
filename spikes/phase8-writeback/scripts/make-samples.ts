// Writes the note set into a real PDF, three ways (A, B, C), saving incrementally with only the tail.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { ASSETS, REPO, toArrayBuffer } from '../src/engine.ts';
import { makeWritebackEngine, SAVE } from '../src/writeback.ts';
import { fixXrefStreamTail } from '../src/tail.ts';
import { buildNotes, preloadGeometry, type Env, type RepliesVariant } from '../src/samples.ts';
import { readGeometry } from '../src/geometry.ts';

export const OUT = process.env.SOP_OUT ?? resolve(REPO, 'test-assets/export-samples');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

export async function makeEnv(source: string, pages = [0, 1, 2]) {
  const { mod, WritebackNative } = await makeWritebackEngine();
  const native = new WritebackNative(mod, {});
  const orig = readFileSync(source);
  const opened = native.openDocument('view', toArrayBuffer(orig));
  const env: Env = { native: native as unknown as Env['native'], mod, viewId: 'view', pages: opened.pages, owner: 'Rex Heng', base: new Date(Date.UTC(2026, 10, 1, 9, 0, 0)) };
  const raw = native.openRaw(orig);
  for (const p of pages) {
    const page = mod.FPDF_LoadPage(raw.doc, p);
    preloadGeometry(env, p, readGeometry(mod, page, opened.pages[p]!.rotation));
    mod.FPDF_ClosePage(page);
  }
  raw.close();
  return { mod, native, env, orig };
}

export function writeCopy(native: InstanceType<Awaited<ReturnType<typeof makeWritebackEngine>>['WritebackNative']>, orig: Uint8Array, specs: Parameters<InstanceType<Awaited<ReturnType<typeof makeWritebackEngine>>['WritebackNative']>['writeAnnots']>[1], password?: string) {
  const raw = native.openRaw(orig, password);
  if (!raw.doc) throw new Error(`open failed ${raw.error}`);
  try {
    const t0 = performance.now();
    const res = native.writeAnnots(raw.doc, specs);
    const t1 = performance.now();
    const tail = native.saveWith(raw.doc, SAVE.incremental, orig.length);
    const t2 = performance.now();
    const fixed = fixXrefStreamTail(tail.bytes!, orig.length);
    const out = new Uint8Array(orig.length + fixed.bytes.length);
    out.set(orig, 0);
    out.set(fixed.bytes, orig.length);
    return { out, errors: res.errors, tailBytes: fixed.bytes.length, fix: fixed.kind, ms: { write: t1 - t0, save: t2 - t1 }, streamTotal: tail.total, rawTail: tail.bytes! };
  } finally {
    raw.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  mkdirSync(OUT, { recursive: true });
  const source = `${ASSETS}/paper-50.pdf`;
  const { native, env, orig } = await makeEnv(source);
  const names: Record<RepliesVariant, string> = { A: 'spike-A-threaded-empty-appearance.pdf', B: 'spike-B-threaded-hidden.pdf', C: 'spike-C-folded.pdf' };
  const summary: Record<string, unknown> = {};
  for (const v of ['A', 'B', 'C'] as RepliesVariant[]) {
    const built = buildNotes(env, v);
    const r = writeCopy(native, orig, built.specs);
    writeFileSync(resolve(OUT, names[v]), r.out);
    writeFileSync(resolve(OUT, names[v].replace('.pdf', '.expect.json')), JSON.stringify(built.expect, null, 1));
    const prefixOk = Buffer.compare(Buffer.from(r.out.subarray(0, orig.length)), Buffer.from(orig)) === 0;
    summary[v] = { file: names[v], annotations: built.specs.length, errors: r.errors, tailBytes: r.tailBytes, fix: r.fix, prefixIdentical: prefixOk, sha256Original: sha(orig).slice(0, 16), sha256OfPrefix: sha(r.out.subarray(0, orig.length)).slice(0, 16), ms: r.ms };
  }
  console.log(JSON.stringify(summary, null, 1));
}

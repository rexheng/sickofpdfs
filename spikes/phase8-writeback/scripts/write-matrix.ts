// Writes one highlight with a popup and a reply into each input of the save matrix, tail-only, and lists the results.
// usage: write-matrix.ts OUTDIR name=path[=password] ...
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { makeWritebackEngine, SAVE, FLAG } from '../src/writeback.ts';
import { fixXrefStreamTail } from '../src/tail.ts';

const [outDir, ...items] = process.argv.slice(2) as [string, ...string[]];
mkdirSync(outDir, { recursive: true });
const { mod, WritebackNative } = await makeWritebackEngine();
const rows: unknown[] = [];
for (const item of items) {
  const [name, path, password] = item.split('=') as [string, string, string | undefined];
  const orig = readFileSync(path);
  const native = new WritebackNative(mod, {});
  const h = native.openRaw(orig, password);
  if (!h.doc) { rows.push({ name, error: `open failed: ${h.error}` }); continue; }
  // Count on a handle of its own: reading every page on the write handle would load every page, and an incremental save
  // rewrites everything that was loaded (the tail would be as big as the file).
  const counter = native.openRaw(orig, password);
  const before = native.readAll(counter.doc, native.pageCountOf(counter.doc)).length;
  counter.close();
  const q = [{ x: 72, y: 700 }, { x: 160, y: 700 }, { x: 72, y: 688 }, { x: 160, y: 688 }] as [never, never, never, never];
  const specs = [
    { subtype: 'Highlight', pageIndex: 0, rect: [72, 688, 160, 700], quads: [q], rgb: [253, 226, 147], nm: 'sop:matrix-root', author: 'Rex', contents: 'root', created: new Date(), modified: new Date(), flags: FLAG.Print, ap: 'pdfium-multiply' },
    { subtype: 'Popup', pageIndex: 0, rect: [170, 600, 390, 700], nm: 'sop:matrix-root~popup', popupOfNm: 'sop:matrix-root', flags: 0, ap: 'none' },
    { subtype: 'Text', pageIndex: 0, rect: [72, 684, 88, 700], nm: 'sop:matrix-root~r1', author: 'Claude', contents: 'reply', irtNm: 'sop:matrix-root', rt: 'R', flags: FLAG.Print | FLAG.NoZoom | FLAG.NoRotate, rgb: [255, 235, 59], created: new Date(), modified: new Date(), ap: { stream: 'q Q' } },
  ] as const;
  const t0 = performance.now();
  const res = native.writeAnnots(h.doc, specs as never);
  const tail = native.saveWith(h.doc, SAVE.incremental, orig.length);
  const fixed = fixXrefStreamTail(tail.bytes!, orig.length);
  const ms = Math.round(performance.now() - t0);
  const out = Buffer.concat([orig, fixed.bytes]);
  const file = resolve(outDir, `${name}.pdf`);
  writeFileSync(file, out);
  rows.push({ name, file, source: path, password: password ?? null, annotsBefore: before, errors: res.errors, tailBytes: fixed.bytes.length, xref: fixed.kind, ms });
  h.close();
}
console.log(JSON.stringify(rows));

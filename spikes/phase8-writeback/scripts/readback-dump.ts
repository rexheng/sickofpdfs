// Dumps every annotation of a PDF as read by OUR engine's PDFium (the wasm build), as JSON on stdout.
// usage: readback-dump.ts file.pdf [password]
import { readFileSync } from 'node:fs';
import { makeWritebackEngine } from '../src/writeback.ts';

const { mod, WritebackNative } = await makeWritebackEngine();
const native = new WritebackNative(mod, {});
const bytes = readFileSync(process.argv[2]!);
const h = native.openRaw(bytes, process.argv[3]);
if (!h.doc) { console.log(JSON.stringify({ error: h.error })); process.exit(0); }
const count = native.pageCountOf(h.doc);
const max = Math.min(count, Number(process.env.PAGES ?? 400));
console.log(JSON.stringify({ pages: count, annotations: native.readAll(h.doc, max) }));
h.close();

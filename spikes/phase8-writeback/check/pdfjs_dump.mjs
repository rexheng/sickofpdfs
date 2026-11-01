// Independent reader #1: pdf.js. Prints every annotation pdf.js reports, one JSON document on stdout.
// usage: node check/pdfjs_dump.mjs file.pdf [password]
import { readFileSync } from 'node:fs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const data = new Uint8Array(readFileSync(process.argv[2]));
const doc = await getDocument({ data, password: process.argv[3], useSystemFonts: false, verbosity: 0, isEvalSupported: false }).promise;
const out = [];
for (let p = 1; p <= Math.min(doc.numPages, Number(process.env.PAGES ?? 400)); p++) {
  const page = await doc.getPage(p);
  const annots = await page.getAnnotations({ intent: 'display' });
  for (const a of annots) {
    out.push({
      page: p - 1, id: a.id, subtype: a.subtype, rect: a.rect, contents: a.contentsObj?.str ?? null, title: a.titleObj?.str ?? null,
      color: a.color ? Array.from(a.color) : null, quads: a.quadPoints ? Array.from(a.quadPoints).flatMap((q) => (Array.isArray(q) ? q.flatMap((pt) => [pt.x, pt.y]) : [q])) : null,
      inReplyTo: a.inReplyTo ?? null, replyType: a.replyType ?? null, popupRef: a.popupRef ?? null, parentId: a.parentId ?? null, flags: a.annotationFlags ?? null,
      created: a.creationDate ?? null, modified: a.modificationDate ?? null, hasAppearance: a.hasAppearance ?? null, subject: a.subject ?? null,
    });
  }
}
console.log(JSON.stringify({ pages: doc.numPages, annotations: out }));

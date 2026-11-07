// "Download with notes" (Phase 8, slice 8.2): the sample maker and the file checker, on the product's own code.
//
//   node scripts/verify/annot-conformance.mjs samples [--out <dir>]
//       Writes the Foxit and Acrobat hand-check files (docs/checklists/release3-foxit-acrobat.md) into
//       test-assets/export-samples/ (git-ignored): the same notes on a copy of test-assets/paper-50.pdf, made exactly as
//       the extension makes them (planPdfExport, synthetic bold, PdfBackend.writeAnnotations' writer in the viewer's
//       PDFium), then checks each one as `check` does. D is the same kind of notes on pages turned 0, 90, 180 and 270
//       degrees, with crop boxes that do not start at 0 (its input is written beside it).
//   node scripts/verify/annot-conformance.mjs check <original.pdf> <copy.pdf> [--json <file>]
//       Checks a copy against its original: the original's bytes are an exact prefix of the copy and unchanged; qpdf
//       --check finds nothing new; the annotations are listed twice, by our PDFium and by pdf-lib (an independent parser),
//       with replies resolved to their roots and pop-ups to their parents; every /NM is unique on its page.
//
// Exit 0 when every check passed, 1 when one failed, 2 on bad arguments. Prints a short listing; nothing is committed.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const viewerRequire = createRequire(join(repoRoot, 'packages/viewer/package.json'));
const rootRequire = createRequire(join(repoRoot, 'package.json'));
const [mode, ...rest] = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : fallback;
};

// ---- the engine, as the worker runs it (scripts/gates/engine-golden.mjs does the same) ----

function packageRoot(name) {
  let dir = dirname(viewerRequire.resolve(name));
  for (;;) {
    try {
      if (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name === name) return dir;
    } catch {
      // keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`cannot find the folder of ${name}`);
    dir = parent;
  }
}

async function startEngine() {
  const server = await createServer({
    root: repoRoot, configFile: false, appType: 'custom', logLevel: 'error',
    server: { middlewareMode: true, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true },
  });
  const load = (p) => server.ssrLoadModule(p);
  const { init } = viewerRequire('@embedpdf/pdfium');
  const { SopPdfiumNative } = await load('/packages/viewer/src/backend/embedpdf/sop-native.ts');
  const { installBundledFonts } = await load('/packages/viewer/src/backend/embedpdf/fonts.ts');
  const files = JSON.parse(readFileSync(join(repoRoot, 'packages/viewer/src/backend/embedpdf/engine-files.json'), 'utf8'));
  const wasm = readFileSync(join(packageRoot(files.wasm.package), files.wasm.from));
  const module = await init({ wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength), printErr: () => {} });
  const native = new SopPdfiumNative(module);
  const fontPaths = new Map(files.fonts.map((f) => [f.file, join(packageRoot(f.package), f.from)]));
  installBundledFonts(module, 'sop-engine://pdf', (url) => {
    const path = fontPaths.get(basename(url));
    return path ? new Uint8Array(readFileSync(path)) : null;
  });
  return { native, server, load };
}

const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const sha = (b) => createHash('sha256').update(b).digest('hex');

// ---- check ----

/** Every annotation in the file, read by pdf-lib straight from the dictionaries (no PDFium involved). */
async function listWithPdfLib(bytes) {
  const { PDFDocument, PDFName, PDFRef, PDFString, PDFHexString, PDFArray, PDFNumber, PDFDict } = rootRequire('pdf-lib');
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const ctx = pdf.context;
  const text = (v) => (v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : null);
  const look = (v) => (v instanceof PDFRef ? ctx.lookup(v) : v);
  const out = [];
  pdf.getPages().forEach((page, pageIndex) => {
    const annots = look(page.node.get(PDFName.of('Annots')));
    if (!(annots instanceof PDFArray)) return;
    for (let i = 0; i < annots.size(); i++) {
      const ref = annots.get(i);
      const d = look(ref);
      if (!(d instanceof PDFDict)) continue;
      const nmOf = (v) => {
        const t = look(v);
        return t instanceof PDFDict ? text(t.get(PDFName.of('NM'))) : null;
      };
      const quads = look(d.get(PDFName.of('QuadPoints')));
      const flags = look(d.get(PDFName.of('F')));
      const rt = look(d.get(PDFName.of('RT')));
      out.push({
        page: pageIndex + 1,
        subtype: String(look(d.get(PDFName.of('Subtype'))) ?? '').replace('/', ''),
        nm: text(d.get(PDFName.of('NM'))),
        author: text(d.get(PDFName.of('T'))),
        subject: text(d.get(PDFName.of('Subj'))),
        contents: text(d.get(PDFName.of('Contents'))),
        irt: d.get(PDFName.of('IRT')) ? nmOf(d.get(PDFName.of('IRT'))) : null,
        rt: rt ? String(rt).replace('/', '') : null,
        popup: d.get(PDFName.of('Popup')) ? nmOf(d.get(PDFName.of('Popup'))) : null,
        parent: d.get(PDFName.of('Parent')) ? nmOf(d.get(PDFName.of('Parent'))) : null,
        flags: flags instanceof PDFNumber ? flags.asNumber() : 0,
        quads: quads instanceof PDFArray ? quads.size() / 8 : 0,
        hasAP: look(d.get(PDFName.of('AP'))) instanceof PDFDict,
      });
    }
  });
  return { annots: out, info: { subject: pdf.getSubject() ?? null, keywords: pdf.getKeywords() ?? null } };
}

function qpdfCheck(path, password) {
  try {
    return { ok: true, out: execFileSync('qpdf', [...(password ? [`--password=${password}`] : []), '--check', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    // qpdf exits 2 on errors and 3 on warnings only
    return { ok: e.status === 3, out: `${e.stdout ?? ''}${e.stderr ?? ''}`, warningsOnly: e.status === 3 };
  }
}

/** The checks on one copy. `expect` (optional) is the plan: every planned /NM must be in the file, on its page. */
export async function checkCopy(native, origPath, copyPath, expect = null, password) {
  const orig = readFileSync(origPath);
  const copy = readFileSync(copyPath);
  const results = [];
  const pass = (name, ok, detail = '') => results.push({ name, ok, detail });
  pass('original bytes are an exact prefix of the copy', copy.length > orig.length && Buffer.compare(copy.subarray(0, orig.length), orig) === 0, `${orig.length} + ${copy.length - orig.length} bytes`);
  pass('original file unchanged (SHA-256)', sha(readFileSync(origPath)) === sha(orig), sha(orig).slice(0, 16));
  if (existsSync('/usr/bin/qpdf')) {
    const before = qpdfCheck(origPath, password);
    const after = qpdfCheck(copyPath, password);
    // One warning is known and harmless (spike 8.0): PDFium's xref stream gives no entry to itself, so /Size (one more
    // than the highest object number in the update, the xref stream's own, as ISO 32000-1 Table 17 asks) is one more
    // than qpdf counts. Anything else is a finding.
    const KNOWN = /reported number of objects \(\d+\) is not one plus the highest object number|operation succeeded with warnings/;
    const lines = (out) => out.split('\n').filter((l) => /error|warning|damaged|not found/i.test(l));
    const fresh = lines(after.out).filter((l) => !KNOWN.test(l) && !lines(before.out).some((b) => b.replace(origPath, '') === l.replace(copyPath, '')));
    const clean = /No syntax or stream encoding errors found/.test(after.out);
    pass('qpdf --check finds nothing new', after.ok && clean && fresh.length === 0, fresh.slice(0, 3).join(' | ') || (lines(after.out).some((l) => KNOWN.test(l)) ? 'clean but for the known /Size warning' : 'clean'));
  }
  // our PDFium
  const opened = native.openDocument('check', ab(copy), password);
  const ours = [];
  for (let p = 0; p < opened.pageCount; p++) for (const a of native.readAnnots('check', p)) ours.push(a);
  native.closeDoc('check');
  const byObj = new Map(ours.map((a) => [a.objectNumber, a]));
  const listing = ours.filter((a) => a.nm?.startsWith('sop:'));
  for (const a of listing) a.irtNm = a.irtObjectNumber === null ? null : (byObj.get(a.irtObjectNumber)?.nm ?? `#${a.irtObjectNumber}`);
  // pdf-lib
  let lib = { annots: [], info: {} };
  try {
    lib = await listWithPdfLib(copy);
    pass('pdf-lib reads the copy', true, `${lib.annots.length} annotations in all`);
  } catch (e) {
    pass('pdf-lib reads the copy', password !== undefined, password ? 'encrypted: pdf-lib cannot decrypt (expected)' : String(e));
  }
  const libOurs = lib.annots.filter((a) => a.nm?.startsWith('sop:'));
  if (password !== undefined) pass('pdf-lib cannot decrypt, so only our PDFium lists this encrypted copy', true, `${listing.length} notes`);
  else if (lib.annots.length > 0) {
    pass('both readers find the same notes', libOurs.length === listing.length, `PDFium ${listing.length}, pdf-lib ${libOurs.length}`);
    const perPage = new Map();
    for (const a of libOurs) perPage.set(`${a.page}|${a.nm}`, (perPage.get(`${a.page}|${a.nm}`) ?? 0) + 1);
    pass('every /NM is unique on its page', [...perPage.values()].every((n) => n === 1));
    const nms = new Set(libOurs.map((a) => a.nm));
    pass('every reply points at a root in the file', libOurs.filter((a) => a.irt !== null).every((a) => nms.has(a.irt) && a.rt === 'R'), `${libOurs.filter((a) => a.irt).length} replies`);
    pass('every pop-up and its parent point at each other', libOurs.filter((a) => a.subtype === 'Popup').every((p) => libOurs.some((r) => r.nm === p.parent && r.popup === p.nm)), `${libOurs.filter((a) => a.subtype === 'Popup').length} pop-ups`);
    pass('every note but a pop-up has an appearance', libOurs.every((a) => a.subtype === 'Popup' ? !a.hasAP : a.hasAP));
  }
  if (expect) {
    const found = new Set(listing.map((a) => `${a.pageIndex}|${a.nm}`));
    const missing = expect.filter((p) => !found.has(`${p.pageIndex}|${p.nm}`));
    pass('every planned note is in the file, on its page', missing.length === 0, missing.length ? `missing ${missing.map((p) => p.nm).join(', ')}` : `${expect.length} planned`);
  }
  return { results, listing, lib };
}

function printListing(listing) {
  const short = (s, n = 48) => (s === null || s === undefined ? '' : s.length > n ? `${s.slice(0, n - 1)}…` : s).replace(/\n/g, ' / ');
  for (const a of listing) {
    const role = a.irtNm ? `reply to ${a.irtNm.slice(4, 12)}` : a.subtype === 'Popup' ? 'pop-up' : (a.subject ?? '');
    console.log(`  p${a.pageIndex + 1}  ${a.subtype.padEnd(9)} ${a.nm.slice(4, 12)}${a.nm.includes('~') ? a.nm.slice(a.nm.indexOf('~')) : ''}  ${role.padEnd(18)} ${short(a.author, 12).padEnd(12)} quads ${a.quads.length}  F ${a.flags}  "${short(a.contents)}"`);
  }
}

function report(name, { results }) {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${name}: ${failed.length === 0 ? 'all checks passed' : `${failed.length} FAILED`}`);
  for (const r of results) console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
  return failed.length === 0;
}

// ---- samples: the hand-check note set (spike 8.0's), made by the product's code ----

async function makeSamples(env, outDir) {
  const { native, load } = env;
  const core = await load('/packages/core/src/index.ts');
  const { boldVectorFills } = await load('/packages/viewer/src/marks/bold-vector.ts');
  const { planPdfExport, buildTextAnchor } = core;
  const src = join(repoRoot, 'test-assets/paper-50.pdf');
  const orig = readFileSync(src);
  const opened = native.openDocument('v', ab(orig));
  const pages = opened.pages;
  const geometry = pages.map((_, p) => native.getPageBoxes('v', p));
  const text = (p) => native.getPageChars('v', p);
  const T0 = Date.UTC(2026, 10, 1, 9, 0, 0);
  const at = (m) => T0 + m * 60_000;
  const span = (p, from, to = from) => {
    const t = text(p);
    const s = t.indexOf(from);
    const e = t.indexOf(to, s) + to.length;
    if (s < 0 || e < to.length) throw new Error(`"${from}" … "${to}" is not on page ${p + 1}`);
    const sz = pages[p];
    const rects = native.getTextRangeRects('v', p, s, e - s).map((r) => [r.x / sz.width, r.y / sz.height, (r.x + r.width) / sz.width, (r.y + r.height) / sz.height]);
    return buildTextAnchor({ text, start: { page: p, index: s }, end: { page: p, index: e }, rects: [{ page: p, rects }] });
  };
  let n = 1;
  const id = () => `00000000-0000-4000-8000-${String(n++).padStart(12, '0')}`;
  const sync = { rev: 1, hlc: 'x', deletedAt: null };
  const marks = [];
  const threads = [];
  const comments = [];
  const mark = (style, color, anchor, m) => {
    marks.push({ ...sync, id: id(), documentId: 'd', style, color, anchor, pageIndex: anchor.kind === 'text' ? anchor.start.page : anchor.page, sortKey: anchor.kind === 'text' ? (anchor.rects[0]?.rects[0]?.[1] ?? 0) : anchor.rect[1], author: 'me', createdAt: at(m), updatedAt: at(m) });
  };
  const thread = (anchor, m, cs) => {
    const t = { ...sync, id: id(), documentId: 'd', anchor, pageIndex: anchor.kind === 'text' ? anchor.start.page : anchor.kind === 'document' ? null : anchor.page,
      sortKey: anchor.kind === 'text' ? (anchor.rects[0]?.rects[0]?.[1] ?? 0) : anchor.kind === 'area' || anchor.kind === 'figure' ? anchor.rect[1] : anchor.kind === 'point' ? anchor.point[1] : 0, placement: 'placed', draftOfTab: null, createdAt: at(m), updatedAt: at(m) };
    threads.push(t);
    cs.forEach((c, i) => comments.push({ ...sync, id: id(), threadId: t.id, documentId: 'd', author: c.by, body: c.body, draftOfTab: null, meta: c.meta ?? {}, createdAt: at(m + i), editedAt: null }));
  };
  const cite = { kind: 'claude-reply', v: 1, status: 'done', citations: [{ n: 1, pageIndex: 1 }], webSources: [] };
  // page 1
  mark('highlight', 1, span(0, 'This work is a component of a', 'larger project on income risk'), 1);
  mark('underline', 2, span(0, 'Stefanie', 'Stantcheva'), 2);
  mark('strike', 4, span(0, 'Working Paper 29000'), 3);
  const ta = span(0, 'NBER working papers are circulated for discussion');
  mark('highlight', 5, ta, 4);
  thread(ta, 4, [{ by: 'me', body: 'TA root: a comment on the orange highlight.' }, { by: 'claude', body: 'TA reply 1, from Claude. See [Page 2](cite:1).', meta: cite }, { by: 'me', body: 'TA reply 2, from you. Zażółć gęślą jaźń.' }]);
  thread(span(0, 'peer-reviewed or been subject to the review'), 7, [{ by: 'me', body: 'TB root: a comment on plain text (a dotted underline, no highlight).' }, { by: 'me', body: 'TB reply 1. Привет, мир.' }]);
  thread({ kind: 'area', page: 0, rect: [0.11, 0.3, 0.5, 0.38], dHash: '0000000000000000' }, 9, [{ by: 'me', body: 'TC root: a comment on an outlined area. 你好，世界' }, { by: 'claude', body: 'TC reply 1, from Claude. 日本語のテスト。' }]);
  thread({ kind: 'point', page: 0, point: [0.7, 0.55] }, 11, [{ by: 'me', body: 'A pin on the page (no replies).' }]);
  thread({ kind: 'page', page: 0 }, 12, [{ by: 'me', body: 'A note on the whole page.' }]);
  thread({ kind: 'document' }, 13, [{ by: 'me', body: 'A note on the whole document.' }]);
  // page 2
  mark('bold', null, span(1, 'idiosyncratic and exogenous changes'), 14);
  mark('area', null, { kind: 'area', page: 1, rect: [0.54, 0.58, 0.88, 0.62], dHash: '0000000000000000' }, 15);
  const td = span(1, 'event-study design');
  mark('highlight', 3, td, 16);
  thread(td, 16, [{ by: 'me', body: 'TD root: a comment on a blue highlight.' }, { by: 'me', body: 'TD reply 1 (you).' }, { by: 'claude', body: 'TD reply 2 (Claude).' }, { by: 'me', body: 'TD reply 3 (you). The replies should read in this order.' }]);

  // colours from the token file, as the extension reads them from the page's tokens
  const css = readFileSync(join(repoRoot, 'packages/ui/src/tokens/tokens.css'), 'utf8');
  const tok = (name) => {
    const m = new RegExp(`--${name}:\\s*#([0-9a-fA-F]{6})`).exec(css);
    if (!m) throw new Error(`no token --${name}`);
    return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  };
  const slots = [1, 2, 3, 4, 5];
  const colours = {
    markRgb: Object.fromEntries(slots.map((s) => [s, tok(`sop-mark-${s}`)])),
    lineRgb: Object.fromEntries(slots.map((s) => [s, tok(`sop-mark-${s}-line`)])),
    areaRgb: tok('sop-area-outline'),
    threadRgb: tok('sop-thread-underline'),
  };
  const place = (a) => (a.kind === 'text' ? a.rects : a.kind === 'area' || a.kind === 'figure' ? [{ page: a.page, rects: [a.rect] }] : null);
  /** Synthetic bold for each bold item, in user space (export-pdf.ts does the same through the backend). */
  const boldOf = (plan) => {
    const fills = {};
    for (const p of plan) {
      if (p.ap.kind !== 'bold-outlines' || !p.ap.chars) continue;
      const { start, count } = p.ap.chars;
      const from = Math.max(0, start - 2);
      const set = native.getGlyphShapes('v', p.pageIndex, from, Math.min(count, 2 ** 30) + (start - from) + 2);
      const g = geometry[p.pageIndex];
      fills[p.nm] = boldVectorFills(set, { start, end: start + count }).map((f) => ({
        rgb: [f.fill[0], f.fill[1], f.fill[2]],
        path: f.path.map((v, k) => (k % 4 === 1 ? g.crop[0] + v : k % 4 === 2 ? g.crop[3] - v : v)),
      }));
    }
    return fills;
  };
  mkdirSync(outDir, { recursive: true });
  const variants = [
    ['A', 'sample-A-threaded-empty-appearance.pdf', 'threaded', 'empty'],
    ['B', 'sample-B-threaded-hidden.pdf', 'threaded', 'hidden'],
    ['C', 'sample-C-folded.pdf', 'folded', 'hidden'],
  ];
  const made = [];
  for (const [v, name, replies, replyAppearance] of variants) {
    const plan = planPdfExport({ marks, threads, comments, geometry, place }, { replies, ...colours, ownerName: 'Rex Heng', replyAppearance });
    const started = performance.now();
    const tail = await native.writeAnnotsCopy('samples', ab(orig), plan.annotations, { save: 'tail', boldFills: boldOf(plan.annotations), info: { subject: 'A note on the whole document.' } });
    const ms = Math.round(performance.now() - started);
    const path = join(outDir, name);
    writeFileSync(path, Buffer.concat([orig, Buffer.from(tail)]));
    console.log(`${v}: ${name}  ${plan.annotations.length} annotations (${plan.annotations.filter((a) => a.irt).length} replies), tail ${tail.length} bytes, ${ms} ms`);
    made.push({ path, plan: plan.annotations });
  }
  native.closeDoc('v');

  // D: turned and trimmed pages (rule R3, Acrobat's quad order on a page shown turned). Page 1 of tl-two-column.pdf, four
  // times: /Rotate 0, 90, 180 and 270, each with a crop box that does not start at 0. On each: a yellow highlight on three
  // words, a bold phrase and a pin.
  const { PDFDocument, degrees } = rootRequire('pdf-lib');
  const base = await PDFDocument.load(readFileSync(join(repoRoot, 'test-assets/tl-two-column.pdf')));
  const turned = await PDFDocument.create();
  const copies = await turned.copyPages(base, [0, 0, 0, 0]);
  copies.forEach((pg, k) => {
    pg.setRotation(degrees(90 * k));
    pg.setCropBox(20 + 6 * k, 30 + 4 * k, 560, 720);
    turned.addPage(pg);
  });
  const dSrc = join(outDir, 'sample-D-input-rotated-and-cropped.pdf');
  writeFileSync(dSrc, await turned.save());
  const dOrig = readFileSync(dSrc);
  const dOpen = native.openDocument('v', ab(dOrig));
  const dGeo = dOpen.pages.map((_, p) => native.getPageBoxes('v', p));
  const dMarks = [];
  const dThreads = [];
  const dComments = [];
  const dText = (p) => native.getPageChars('v', p);
  /** The chars of `phrase` on page p. PDFium reads a page turned 180 degrees back to front, so it is looked for reversed there too (spaces aside). */
  const findPhrase = (t, phrase) => {
    const at = t.indexOf(phrase);
    if (at >= 0) return { start: at, end: at + phrase.length };
    const keep = [];
    for (let i = 0; i < t.length; i++) if (!/\s/.test(t[i])) keep.push(i);
    const squeezed = keep.map((i) => t[i]).join('');
    const back = [...phrase.replace(/\s/g, '')].reverse().join('');
    const k = squeezed.indexOf(back);
    return k < 0 ? null : { start: keep[k], end: keep[k + back.length - 1] + 1 };
  };
  const dSpan = (p, phrase) => {
    const found = findPhrase(dText(p), phrase);
    if (!found) throw new Error(`"${phrase}" is not on page ${p + 1} of D`);
    const sz = dOpen.pages[p];
    const rects = native.getTextRangeRects('v', p, found.start, found.end - found.start).map((r) => [r.x / sz.width, r.y / sz.height, (r.x + r.width) / sz.width, (r.y + r.height) / sz.height]);
    return buildTextAnchor({ text: dText, start: { page: p, index: found.start }, end: { page: p, index: found.end }, rects: [{ page: p, rects }] });
  };
  for (let p = 0; p < 4; p++) {
    const hl = dSpan(p, 'measured the depth');
    dMarks.push({ ...sync, id: id(), documentId: 'd', style: 'highlight', color: 1, anchor: hl, pageIndex: p, sortKey: 0.1, author: 'me', createdAt: at(20 + p), updatedAt: at(20 + p) });
    const bd = dSpan(p, 'steel rule');
    dMarks.push({ ...sync, id: id(), documentId: 'd', style: 'bold', color: null, anchor: bd, pageIndex: p, sortKey: 0.2, author: 'me', createdAt: at(30 + p), updatedAt: at(30 + p) });
    const t = { ...sync, id: id(), documentId: 'd', anchor: { kind: 'point', page: p, point: [0.8, 0.2] }, pageIndex: p, sortKey: 0.2, placement: 'placed', draftOfTab: null, createdAt: at(40 + p), updatedAt: at(40 + p) };
    dThreads.push(t);
    dComments.push({ ...sync, id: id(), threadId: t.id, documentId: 'd', author: 'me', body: `A pin on page ${p + 1} (turned ${90 * p}°).`, draftOfTab: null, meta: {}, createdAt: at(40 + p), editedAt: null });
  }
  const dPlan = planPdfExport({ marks: dMarks, threads: dThreads, comments: dComments, geometry: dGeo, place }, { replies: 'threaded', ...colours, ownerName: 'Rex Heng', replyAppearance: 'empty' });
  const dFills = {};
  for (const p of dPlan.annotations) {
    if (p.ap.kind !== 'bold-outlines' || !p.ap.chars) continue;
    const { start, count } = p.ap.chars;
    const from = Math.max(0, start - 2);
    const set = native.getGlyphShapes('v', p.pageIndex, from, count + (start - from) + 2);
    const g = dGeo[p.pageIndex];
    dFills[p.nm] = boldVectorFills(set, { start, end: start + count }).map((f) => ({ rgb: [f.fill[0], f.fill[1], f.fill[2]], path: f.path.map((v, k) => (k % 4 === 1 ? g.crop[0] + v : k % 4 === 2 ? g.crop[3] - v : v)) }));
  }
  const dTail = await native.writeAnnotsCopy('samples', ab(dOrig), dPlan.annotations, { save: 'tail', boldFills: dFills });
  native.closeDoc('v');
  const dPath = join(outDir, 'sample-D-rotated-and-cropped-pages.pdf');
  writeFileSync(dPath, Buffer.concat([dOrig, Buffer.from(dTail)]));
  console.log(`D: ${basename(dPath)}  ${dPlan.annotations.length} annotations, tail ${dTail.length} bytes`);
  made.push({ path: dPath, plan: dPlan.annotations, src: dSrc });
  return { src, made };
}

// ---- main ----

if (mode === 'samples') {
  const env = await startEngine();
  let ok = true;
  try {
    const { src, made } = await makeSamples(env, resolve(opt('out', join(repoRoot, 'test-assets/export-samples'))));
    for (const m of made) {
      const r = await checkCopy(env.native, m.src ?? src, m.path, m.plan);
      ok = report(basename(m.path), r) && ok;
      if (m === made[0]) printListing(r.listing);
    }
  } finally {
    await env.server.close();
  }
  process.exit(ok ? 0 : 1);
} else if (mode === 'check' && rest[0] && rest[1]) {
  const env = await startEngine();
  try {
    const r = await checkCopy(env.native, resolve(rest[0]), resolve(rest[1]), null, opt('password', undefined));
    const ok = report(basename(rest[1]), r);
    printListing(r.listing);
    if (opt('json')) writeFileSync(opt('json'), JSON.stringify({ results: r.results, annotations: r.lib.annots, info: r.lib.info }, null, 1));
    process.exitCode = ok ? 0 : 1;
  } finally {
    await env.server.close();
  }
} else {
  console.error('usage: annot-conformance.mjs samples [--out <dir>] | check <original.pdf> <copy.pdf> [--json <file>] [--password <pw>]');
  process.exit(2);
}

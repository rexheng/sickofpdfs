// `pnpm golden:check` and `pnpm golden:record`: Gate 2, the engine reference set (CLAUDE.md rule 6).
//
//   node scripts/gates/engine-golden.mjs check  [--pdfs <id,id,...>] [--list] [--no-fetch] [--assets <dir>] [--json <file>]
//   node scripts/gates/engine-golden.mjs record [--approve <pdf:page,...>] [--all] [--pdfs <id,...>] [--no-fetch] [--assets <dir>]
//
// It catches any PDF page that silently starts to render, extract or select differently after an engine or text-layer
// change. About 20 real PDFs (e2e/reference/engine/manifest.json) are opened in the viewer's own PDFium, in this Node
// process (SopPdfiumNative: the same wasm, text and render code the worker runs, minus the worker round trip), with the
// same fonts the worker installs (fonts.ts installBundledFonts). For each page it measures:
//   - the page count of the document;
//   - the SHA-256 of getPageText, and of getPageChars (the raw chars). getPageChars must be one UTF-16 unit per PDFium
//     char, so its length must equal FPDFText_CountChars; a page where it is not FAILS, whatever the baseline says;
//   - getTextRangeRects for 3 char ranges per text page (the start, the middle, and one that crosses a line break),
//     rounded to 0.1 pt. The ranges are written into the baseline, so a later run measures the same chars;
//   - the page rendered at 96 DPI with annotations (renderBitmap, as the viewer's scheduler asks for a tile): a 64-bit
//     dHash (9 x 8 grey grid), a 64-bit pHash (8 x 8 low frequencies of a 32 x 32 DCT) and an exact hash (SHA-256 of the
//     picture averaged down by 4 in each direction).
// A document of more than 100 pages is sampled: pages 1-5, the last 5, and every 10th page (10, 20, ...).
//
// Only hashes and numbers are committed (e2e/reference/engine/baseline.json); no PDF and no picture is. The PDFs are
// fetched by URL into test-assets/ (git-ignored) with their SHA-256 checked, or made by `pnpm fixtures`.
//
// check:  exit 0 when every page matches the baseline. Exit 1 when anything differs: each changed page is listed with
//         what changed, and before / after / diff PNGs of every changed render go to test-assets/golden-diff/ (never into
//         the repo). The "before" picture is the baseline render kept in test-assets/golden-cache/, which any run that
//         matches the baseline fills (the baseline holds only hashes). Exit 2 when the inputs are wrong: a missing PDF, a
//         SHA-256 that does not match the manifest, a bad argument.
//         A render counts as changed when its perceptual distance is over PERCEPTUAL_THRESHOLD bits (of 64, on either
//         hash) or its exact hash differs; both are reported.
// record: writes the baseline. It never re-records a page that is not named in --approve (pdf:5, pdf:5-8, pdf:*), and
//         it takes the blanket --all only when no baseline exists yet. A difference is shown, then approved or rejected,
//         never silently re-recorded.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { createServer } from 'vite';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const refDir = join(repoRoot, 'e2e/reference/engine');
const manifestPath = join(refDir, 'manifest.json');
const baselinePath = join(refDir, 'baseline.json');

/** The render's resolution: 96 DPI is 4/3 device pixels per point, the viewer's 100% on a DPR-1 screen. */
const DPI = 96;
const SCALE = DPI / 72;
/** Two hashes closer than this many bits (of 64) count as the same picture to the eye; the exact hash still decides. */
const PERCEPTUAL_THRESHOLD = 4;
/** Documents of more pages than this are sampled. */
const FULL_UP_TO = 100;
const SAMPLE_EDGE = 5;
const SAMPLE_EVERY = 10;
/** Chars in each rect range. */
const RANGE_CHARS = 24;
const EXACT_DOWNSAMPLE = 4;
const STEP = 2; // exit code for bad inputs

// ---- arguments ------------------------------------------------------------------------------------------------------

const argv = process.argv.slice(2).filter((a) => a !== '--');
const mode = argv[0];
const args = argv.slice(1);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const fail = (code, lines) => {
  for (const l of [lines].flat()) console.error(l);
  process.exit(code);
};
const KNOWN_FLAGS = { check: ['pdfs', 'list', 'no-fetch', 'assets', 'json'], record: ['pdfs', 'approve', 'all', 'no-fetch', 'assets'] };
if (!KNOWN_FLAGS[mode]) fail(STEP, ['usage: node scripts/gates/engine-golden.mjs check|record [options]  (see the header of this file, or e2e/reference/engine/README.md)']);
for (const a of args.filter((x) => x.startsWith('--'))) {
  if (!KNOWN_FLAGS[mode].includes(a.slice(2))) fail(STEP, [`golden:${mode}: unknown option ${a}`]);
}
const assetsDir = resolve(opt('assets', join(repoRoot, 'test-assets')));
const cacheDir = join(assetsDir, 'golden-cache');
const diffDir = join(assetsDir, 'golden-diff');
const onlyIds = opt('pdfs')?.split(',') ?? null;

// ---- the manifest and the baseline ----------------------------------------------------------------------------------

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const problems = [];
const seen = new Set();
for (const item of manifest.items) {
  if (seen.has(item.id)) problems.push(`${item.id}: listed twice`);
  seen.add(item.id);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(item.id)) problems.push(`${item.id}: ids are lower-case letters, digits and dashes`);
  if (!item.path) problems.push(`${item.id}: no path`);
  if (item.source === 'fetch' && !(item.url && item.sha256 && item.bytes)) problems.push(`${item.id}: a fetched PDF needs url, sha256 and bytes`);
  if (item.source !== 'fetch' && item.source !== 'fixture') problems.push(`${item.id}: source must be "fetch" or "fixture"`);
}
if (onlyIds) for (const id of onlyIds) if (!seen.has(id)) problems.push(`--pdfs: no such PDF "${id}" in the manifest`);
if (problems.length) fail(STEP, ['The engine reference manifest is inconsistent:', ...problems.map((p) => `  ${p}`)]);
const items = manifest.items.filter((i) => !onlyIds || onlyIds.includes(i.id));

const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : null;

// ---- small helpers --------------------------------------------------------------------------------------------------

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const sha256File = (path) => sha256(readFileSync(path));
const pad = (s, n) => String(s).padEnd(n);
const rel = (p) => relative(repoRoot, p) || '.';
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;

/** The 1-based pages covered in a document of `count` pages. */
function coveredPages(count) {
  const all = Array.from({ length: count }, (_, i) => i + 1);
  if (count <= FULL_UP_TO) return all;
  return all.filter((p) => p <= SAMPLE_EDGE || p > count - SAMPLE_EDGE || p % SAMPLE_EVERY === 0);
}

// ---- 1. the inputs: fetch what is missing, check every SHA-256 ------------------------------------------------------

function pathOf(item) {
  return join(assetsDir, item.path);
}

function fetchItem(item, path) {
  mkdirSync(dirname(path), { recursive: true });
  const part = `${path}.part`;
  process.stderr.write(`fetching ${item.id} ...\n`);
  try {
    execFileSync('curl', ['-sSL', '--fail', '--retry', '3', '--max-filesize', String(manifest.max_bytes), '-o', part, item.url], { stdio: ['ignore', 'inherit', 'inherit'] });
  } catch (err) {
    rmSync(part, { force: true });
    return `${item.id}: download from ${item.url} failed (${err instanceof Error ? err.message.split('\n')[0] : err})`;
  }
  if (sha256File(part) !== item.sha256) {
    const got = sha256File(part);
    rmSync(part, { force: true });
    return `${item.id}: SHA-256 of the download is ${got}, the manifest says ${item.sha256} (download deleted)`;
  }
  renameSync(part, path);
  return null;
}

function verifyInputs(list) {
  const bad = [];
  for (const item of list) {
    const path = pathOf(item);
    if (!existsSync(path)) {
      if (item.source === 'fetch' && !flag('no-fetch')) {
        const err = fetchItem(item, path);
        if (err) bad.push(err);
        if (err) continue;
      } else {
        bad.push(`${item.id}: ${rel(path)} is missing${item.source === 'fixture' ? ' (run `pnpm fixtures`)' : ' (--no-fetch)'}`);
        continue;
      }
    }
    // A fixture the generator cannot reproduce byte for byte (a PDF with a creation date) has no pin: sha256 is null.
    if (item.sha256) {
      const got = sha256File(path);
      if (got !== item.sha256) bad.push(`${item.id}: SHA-256 is ${got}, the manifest says ${item.sha256} (file kept for inspection: ${rel(path)})`);
      else if (item.bytes && statSync(path).size !== item.bytes) bad.push(`${item.id}: ${statSync(path).size} bytes, the manifest says ${item.bytes}`);
    }
  }
  if (bad.length) {
    fail(STEP, ['INPUT CHECK FAILED. Nothing was compared: these are not engine differences.', ...bad.map((m) => `  ${m}`), 'A fetched PDF that no longer matches its SHA-256 has changed upstream: replace it deliberately in the manifest and approve it with `pnpm golden:record -- --approve <id>:*`.']);
  }
}

// ---- 2. PNG files (pictures stay in test-assets/, git-ignored) ------------------------------------------------------

function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/** An RGB picture (3 bytes a pixel) as a PNG. */
function encodePng(rgb, w, h) {
  const rows = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    rows[y * (w * 3 + 1)] = 0; // filter type 0 (none)
    Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(rows, y * (w * 3 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(rows, { level: 3 })), pngChunk('IEND', Buffer.alloc(0))]);
}

/** Reads back a PNG written by encodePng (RGB, 8 bits, filter 0 only). */
function decodePng(buf) {
  let off = 8;
  let w = 0;
  let h = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 2) throw new Error('not an RGB 8-bit PNG');
    } else if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    if (raw[y * (w * 3 + 1)] !== 0) throw new Error('unsupported PNG filter');
    rgb.set(raw.subarray(y * (w * 3 + 1) + 1, (y + 1) * (w * 3 + 1)), y * w * 3);
  }
  return { rgb, w, h };
}

/** after, faded, with every differing pixel painted red. Returns the picture and the number of differing pixels. */
function diffPicture(before, after) {
  const out = new Uint8Array(after.rgb.length);
  let differing = 0;
  for (let p = 0; p < after.w * after.h; p++) {
    const i = p * 3;
    if (before.rgb[i] !== after.rgb[i] || before.rgb[i + 1] !== after.rgb[i + 1] || before.rgb[i + 2] !== after.rgb[i + 2]) {
      differing++;
      out[i] = 230;
      out[i + 1] = 30;
      out[i + 2] = 30;
    } else {
      for (let c = 0; c < 3; c++) out[i + c] = 191 + (after.rgb[i + c] >> 2); // 75% white, 25% picture
    }
  }
  return { rgb: out, differing };
}

// ---- 3. the hashes of a render --------------------------------------------------------------------------------------

/** Luminance times 1000, an integer (Rec. 601 weights), so equal pixels give equal sums exactly. */
function luma(rgb, w, h) {
  const y = new Int32Array(w * h);
  for (let p = 0; p < w * h; p++) y[p] = 299 * rgb[p * 3] + 587 * rgb[p * 3 + 1] + 114 * rgb[p * 3 + 2];
  return y;
}

/** The picture averaged into a tw x th grid (cells on integer pixel boundaries, at least one pixel each). */
function grid(y, w, h, tw, th) {
  const out = new Float64Array(tw * th);
  for (let ty = 0; ty < th; ty++) {
    const y0 = Math.floor((ty * h) / th);
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * h) / th));
    for (let tx = 0; tx < tw; tx++) {
      const x0 = Math.floor((tx * w) / tw);
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * w) / tw));
      let sum = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) sum += y[yy * w + xx];
      out[ty * tw + tx] = Math.round(sum / ((y1 - y0) * (x1 - x0)));
    }
  }
  return out;
}

const hex64 = (bits) => bits.reduce((acc, b) => (acc << 1n) | (b ? 1n : 0n), 0n).toString(16).padStart(16, '0');

/** dHash: a 9 x 8 grid, one bit per neighbouring pair of a row: left brighter than right. */
function dHash(y, w, h) {
  const g = grid(y, w, h, 9, 8);
  const bits = [];
  for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) bits.push(g[row * 9 + col] > g[row * 9 + col + 1]);
  return hex64(bits);
}

const COS = Array.from({ length: 8 }, (_, u) => Array.from({ length: 32 }, (_, x) => Math.cos(((2 * x + 1) * u * Math.PI) / 64)));

/** pHash: the 8 x 8 lowest frequencies of the 32 x 32 DCT, one bit each: above the median of them (the DC term left out). */
function pHash(y, w, h) {
  const g = grid(y, w, h, 32, 32);
  const rows = Array.from({ length: 32 }, () => new Float64Array(8));
  for (let r = 0; r < 32; r++) for (let u = 0; u < 8; u++) {
    let s = 0;
    for (let x = 0; x < 32; x++) s += g[r * 32 + x] * COS[u][x];
    rows[r][u] = s;
  }
  const coef = [];
  for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) {
    let s = 0;
    for (let r = 0; r < 32; r++) s += rows[r][u] * COS[v][r];
    coef.push(Math.round(s * 100) / 100); // rounded, so a white page's rounding noise cannot flip a bit
  }
  const ac = coef.slice(1).sort((a, b) => a - b);
  const median = ac[Math.floor(ac.length / 2)];
  return hex64(coef.map((c) => c > median));
}

/** SHA-256 of the picture averaged down by EXACT_DOWNSAMPLE in each direction (whole numbers, edge cells smaller). */
function exactHash(rgb, w, h) {
  const k = EXACT_DOWNSAMPLE;
  const ow = Math.ceil(w / k);
  const oh = Math.ceil(h / k);
  const out = Buffer.alloc(ow * oh * 3);
  for (let oy = 0; oy < oh; oy++) for (let ox = 0; ox < ow; ox++) {
    const x1 = Math.min(w, (ox + 1) * k);
    const y1 = Math.min(h, (oy + 1) * k);
    const n = (x1 - ox * k) * (y1 - oy * k);
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let yy = oy * k; yy < y1; yy++) for (let xx = ox * k; xx < x1; xx++) sum += rgb[(yy * w + xx) * 3 + c];
      out[(oy * ow + ox) * 3 + c] = Math.floor((sum + (n >> 1)) / n);
    }
  }
  return sha256(Buffer.concat([Buffer.from(`${w}x${h}:`), out]));
}

const popcount = (hexA, hexB) => {
  let x = BigInt(`0x${hexA}`) ^ BigInt(`0x${hexB}`);
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
};

// ---- 4. the engine --------------------------------------------------------------------------------------------------

// The Node stand-ins renderBitmap needs: it builds an ImageData and turns it into an ImageBitmap; here both are just the pixels.
globalThis.ImageData ??= class ImageData {
  constructor(data, width, height) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
};
globalThis.createImageBitmap = (image) => Promise.resolve(image);

const viewerRequire = createRequire(join(repoRoot, 'packages/viewer/package.json'));

/** The folder of an installed package: walk up from its entry point to the package.json naming it. */
function packageRoot(name) {
  let dir = dirname(viewerRequire.resolve(name));
  for (;;) {
    try {
      if (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name === name) return dir;
    } catch {
      // no package.json here: keep walking up
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
  const { init } = viewerRequire('@embedpdf/pdfium');
  const { SopPdfiumNative } = await server.ssrLoadModule('/packages/viewer/src/backend/embedpdf/sop-native.ts');
  const { installBundledFonts } = await server.ssrLoadModule('/packages/viewer/src/backend/embedpdf/fonts.ts');
  const files = JSON.parse(readFileSync(join(repoRoot, 'packages/viewer/src/backend/embedpdf/engine-files.json'), 'utf8'));
  const wasmPath = join(packageRoot(files.wasm.package), files.wasm.from);
  const wasm = readFileSync(wasmPath);
  const module = await init({ wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength), printErr: () => {} });
  // What engine.worker.ts start() does: the engine first (it starts PDFium), then the fonts, before any document opens.
  // The worker reads its fonts over the network from the extension; here the loader reads the same files from the packages.
  const native = new SopPdfiumNative(module);
  const fontPaths = new Map(files.fonts.map((f) => [f.file, join(packageRoot(f.package), f.from)]));
  installBundledFonts(module, 'sop-engine://pdf', (url) => {
    const path = fontPaths.get(basename(url));
    return path ? new Uint8Array(readFileSync(path)) : null;
  });
  const versions = { pdfium: JSON.parse(readFileSync(join(packageRoot('@embedpdf/pdfium'), 'package.json'), 'utf8')).version, engines: JSON.parse(readFileSync(join(packageRoot('@embedpdf/engines'), 'package.json'), 'utf8')).version };
  return { native, module, server, versions };
}

// ---- 5. measuring a page --------------------------------------------------------------------------------------------

const round1 = (v) => Math.round(v * 10) / 10 + 0; // + 0 turns -0 into 0
const asRects = (rects) => rects.map((r) => [round1(r.x), round1(r.y), round1(r.width), round1(r.height)]);

/** Three ranges of RANGE_CHARS chars: the start of the page, its middle, and one across the first line break after a quarter of the page. */
function pickRanges(raw) {
  const n = raw.length;
  if (n === 0) return [];
  const take = (start) => {
    const s = Math.max(0, Math.min(start, n - 1));
    return { start: s, count: Math.min(RANGE_CHARS, n - s) };
  };
  let brk = raw.indexOf('\n', Math.floor(n / 4));
  if (brk < 0) brk = raw.indexOf('\n');
  if (brk < 0) brk = Math.floor((3 * n) / 4);
  const ranges = [take(0), take(Math.floor(n / 2) - RANGE_CHARS / 2), take(brk - RANGE_CHARS / 2)];
  return ranges.filter((r, k) => ranges.findIndex((o) => o.start === r.start && o.count === r.count) === k); // a short page has fewer
}

class Measurer {
  constructor(engine, item) {
    this.native = engine.native;
    this.module = engine.module;
    this.id = `golden-${item.id}`;
  }

  open(bytes) {
    return this.native.openDocument(this.id, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  }

  close() {
    this.native.closeDoc(this.id);
  }

  /** FPDFText_CountChars, asked of PDFium directly on the engine's own text page, not of getPageChars. */
  countChars(i) {
    return this.native.withTextPage(this.id, i, (textPage) => this.module.pdfium.wasmExports.FPDFText_CountChars(textPage));
  }

  text(i) {
    const raw = this.native.getPageChars(this.id, i);
    return { raw, text: this.native.getPageText(this.id, i), counted: this.countChars(i) };
  }

  rects(i, ranges) {
    return ranges.map((r) => ({ start: r.start, count: r.count, rects: asRects(this.native.getTextRangeRects(this.id, i, r.start, r.count)) }));
  }

  async render(i) {
    const bmp = await this.native.renderBitmap(this.id, { pageIndex: i, scale: SCALE, viewRotation: 0, withAnnotations: true });
    const { width: w, height: h, data } = bmp;
    const rgb = new Uint8Array(w * h * 3);
    for (let p = 0; p < w * h; p++) {
      const a = data[p * 4 + 3];
      for (let c = 0; c < 3; c++) rgb[p * 3 + c] = a === 255 ? data[p * 4 + c] : Math.round((data[p * 4 + c] * a + 255 * (255 - a)) / 255); // over white
    }
    const y = luma(rgb, w, h);
    return { rgb, record: { w, h, dhash: dHash(y, w, h), phash: pHash(y, w, h), exact: exactHash(rgb, w, h) } };
  }
}

// ---- 6. comparing a page with the baseline --------------------------------------------------------------------------

/** What differs between the baseline's page and the measured one: a list of { kind, text }. */
function comparePage(base, now) {
  const out = [];
  if (base.text !== now.text) out.push({ kind: 'text', text: `getPageText changed (${base.textLen} -> ${now.textLen} chars)` });
  if (base.chars !== now.chars) out.push({ kind: 'chars', text: `getPageChars changed (${base.charCount} -> ${now.charCount} chars)` });
  if (base.charCount !== now.charCount && base.chars === now.chars) out.push({ kind: 'chars', text: `char count changed (${base.charCount} -> ${now.charCount})` });
  const moved = [];
  base.ranges.forEach((b, k) => {
    const n = now.ranges[k];
    const same = n && b.rects.length === n.rects.length && b.rects.every((r, j) => r.every((v, m) => v === n.rects[j][m]));
    if (same) return;
    const worst = n && b.rects.length === n.rects.length ? Math.max(...b.rects.map((r, j) => Math.max(...r.map((v, m) => Math.abs(v - n.rects[j][m]))))) : null;
    moved.push(`chars ${b.start}+${b.count}: ${n ? `${b.rects.length} -> ${n.rects.length} rects` : 'no rects now'}${worst === null ? '' : `, largest move ${worst.toFixed(1)} pt`}`);
  });
  if (moved.length) out.push({ kind: 'rects', text: `selection rects changed in ${moved.length} of ${base.ranges.length} ranges (${moved.join('; ')})` });
  const b = base.render;
  const r = now.render;
  const dd = popcount(b.dhash, r.dhash);
  const pd = popcount(b.phash, r.phash);
  const exactDiffers = b.exact !== r.exact;
  const overThreshold = dd > PERCEPTUAL_THRESHOLD || pd > PERCEPTUAL_THRESHOLD;
  if (exactDiffers || overThreshold) {
    const size = b.w !== r.w || b.h !== r.h ? `, size ${b.w}x${b.h} -> ${r.w}x${r.h}` : '';
    out.push({
      kind: 'render',
      dd, pd, exactDiffers, overThreshold,
      text: `${overThreshold ? 'visibly different' : 'pixels differ'}: perceptual distance dHash ${dd}/64, pHash ${pd}/64 (limit ${PERCEPTUAL_THRESHOLD}); exact hash ${exactDiffers ? 'differs' : 'matches'}${size}`,
    });
  }
  return out;
}

// ---- 7. the picture cache: the baseline's own renders, for "before" pictures ----------------------------------------

const cachePng = (id, page, exact) => join(cacheDir, id, `p${String(page).padStart(4, '0')}.${exact.slice(0, 16)}.png`);
const cacheChars = (id, page, hash) => join(cacheDir, id, `p${String(page).padStart(4, '0')}.${hash.slice(0, 16)}.chars.json`);

/** Keeps a picture and the chars of a page whose hashes are the baseline's, so a later difference can be shown against them. */
function remember(id, page, rec, rgb, raw) {
  mkdirSync(join(cacheDir, id), { recursive: true });
  const prefix = `p${String(page).padStart(4, '0')}.`;
  const png = cachePng(id, page, rec.render.exact);
  const chars = cacheChars(id, page, rec.chars);
  for (const f of readdirSync(join(cacheDir, id))) {
    const full = join(cacheDir, id, f);
    if (f.startsWith(prefix) && full !== png && full !== chars) rmSync(full, { force: true });
  }
  if (!existsSync(png)) writeFileSync(png, encodePng(rgb, rec.render.w, rec.render.h));
  if (!existsSync(chars)) writeFileSync(chars, JSON.stringify(raw));
}

/** The first place two strings differ, with a little of each around it. */
function firstDifference(before, after) {
  let i = 0;
  while (i < before.length && i < after.length && before[i] === after[i]) i++;
  const show = (s) => JSON.stringify(s.slice(Math.max(0, i - 12), i + 24));
  return `first difference at char ${i}: before ${show(before)}, after ${show(after)}`;
}

// ---- 8. running a document ------------------------------------------------------------------------------------------

/**
 * Opens one PDF and measures its covered pages. For each page it calls `onPage({ page, measured, rgb, raw })` where `measured`
 * is the baseline-shaped record, built with `rangesFor(page)` (the baseline's ranges, or fresh ones when there are none).
 */
async function walk(engine, item, rangesFor, onPage) {
  const m = new Measurer(engine, item);
  const bytes = readFileSync(pathOf(item));
  let opened;
  try {
    opened = m.open(bytes);
  } catch (err) {
    fail(STEP, [`${item.id}: the engine cannot open ${rel(pathOf(item))}: ${err instanceof Error ? err.message : err}`]);
  }
  try {
    const pages = coveredPages(opened.pageCount);
    await onPage({ doc: true, pageCount: opened.pageCount, pages });
    for (const page of pages) {
      const i = page - 1;
      const t = m.text(i);
      const ranges = rangesFor(page, t.raw);
      const { rgb, record: render } = await m.render(i).catch((err) => fail(STEP, [`${item.id} p${page}: render failed: ${err instanceof Error ? err.message : err}`]));
      const measured = {
        textLen: t.text.length, text: sha256(t.text),
        charCount: t.raw.length, chars: sha256(t.raw),
        ranges: m.rects(i, ranges), render,
      };
      await onPage({ page, measured, rgb, raw: t.raw, counted: t.counted, again: (r) => m.rects(i, r) });
    }
  } finally {
    m.close();
  }
}

// ---- check ----------------------------------------------------------------------------------------------------------

async function check() {
  if (!baseline) fail(STEP, ['golden:check: no baseline yet (e2e/reference/engine/baseline.json). Record one with `pnpm golden:record -- --all`.']);
  const started = performance.now();
  if (flag('list')) {
    for (const item of items) {
      const b = baseline.pdfs[item.id];
      console.log(`${pad(item.id, 18)}${pad(b ? `${b.pageCount} pages` : 'no baseline', 12)}${pad(b ? `${Object.keys(b.pages).length} covered` : '', 13)}${item.covers}`);
    }
    return;
  }
  verifyInputs(items);
  rmSync(diffDir, { recursive: true, force: true });
  const engine = await startEngine();
  const report = []; // { id, page, changes: [{kind, text, files?}] }
  const docChanges = [];
  let pagesChecked = 0;
  const sections = [];
  try {
    for (const item of items) {
      const t0 = performance.now();
      const base = baseline.pdfs[item.id];
      if (!base) {
        docChanges.push({ id: item.id, text: 'has no baseline. Record it with `pnpm golden:record -- --approve ' + item.id + ':*`' });
        continue;
      }
      if (base.sha256 !== (item.sha256 ?? null)) docChanges.push({ id: item.id, text: `the baseline was recorded for another file (SHA-256 ${base.sha256 ?? 'none'}, the manifest now says ${item.sha256 ?? 'none'}): approve it with \`pnpm golden:record -- --approve ${item.id}:*\`` });
      let covered = 0;
      await walk(engine, item, (page, raw) => base.pages[page]?.ranges ?? pickRanges(raw), async (ev) => {
        if (ev.doc) {
          if (ev.pageCount !== base.pageCount) docChanges.push({ id: item.id, text: `page count changed (${base.pageCount} -> ${ev.pageCount})` });
          const gone = Object.keys(base.pages).map(Number).filter((p) => !ev.pages.includes(p));
          if (gone.length) docChanges.push({ id: item.id, text: `baseline pages no longer covered: ${gone.join(', ')}` });
          return;
        }
        const { page, measured, rgb, raw, counted } = ev;
        covered++;
        pagesChecked++;
        const changes = [];
        if (raw.length !== counted) changes.push({ kind: 'integrity', text: `getPageChars has ${raw.length} units but FPDFText_CountChars says ${counted}` });
        const prior = base.pages[page];
        if (!prior) changes.push({ kind: 'missing', text: 'has no baseline (a new covered page)' });
        else {
          const diffs = comparePage(prior, measured);
          changes.push(...diffs);
          const renderChange = diffs.find((d) => d.kind === 'render');
          if (renderChange) {
            const files = writeDiff(item.id, page, prior.render, measured.render, rgb);
            renderChange.files = files;
          }
          const charsChange = diffs.find((d) => d.kind === 'chars');
          if (charsChange && existsSync(cacheChars(item.id, page, prior.chars))) {
            charsChange.text += `; ${firstDifference(JSON.parse(readFileSync(cacheChars(item.id, page, prior.chars), 'utf8')), raw)}`;
          }
          if (!diffs.some((d) => d.kind === 'render' || d.kind === 'chars')) remember(item.id, page, prior, rgb, raw);
        }
        if (changes.length) report.push({ id: item.id, page, changes });
      });
      for (const p of Object.keys(base.pages)) if (!coveredPages(base.pageCount).includes(Number(p))) docChanges.push({ id: item.id, text: `baseline lists page ${p}, which a ${base.pageCount}-page document does not cover` });
      sections.push(`${pad(item.id, 24)}${pad(`${covered} pages`, 11)}${secs(performance.now() - t0)}`);
    }
    const orphans = onlyIds ? [] : Object.keys(baseline.pdfs).filter((id) => !manifest.items.some((i) => i.id === id));
    for (const id of orphans) docChanges.push({ id, text: 'is in baseline.json but not in the manifest (remove it by hand, or restore the manifest entry)' });
  } finally {
    await engine.server.close();
  }

  console.log(sections.join('\n'));
  const total = secs(performance.now() - started);
  const pagesChanged = report.length;
  const jsonOut = opt('json');
  if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify({ pdfs: items.length, pagesChecked, docChanges, pages: report }, null, 2)}\n`);
  if (!report.length && !docChanges.length) {
    console.log(`\ngolden:check PASS. ${items.length} PDFs, ${pagesChecked} pages, no differences (${total}).`);
    return;
  }
  console.log('\ngolden:check FAIL. Differences from the baseline:\n');
  for (const d of docChanges) console.log(`  ${d.id}: ${d.text}`);
  let last = '';
  for (const r of report) {
    if (r.id !== last) console.log(`\n  ${r.id}`);
    last = r.id;
    console.log(`    page ${r.page}`);
    for (const c of r.changes) {
      console.log(`      ${c.kind}: ${c.text}`);
      if (c.files) for (const f of c.files) console.log(`        ${f}`);
    }
  }
  console.log('\nSummary (pdf: pages, what changed):');
  for (const d of docChanges) console.log(`  ${pad(d.id, 18)}document: ${d.text}`);
  for (const id of [...new Set(report.map((r) => r.id))]) {
    const mine = report.filter((r) => r.id === id);
    console.log(`  ${pad(id, 18)}pages ${mine.map((r) => r.page).join(', ')}: ${[...new Set(mine.flatMap((r) => r.changes.map((c) => c.kind)))].join(', ')}`);
  }
  console.log(`\n${pagesChanged} page(s) differ in ${new Set(report.map((r) => r.id)).size} PDF(s)${docChanges.length ? `; ${docChanges.length} document-level problem(s)` : ''} (${total}).`);
  if (report.some((r) => r.changes.some((c) => c.files))) console.log(`Pictures: ${rel(diffDir)}/ (<pdf>-p<page>-before.png, -after.png, -diff.png; the diff paints changed pixels red).`);
  console.log('Look at them, then either fix the code or approve the change: `pnpm golden:record -- --approve <pdf:page,...>`.');
  process.exitCode = 1;
}

/** Writes before / after / diff PNGs of a changed render; returns the lines to print. */
function writeDiff(id, page, baseRender, nowRender, rgb) {
  mkdirSync(diffDir, { recursive: true });
  const stem = join(diffDir, `${id}-p${page}`);
  writeFileSync(`${stem}-after.png`, encodePng(rgb, nowRender.w, nowRender.h));
  const beforePath = cachePng(id, page, baseRender.exact);
  if (!existsSync(beforePath)) {
    return [`after: ${rel(`${stem}-after.png`)}`, 'before: not available (no baseline picture on this machine yet: a run that matches the baseline keeps one)'];
  }
  const before = decodePng(readFileSync(beforePath));
  writeFileSync(`${stem}-before.png`, readFileSync(beforePath));
  const files = [`before: ${rel(`${stem}-before.png`)}`, `after:  ${rel(`${stem}-after.png`)}`];
  if (before.w === nowRender.w && before.h === nowRender.h) {
    const d = diffPicture(before, { rgb, w: nowRender.w, h: nowRender.h });
    writeFileSync(`${stem}-diff.png`, encodePng(d.rgb, nowRender.w, nowRender.h));
    files.push(`diff:   ${rel(`${stem}-diff.png`)} (${d.differing} of ${nowRender.w * nowRender.h} pixels differ, ${((100 * d.differing) / (nowRender.w * nowRender.h)).toFixed(2)}%)`);
  } else files.push('diff:   none (the page size changed)');
  return files;
}

// ---- record ---------------------------------------------------------------------------------------------------------

/** "paper-50:1,2" is not valid; entries are pdf:page, pdf:first-last or pdf:*, separated by commas. */
function parseApprove(text) {
  const wanted = new Map(); // id -> { all: bool, pages: Set }
  for (const entry of text.split(',').filter(Boolean)) {
    const m = /^([a-z0-9][a-z0-9-]*):(\*|\d+(?:-\d+)?)$/.exec(entry);
    if (!m) fail(STEP, [`--approve: "${entry}" is not pdf:page, pdf:first-last or pdf:*  (for example paper-50:1-2,resnet:*)`]);
    if (!manifest.items.some((i) => i.id === m[1])) fail(STEP, [`--approve: no PDF "${m[1]}" in the manifest`]);
    const w = wanted.get(m[1]) ?? { all: false, pages: new Set() };
    if (m[2] === '*') w.all = true;
    else {
      const [a, b = a] = m[2].split('-').map(Number);
      if (b < a) fail(STEP, [`--approve: "${entry}" runs backwards`]);
      for (let p = a; p <= b; p++) w.pages.add(p);
    }
    wanted.set(m[1], w);
  }
  return wanted;
}

async function record() {
  const approveText = opt('approve');
  const all = flag('all');
  if (all && approveText) fail(STEP, ['golden:record: use --all or --approve, not both.']);
  if (!all && !approveText) fail(STEP, ['golden:record: say what to record.', '  --approve <pdf:page,...>   re-record the named pages (pdf:5, pdf:5-8, pdf:*)', '  --all                      first baseline only: records every PDF']);
  if (all && baseline) {
    fail(STEP, ['golden:record: --all is only for the first baseline, and e2e/reference/engine/baseline.json already exists.', 'Look at `pnpm golden:check`, then name what you approve: `pnpm golden:record -- --approve <pdf:page,...>`.']);
  }
  const wanted = all ? new Map(items.map((i) => [i.id, { all: true, pages: new Set() }])) : parseApprove(approveText);
  const toRun = items.filter((i) => wanted.has(i.id));
  if (onlyIds) for (const id of wanted.keys()) if (!onlyIds.includes(id)) fail(STEP, [`--approve names ${id}, which --pdfs leaves out.`]);
  verifyInputs(toRun);

  const next = baseline ?? { version: 1, pdfs: {} };
  const engine = await startEngine();
  const summary = [];
  try {
    for (const item of toRun) {
      const w = wanted.get(item.id);
      const base = next.pdfs[item.id] ?? null;
      // --approve pdf:* writes the whole document afresh; a few pages leave every other page of the old entry as it was.
      const entry = w.all || !base ? { sha256: item.sha256 ?? null, pageCount: 0, pages: {} } : { sha256: base.sha256, pageCount: base.pageCount, pages: { ...base.pages } };
      let covered = [];
      await walk(engine, item, (page, raw) => base?.pages[page]?.ranges ?? pickRanges(raw), async (ev) => {
        if (ev.doc) {
          covered = ev.pages;
          if (w.all || !base) entry.pageCount = ev.pageCount;
          for (const p of w.pages) if (!ev.pages.includes(p)) fail(STEP, [`--approve ${item.id}:${p}: page ${p} is not one of the ${ev.pages.length} pages covered in this ${ev.pageCount}-page document.`]);
          return;
        }
        const { page, measured, rgb, raw, counted, again } = ev;
        if (raw.length !== counted) fail(STEP, [`${item.id} p${page}: getPageChars has ${raw.length} units but FPDFText_CountChars says ${counted}. A page like that cannot be recorded; fix the engine.`]);
        if (!w.all && !w.pages.has(page)) return;
        // The summary compares with the old ranges; the stored record uses ranges chosen from the page as it is now.
        const prior = base?.pages[page];
        const diffs = prior ? comparePage(prior, measured) : [];
        const fresh = pickRanges(raw);
        const same = JSON.stringify(fresh.map((r) => [r.start, r.count])) === JSON.stringify(measured.ranges.map((r) => [r.start, r.count]));
        const stored = { ...measured, ranges: same ? measured.ranges : again(fresh) };
        entry.pages[page] = stored;
        remember(item.id, page, stored, rgb, raw);
        summary.push(`  ${pad(`${item.id}:${page}`, 28)}${!prior ? 'added' : diffs.length ? `re-recorded (${[...new Set(diffs.map((d) => d.kind))].join(', ')})` : 'unchanged'}`);
      });
      if (w.all && base) {
        if (base.pageCount !== entry.pageCount) summary.push(`  ${pad(`${item.id}:doc`, 28)}page count ${base.pageCount} -> ${entry.pageCount}`);
        const gone = Object.keys(base.pages).map(Number).filter((p) => !covered.includes(p));
        if (gone.length) summary.push(`  ${pad(`${item.id}:doc`, 28)}pages no longer covered, dropped: ${gone.join(', ')}`);
      }
      next.pdfs[item.id] = entry;
    }
    next.note = 'Engine reference baseline (Gate 2). Hashes and numbers only; see README.md. Written by `pnpm golden:record`.';
    next.render = { dpi: DPI, withAnnotations: true, perceptualThreshold: PERCEPTUAL_THRESHOLD, exactDownsample: EXACT_DOWNSAMPLE, sampleWhenOver: FULL_UP_TO, sample: `pages 1-${SAMPLE_EDGE}, the last ${SAMPLE_EDGE}, every ${SAMPLE_EVERY}th` };
    next.engine = { recordedWith: engine.versions };
  } finally {
    await engine.server.close();
  }
  // Order the document entries as in the manifest, so the file reads the same every time.
  const ordered = {};
  for (const i of manifest.items) if (next.pdfs[i.id]) ordered[i.id] = next.pdfs[i.id];
  next.pdfs = ordered;
  writeFileSync(baselinePath, serialise(next));
  console.log(summary.join('\n'));
  console.log(`\ngolden:record: wrote ${rel(baselinePath)} (${Object.keys(next.pdfs).length} PDFs, ${Object.values(next.pdfs).reduce((n, p) => n + Object.keys(p.pages).length, 0)} pages).`);
}

/** JSON with one line per page, so a re-recorded page is one changed line in git. */
function serialise(b) {
  const lines = ['{'];
  const head = Object.entries(b).filter(([k]) => k !== 'pdfs').map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  lines.push(`${head.join(',\n')},`, '  "pdfs": {');
  const docs = Object.entries(b.pdfs).map(([id, d]) => {
    const pages = Object.keys(d.pages).map(Number).sort((x, y) => x - y).map((p) => `      "${p}": ${JSON.stringify(d.pages[p])}`);
    return `    ${JSON.stringify(id)}: {\n      "sha256": ${JSON.stringify(d.sha256)},\n      "pageCount": ${d.pageCount},\n      "pages": {\n${pages.map((l) => `  ${l}`).join(',\n')}\n      }\n    }`;
  });
  lines.push(docs.join(',\n'), '  }', '}', '');
  return lines.join('\n');
}

if (mode === 'check') await check();
else await record();

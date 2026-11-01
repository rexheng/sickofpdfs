// P0-4: a pdf.js-style text layer fed with PDFium glyph boxes, over the page's PDFium render.
//   spike.html?check=textlayer&file=<url>&page=<index>&zoom=<1 = 100%>[&snap=0]
// Builds items with buildTextItems at zoom × 96/72 CSS px per point, renders them with TextLayer and turns on
// glyph-inclusive drag selection (snap=0 leaves the browser's own selection ends, for comparison). The test
// drives the real mouse and reads the page through window.__tl:
//   glyphCenter(i)  client point at the centre of char i's PDFium box (a ligature share for "ffi" and the like)
//   selection()     { ranges: charRangeFromDomRange(root, selection range), domText: Selection.toString() }
//   textRange(s, c) PDFium's text for chars [s, s + c)
//   selectAll()     Selection.toString() of a selection of the whole layer
//   alignment()     every shown char's DOM rect against its PDFium box, in client px
//   runDirs()       the dir of every span
//   columnTargets() the middle glyphs of column 1's bottom line and column 2's top line
// The result: counts, timings, layout (client px) and `endpoints`, the chars a drag may start or end on.
import { createFileWorkerEngine } from '../engine/client';
import type { PageGlyphs, Rect } from '../engine/spike-native';
import { charRangeFromDomRange, enableGlyphSelection } from '../textlayer/char-map';
import { buildTextItems, cssFont, direction, glyphUnits, type GlyphUnit } from '../textlayer/items';
import { bindTextLayer, installTextLayerStyles, loadTextLayerFont, TextLayer } from '../textlayer/text-layer';
import { withTimeout } from './render';

declare const chrome: { runtime: { getURL(path: string): string } };

const PT_TO_CSS = 96 / 72;
const MARGIN = 16;
const STEP_TIMEOUT_MS = 20_000;
const ms = (a: number, b: number) => Math.round((b - a) * 10) / 10;
const round = (n: number) => Math.round(n * 1000) / 1000;

export async function run(params: URLSearchParams) {
  const file = params.get('file') ?? '';
  const pageIndex = Number(params.get('page') ?? 0);
  const zoom = Number(params.get('zoom') ?? 1);
  const snap = params.get('snap') !== '0';
  installTextLayerStyles();
  const hideRunnerOutput = document.createElement('style');
  hideRunnerOutput.textContent = 'body > pre { display: none; }'; // the runner prints __result; keep it out of selections
  document.head.append(hideRunnerOutput);

  const t0 = performance.now();
  await withTimeout(loadTextLayerFont(chrome.runtime.getURL('pdf/NotoSans-Regular.ttf')), STEP_TIMEOUT_MS, 'text-layer font');
  const engine = await withTimeout(createFileWorkerEngine(), STEP_TIMEOUT_MS, 'engine start');
  const doc = await withTimeout(engine.open(file), STEP_TIMEOUT_MS, 'open');
  const pageInfo = doc.pages[pageIndex];
  if (!pageInfo) throw new Error(`page ${pageIndex} out of range (${doc.pageCount} pages)`);
  const tOpen = performance.now();
  const glyphs = await withTimeout(engine.call<PageGlyphs>('getGlyphs', doc.docId, pageIndex), STEP_TIMEOUT_MS, 'getGlyphs');
  const tGlyphs = performance.now();

  const rotation = pageInfo.rotation;
  const turned = rotation % 180 !== 0;
  const pageWidth = turned ? pageInfo.height : pageInfo.width; // unrotated, points
  const pageHeight = turned ? pageInfo.width : pageInfo.height;
  const scale = zoom * PT_TO_CSS;

  // buildTextItems' measurer: like the spans, no kerning and no ligatures (optimizeSpeed drops them in canvas).
  const ctx = document.createElement('canvas').getContext('2d')!;
  ctx.fontKerning = 'none';
  ctx.textRendering = 'optimizeSpeed';
  let ctxFont = '';
  let measures = 0;
  const measure = (text: string, font: string) => {
    measures++;
    if (font !== ctxFont) ctx.font = ctxFont = font;
    return ctx.measureText(text).width;
  };
  const items = buildTextItems(glyphs, measure, scale);
  const tItems = performance.now();

  // The page: PDFium's render under the text layer, at (MARGIN, MARGIN), as displayed (after /Rotate).
  const root = document.createElement('div');
  root.id = 'viewer';
  const pageDiv = document.createElement('div');
  const shownWidth = (turned ? pageHeight : pageWidth) * scale;
  const shownHeight = (turned ? pageWidth : pageHeight) * scale;
  pageDiv.style.cssText = `position:absolute;left:${MARGIN}px;top:${MARGIN}px;width:${shownWidth}px;height:${shownHeight}px;box-shadow:0 0 0 1px #ccc;`;
  const bitmap = await withTimeout(engine.render(doc.docId, pageIndex, scale * devicePixelRatio), STEP_TIMEOUT_MS, 'render');
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.style.cssText = `position:absolute;left:0;top:0;width:${shownWidth}px;height:${shownHeight}px;margin:0;border:0;`;
  canvas.getContext('bitmaprenderer')!.transferFromImageBitmap(bitmap);
  const layer = document.createElement('div');
  layer.className = 'textLayer';
  layer.dataset.pageIndex = String(pageIndex);
  pageDiv.append(canvas, layer);
  root.append(pageDiv);
  document.body.append(root);
  const tRender = performance.now();
  new TextLayer({ items, container: layer, viewport: { scale, rotation, pageWidth, pageHeight } }).render();
  bindTextLayer(layer);
  if (snap) enableGlyphSelection(root);
  const tLayer = performance.now();

  // Units: chars as the layer sees them (surrogate pairs joined, ligature boxes split equally).
  const units = glyphUnits(glyphs);
  const unitOf = new Map<number, GlyphUnit>();
  for (const u of units) for (let i = u.start; i < u.end; i++) unitOf.set(i, u);
  const spanStarts = [...layer.querySelectorAll<HTMLElement>('span[data-start]')].map((s) => ({ span: s, start: Number(s.dataset.start), length: s.textContent!.length }));
  const spanOf = (charIndex: number) => spanStarts.find((s) => charIndex >= s.start && charIndex < s.start + s.length);

  /** Unrotated CSS px on the page → client px, through the page's /Rotate. */
  const toClient = (x: number, y: number) => {
    const o = pageDiv.getBoundingClientRect();
    const W = pageWidth * scale;
    const H = pageHeight * scale;
    const [dx, dy] = rotation === 90 ? [H - y, x] : rotation === 180 ? [W - x, H - y] : rotation === 270 ? [y, W - x] : [x, y];
    return { x: o.left + dx, y: o.top + dy };
  };
  const clientBox = (r: Rect) => {
    const pts = [
      toClient(r.x * scale, r.y * scale),
      toClient((r.x + r.width) * scale, (r.y + r.height) * scale),
    ];
    return { left: Math.min(pts[0]!.x, pts[1]!.x), right: Math.max(pts[0]!.x, pts[1]!.x), top: Math.min(pts[0]!.y, pts[1]!.y), bottom: Math.max(pts[0]!.y, pts[1]!.y) };
  };
  const shown = (u: GlyphUnit) => spanOf(u.start) !== undefined;
  const endpoints = units
    .filter((u) => u.box && !u.generated && !u.hyphen && u.end - u.start === 1 && u.text.trim() !== '' && shown(u))
    .map((u) => u.start);

  const tl = {
    glyphCenter(i: number) {
      const box = unitOf.get(i)?.box;
      if (!box) throw new Error(`char ${i} has no box`);
      const b = clientBox(box);
      return { x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 };
    },
    selection() {
      const sel = document.getSelection();
      if (!sel || sel.rangeCount === 0) return { ranges: [], domText: '' };
      return { ranges: charRangeFromDomRange(root, sel.getRangeAt(0)), domText: sel.toString() };
    },
    textRange: (start: number, count: number) => engine.call<string>('getTextRange', doc.docId, pageIndex, start, count),
    selectAll() {
      const r = document.createRange();
      r.selectNodeContents(layer);
      const sel = document.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(r);
      return sel.toString();
    },
    alignment() {
      const errors: number[] = [];
      let maxEdge = 0;
      let minOverlap = Infinity;
      let worst = '';
      let worstOverlap = '';
      let unshown = 0;
      const r = document.createRange();
      for (const u of units) {
        if (!u.box || u.generated) continue;
        const s = spanOf(u.start);
        const node = s?.span.firstChild;
        if (!s || !(node instanceof Text)) {
          unshown++;
          continue;
        }
        r.setStart(node, u.start - s.start);
        r.setEnd(node, u.end - s.start);
        const dom = r.getBoundingClientRect();
        const pdf = clientBox(u.box);
        const turnedText = Math.abs(direction((u.angle + rotation) % 360)[1]) > 0.5; // displayed text runs vertically
        const [d0, d1, p0, p1] = turnedText ? [dom.top, dom.bottom, pdf.top, pdf.bottom] : [dom.left, dom.right, pdf.left, pdf.right];
        const [c0, c1, q0, q1] = turnedText ? [dom.left, dom.right, pdf.left, pdf.right] : [dom.top, dom.bottom, pdf.top, pdf.bottom];
        const edge = Math.max(Math.abs(d0 - p0), Math.abs(d1 - p1));
        const overlap = Math.max(0, Math.min(c1, q1) - Math.max(c0, q0)) / (q1 - q0);
        errors.push(edge);
        if (edge > maxEdge) {
          maxEdge = edge;
          worst = `char ${u.start} ${JSON.stringify(u.text)} edge ${round(edge)} px (DOM ${round(d0)}–${round(d1)}, PDFium ${round(p0)}–${round(p1)}) in span ${s.start} ${JSON.stringify(s.span.textContent)}`;
        }
        if (overlap < minOverlap) {
          minOverlap = overlap;
          worstOverlap = `char ${u.start} ${JSON.stringify(u.text)} overlap ${round(overlap)} (DOM ${round(c0)}–${round(c1)}, PDFium ${round(q0)}–${round(q1)}, ${round(u.fontSize)} pt)`;
        }
      }
      errors.sort((a, b) => a - b);
      const pct = (q: number) => round(errors[Math.min(errors.length - 1, Math.floor(q * errors.length))] ?? 0);
      return { maxEdgeErrorPx: round(maxEdge), p99EdgeErrorPx: pct(0.99), p50EdgeErrorPx: pct(0.5), minVerticalOverlap: round(minOverlap), chars: errors.length, unshown, worst, worstOverlap };
    },
    runDirs: () => spanStarts.map((s) => s.span.dir),
    /** Words: maximal runs of shown, non-space chars between spaces and line breaks, as char ranges. */
    words() {
      const out: { start: number; end: number; text: string; spans: number }[] = [];
      let cur: GlyphUnit[] = [];
      const flush = () => {
        if (cur.length > 0) out.push({ start: cur[0]!.start, end: cur[cur.length - 1]!.end, text: cur.map((u) => u.text).join(''), spans: new Set(cur.map((u) => spanOf(u.start)?.span)).size });
        cur = [];
      };
      for (const u of units) {
        if (u.lineBreak || u.hyphen || u.text.trim() === '' || !shown(u)) flush();
        else cur.push(u);
      }
      flush();
      return out;
    },
    columnTargets() {
      const flat = units.filter((u) => u.box && !u.generated && u.angle === 0 && endpoints.includes(u.start));
      const mid = pageWidth / 2;
      const middleOfLine = (line: GlyphUnit[]) => line.sort((a, b) => a.box!.x - b.box!.x)[Math.floor(line.length / 2)];
      const col1 = flat.filter((u) => u.box!.x + u.box!.width < mid);
      const col2 = flat.filter((u) => u.box!.x > mid);
      if (col1.length === 0 || col2.length === 0) return null;
      const bottom = Math.max(...col1.map((u) => u.box!.y));
      const top = Math.min(...col2.map((u) => u.box!.y));
      const a = middleOfLine(col1.filter((u) => Math.abs(u.box!.y - bottom) < 1));
      const b = middleOfLine(col2.filter((u) => Math.abs(u.box!.y - top) < 1));
      return a && b ? { a: a.start, b: b.start } : null;
    },
  };
  (window as unknown as { __tl: typeof tl }).__tl = tl;

  // How often a word (non-space chars between spaces or line breaks) is split across spans: double-click
  // selects within one span only, because each absolutely positioned span is its own block.
  let words = 0;
  let splitWords = 0;
  let wordSpans = new Set<HTMLElement>();
  const endWord = () => {
    if (wordSpans.size > 0) words++;
    if (wordSpans.size > 1) splitWords++;
    wordSpans = new Set();
  };
  for (const u of units) {
    if (u.lineBreak || u.text.trim() === '' || u.hyphen) {
      endWord();
      continue;
    }
    const s = spanOf(u.start);
    if (s) wordSpans.add(s.span);
  }
  endWord();

  const layerRect = pageDiv.getBoundingClientRect();
  return {
    file,
    pageIndex,
    zoom,
    scale: round(scale),
    rotation,
    snap,
    font: cssFont(16),
    glyphs: glyphs.glyphs.length,
    runs: glyphs.runs.length,
    generated: glyphs.glyphs.filter((g) => g.generated).length,
    items: items.length,
    spans: spanStarts.length,
    words,
    splitWords,
    measures,
    endpoints,
    layout: { left: layerRect.left, top: layerRect.top, width: layerRect.width, height: layerRect.height, right: layerRect.right, bottom: layerRect.bottom },
    timings: { openMs: ms(t0, tOpen), getGlyphsMs: ms(tOpen, tGlyphs), buildTextItemsMs: ms(tGlyphs, tItems), layerMs: ms(tRender, tLayer) },
  };
}

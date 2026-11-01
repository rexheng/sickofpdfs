// P0-5: bold as a glyph-outline overlay. The covered chars' own glyph outlines, read from PDFium by
// SpikeNative.getGlyphOutlines, are drawn again in an SVG over PDFium's render of the page: filled, and stroked
// 0.03 × the font size, so each glyph comes out slightly heavier. Nothing is re-rendered by PDFium.
//   spike.html?check=bold&file=<url>&probeOnly=1
//     → { missingFunctions, checked }: the PDFium functions getGlyphOutlines calls, and those the wasm lacks.
//   spike.html?check=bold&file=<url>&page=<index>&words=<n>&zoom=<1 = 100%>&reps=<n>[&from=<text>]
//     → bolds n words, starting at the word that holds the first `from` on the page (by default the start of the
//       attention paper's abstract), `reps` times. Each rep starts from a painted frame without bold and is timed
//       from the request to the <path> elements in the DOM. The last rep's overlay stays on screen for the
//       screenshots and is rasterised for ink coverage and spill (see `coverage`). The same is measured for the
//       whole page's text, as a diagnostic, and shown in a second copy of the page (#page-all) below the first.
import { createFileWorkerEngine } from '../engine/client';
import type { Glyph, GlyphArgForms, GlyphOutline, PageGlyphs, Rect } from '../engine/spike-native';
import { withTimeout } from './render';

const PT_TO_CSS = 96 / 72;
const MARGIN = 16;
const STEP_TIMEOUT_MS = 20_000;
const SVG_NS = 'http://www.w3.org/2000/svg';
/** The bold stroke, in ems of the glyph's effective font size (the spec: "filled and stroked slightly heavier"). */
export const BOLD_STROKE_EM = 0.03;
/** A pixel of PDFium's render is glyph ink below this luminance; an overlay pixel is "in the overlay" at this alpha or more. */
const INK_BELOW = 128;
const OVERLAY_FROM = 128;
/** Spill: an overlay pixel whose centre is further than this from every ink pixel's centre (device px). */
const SPILL_DISTANCE = 2;
const DEFAULT_FROM = 'The dominant sequence';

const round = (n: number, places = 3) => Math.round(n * 10 ** places) / 10 ** places;
const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
/** Nearest-rank percentile: with 10 samples, p95 is the largest. */
const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? NaN;
};

/** Words: maximal runs of chars that PDFium did not generate and that are not whitespace; end is exclusive. */
function pageWords(glyphs: Glyph[]): { start: number; end: number }[] {
  const words: { start: number; end: number }[] = [];
  let start = -1;
  glyphs.forEach((g, i) => {
    const inWord = !g.generated && g.text.trim() !== '';
    if (inWord && start < 0) start = i;
    if (!inWord && start >= 0) {
      words.push({ start, end: i });
      start = -1;
    }
  });
  if (start >= 0) words.push({ start, end: glyphs.length });
  return words;
}

/** One <path> per outline: the glyph filled, and stroked BOLD_STROKE_EM × its font size (user units are points). */
function boldPaths(outlines: GlyphOutline[], glyphs: Glyph[]): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const o of outlines) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', o.d);
    path.setAttribute('fill', 'currentColor');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', String(round(BOLD_STROKE_EM * glyphs[o.charIndex]!.fontSize)));
    path.setAttribute('stroke-linejoin', 'round');
    fragment.append(path);
  }
  return fragment;
}

/** The overlay drawn the way the page shows it, at `width` × `height` device px: RGBA, transparent where nothing is drawn. */
async function rasterise(svg: SVGSVGElement, width: number, height: number): Promise<Uint8ClampedArray> {
  const copy = svg.cloneNode(true) as SVGSVGElement;
  copy.removeAttribute('style');
  copy.setAttribute('width', String(width));
  copy.setAttribute('height', String(height));
  copy.setAttribute('color', '#000');
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(copy)], { type: 'image/svg+xml' }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const ctx = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(image, 0, 0, width, height);
    return ctx.getImageData(0, 0, width, height).data;
  } finally {
    URL.revokeObjectURL(url);
  }
}

interface Coverage {
  /** Glyph-ink pixels (luminance < 128 in PDFium's render, inside a covered char's tight box) that the overlay covers. */
  inkCoverage: number;
  /** Overlay pixels (alpha ≥ 128) further than 2 px from any ink pixel of the page, over all overlay pixels. */
  spillFraction: number;
  glyphInkPx: number;
  overlayPx: number;
  spillPx: number;
  /** The covered chars with the least of their own ink covered. */
  worst: { charIndex: number; text: string; coverage: number }[];
}

/**
 * Compares the rasterised overlay with PDFium's render of the page (both `width` × `height` device px). A char's
 * ink is the ink inside its PDFium tight box (FPDFText_GetCharBox), taken to every pixel the box touches.
 */
function coverage(base: Uint8ClampedArray, overlay: Uint8ClampedArray, width: number, height: number, chars: { charIndex: number; text: string; box: Rect }[]): Coverage {
  const ink = new Uint8Array(width * height);
  for (let p = 0; p < ink.length; p++) {
    const q = 4 * p;
    ink[p] = (77 * base[q]! + 150 * base[q + 1]! + 29 * base[q + 2]!) >> 8 < INK_BELOW ? 1 : 0;
  }
  const inOverlay = (p: number) => overlay[4 * p + 3]! >= OVERLAY_FROM;

  const counted = new Uint8Array(width * height); // each glyph-ink pixel once, however many boxes touch it
  let glyphInkPx = 0;
  let coveredPx = 0;
  const perChar: Coverage['worst'] = [];
  for (const c of chars) {
    const x0 = Math.max(0, Math.ceil(c.box.x - 1));
    const x1 = Math.min(width - 1, Math.floor(c.box.x + c.box.width));
    const y0 = Math.max(0, Math.ceil(c.box.y - 1));
    const y1 = Math.min(height - 1, Math.floor(c.box.y + c.box.height));
    let own = 0;
    let ownCovered = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const p = y * width + x;
        if (!ink[p]) continue;
        const covered = inOverlay(p);
        own++;
        if (covered) ownCovered++;
        if (counted[p]) continue;
        counted[p] = 1;
        glyphInkPx++;
        if (covered) coveredPx++;
      }
    }
    if (own > 0) perChar.push({ charIndex: c.charIndex, text: c.text, coverage: round(ownCovered / own) });
  }

  const near: [number, number][] = [];
  for (let dy = -SPILL_DISTANCE; dy <= SPILL_DISTANCE; dy++)
    for (let dx = -SPILL_DISTANCE; dx <= SPILL_DISTANCE; dx++) if (dx * dx + dy * dy <= SPILL_DISTANCE ** 2) near.push([dx, dy]);
  let overlayPx = 0;
  let spillPx = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (!inOverlay(p)) continue;
      overlayPx++;
      const nearInk = near.some(([dx, dy]) => {
        const nx = x + dx;
        const ny = y + dy;
        return nx >= 0 && ny >= 0 && nx < width && ny < height && ink[ny * width + nx] === 1;
      });
      if (!nearInk) spillPx++;
    }
  }
  return {
    inkCoverage: glyphInkPx ? round(coveredPx / glyphInkPx, 4) : 0,
    spillFraction: overlayPx ? round(spillPx / overlayPx, 4) : 1,
    glyphInkPx,
    overlayPx,
    spillPx,
    worst: perChar.sort((a, b) => a.coverage - b.coverage).slice(0, 5),
  };
}

export async function run(params: URLSearchParams) {
  const file = params.get('file') ?? '';
  const engine = await withTimeout(createFileWorkerEngine(), STEP_TIMEOUT_MS, 'engine start');
  if (params.get('probeOnly') === '1') {
    return {
      missingFunctions: await engine.call<string[]>('missingGlyphFunctions'),
      checked: await engine.call<string[]>('glyphFunctions'),
    };
  }
  const pageIndex = Number(params.get('page') ?? 0);
  const wordCount = Number(params.get('words') ?? 20);
  const zoom = Number(params.get('zoom') ?? 1);
  const reps = Number(params.get('reps') ?? 10);
  const from = params.get('from') ?? DEFAULT_FROM;
  const hideRunnerOutput = document.createElement('style');
  hideRunnerOutput.textContent = 'body > pre { display: none; }'; // the runner prints __result; keep it off the screenshots
  document.head.append(hideRunnerOutput);

  const doc = await withTimeout(engine.open(file), STEP_TIMEOUT_MS, 'open');
  const pageInfo = doc.pages[pageIndex];
  if (!pageInfo) throw new Error(`page ${pageIndex} out of range (${doc.pageCount} pages)`);
  if (pageInfo.rotation !== 0) throw new Error('the bold check handles unrotated pages only'); // outlines are in unrotated page space
  const { glyphs } = await withTimeout(engine.call<PageGlyphs>('getGlyphs', doc.docId, pageIndex), STEP_TIMEOUT_MS, 'getGlyphs');

  // The passage: `wordCount` words from the word that holds `from`.
  const pageText = glyphs.map((g) => g.text).join('');
  const at = pageText.indexOf(from);
  if (at < 0) throw new Error(`${JSON.stringify(from)} is not on page ${pageIndex}`);
  const words = pageWords(glyphs);
  const first = words.findIndex((w) => w.end > at);
  const passageWords = words.slice(first, first + wordCount);
  if (passageWords.length < wordCount) throw new Error(`only ${passageWords.length} words from ${JSON.stringify(from)}`);
  const charStart = passageWords[0]!.start;
  const charCount = passageWords.at(-1)!.end - charStart;

  // The page: PDFium's render with the bold overlay over it, at zoom × 96/72 CSS px per point.
  const scale = zoom * PT_TO_CSS;
  const cssWidth = pageInfo.width * scale;
  const cssHeight = pageInfo.height * scale;
  const bitmap = await withTimeout(engine.render(doc.docId, pageIndex, scale * devicePixelRatio), STEP_TIMEOUT_MS, 'render');
  const { width, height } = bitmap;
  const pageDiv = document.createElement('div');
  pageDiv.id = 'page';
  pageDiv.style.cssText = `position:absolute;left:${MARGIN}px;top:${MARGIN}px;width:${cssWidth}px;height:${cssHeight}px;background:#fff;`;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.style.cssText = `position:absolute;left:0;top:0;width:${cssWidth}px;height:${cssHeight}px;margin:0;border:0;`;
  const canvasCtx = canvas.getContext('2d', { willReadFrequently: true })!;
  canvasCtx.drawImage(bitmap, 0, 0);
  const base = canvasCtx.getImageData(0, 0, width, height).data;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${pageInfo.width} ${pageInfo.height}`); // points, origin top-left, as the outlines
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.style.cssText = `position:absolute;left:0;top:0;width:${cssWidth}px;height:${cssHeight}px;color:#000;overflow:visible;pointer-events:none;`;
  pageDiv.append(canvas, svg);
  document.body.append(pageDiv);
  await nextFrame();

  const timings: { totalMs: number; callMs: number; domMs: number; frameMs: number }[] = [];
  let outlines: GlyphOutline[] = [];
  for (let rep = 0; rep < reps; rep++) {
    svg.replaceChildren();
    await nextFrame(); // each rep starts from a painted frame without bold
    const t0 = performance.now();
    outlines = await withTimeout(engine.call<GlyphOutline[]>('getGlyphOutlines', doc.docId, pageIndex, charStart, charCount), STEP_TIMEOUT_MS, 'getGlyphOutlines');
    const tCall = performance.now();
    svg.append(boldPaths(outlines, glyphs));
    const tDom = performance.now();
    await nextFrame();
    const tFrame = performance.now();
    timings.push({ totalMs: round(tDom - t0, 1), callMs: round(tCall - t0, 1), domMs: round(tDom - tCall, 1), frameMs: round(tFrame - t0, 1) });
  }
  if (svg.querySelectorAll('path').length !== outlines.length) throw new Error('the overlay does not hold one <path> per outline');

  const pxPerPt = width / pageInfo.width;
  const deviceChars = (start: number, end: number) =>
    glyphs
      .slice(start, end)
      .filter((g) => !g.generated && g.tight.width > 0 && g.tight.height > 0)
      .map((g) => ({ charIndex: g.index, text: g.text, box: { x: g.tight.x * pxPerPt, y: g.tight.y * pxPerPt, width: g.tight.width * pxPerPt, height: g.tight.height * pxPerPt } }));
  const passage = coverage(base, await rasterise(svg, width, height), width, height, deviceChars(charStart, charStart + charCount));
  const passageForms = await engine.call<GlyphArgForms>('glyphArgForms', doc.docId, pageIndex, charStart, charCount);

  // Diagnostic: every char on the page, in one call, in a second copy of the page below the first.
  const tPage = performance.now();
  const pageOutlines = await withTimeout(engine.call<GlyphOutline[]>('getGlyphOutlines', doc.docId, pageIndex, 0, glyphs.length), STEP_TIMEOUT_MS, 'getGlyphOutlines (page)');
  const pageMs = round(performance.now() - tPage, 1);
  const pageSvg = svg.cloneNode(false) as SVGSVGElement;
  pageSvg.append(boldPaths(pageOutlines, glyphs));
  const page = coverage(base, await rasterise(pageSvg, width, height), width, height, deviceChars(0, glyphs.length));
  const pageForms = await engine.call<GlyphArgForms>('glyphArgForms', doc.docId, pageIndex, 0, glyphs.length);
  const pageAllDiv = pageDiv.cloneNode(false) as HTMLDivElement;
  pageAllDiv.id = 'page-all';
  pageAllDiv.style.top = `${2 * MARGIN + cssHeight}px`;
  const canvasAll = canvas.cloneNode(false) as HTMLCanvasElement;
  canvasAll.getContext('2d')!.drawImage(canvas, 0, 0);
  pageAllDiv.append(canvasAll, pageSvg);
  document.body.append(pageAllDiv);

  // A close-up for the gate review: the passage's lines, with two lines of context above and below.
  const shown = glyphs.slice(charStart, charStart + charCount).filter((g) => !g.generated && g.box.width > 0);
  const lineHeight = Math.max(...shown.map((g) => g.box.height));
  const top = Math.max(0, Math.min(...shown.map((g) => g.box.y)) - 2 * lineHeight);
  const bottom = Math.min(pageInfo.height, Math.max(...shown.map((g) => g.box.y + g.box.height)) + 2 * lineHeight);
  const left = Math.max(0, Math.min(...shown.map((g) => g.box.x)) - lineHeight);
  const right = Math.min(pageInfo.width, Math.max(...shown.map((g) => g.box.x + g.box.width)) + lineHeight);
  const origin = pageDiv.getBoundingClientRect();
  const detailClip = {
    x: Math.floor(origin.left + left * scale),
    y: Math.floor(origin.top + top * scale),
    width: Math.ceil((right - left) * scale),
    height: Math.ceil((bottom - top) * scale),
  };

  const totals = timings.map((t) => t.totalMs);
  const warm = totals.slice(1);
  return {
    file,
    pageIndex,
    zoom,
    scale: round(scale),
    devicePixelRatio,
    bitmap: { width, height },
    words: passageWords.length,
    charStart,
    charCount,
    passage: pageText.slice(charStart, charStart + charCount).replace(/\s+/g, ' '),
    outlines: outlines.length,
    paths: svg.querySelectorAll('path').length,
    strokeEm: BOLD_STROKE_EM,
    reps,
    /** Request → <path> elements in the DOM, per rep; the first rep has cold caches (wasm, PDFium glyph cache). */
    p95Ms: percentile(totals, 0.95),
    p50Ms: percentile(totals, 0.5),
    firstMs: totals[0],
    warmMaxMs: warm.length ? Math.max(...warm) : null,
    callP95Ms: percentile(timings.map((t) => t.callMs), 0.95),
    domP95Ms: percentile(timings.map((t) => t.domMs), 0.95),
    /** Request → the next animation frame after the paths went in (the frame that paints them). */
    frameP95Ms: percentile(timings.map((t) => t.frameMs), 0.95),
    timings,
    inkCoverage: passage.inkCoverage,
    spillFraction: passage.spillFraction,
    coverage: passage,
    forms: passageForms,
    page: { chars: glyphs.length, outlines: pageOutlines.length, ms: pageMs, inkCoverage: page.inkCoverage, spillFraction: page.spillFraction, coverage: page, forms: pageForms },
    detailClip,
  };
}

// DOM selection ↔ PDFium char indices for the text layers renderTextLayer builds (ported from the Phase 0 spike).
// A layer is a `.sop-text-layer[data-text-page]`; each span has `data-start` (the PDFium index of its first char) and
// one text node whose UTF-16 offsets are consecutive char indices. Spans are in char-index order. PDFium's line breaks
// are not in the DOM (a <br> stands for them), so char indices can skip between spans.
import { TEXT_LAYER_CLASS, TEXT_LAYER_PAGE_ATTR } from './text-layer';

/** Chars [start, end) of one page, by PDFium char index. */
export interface CharRange {
  pageIndex: number;
  start: number;
  /** Exclusive. */
  end: number;
}

interface SpanText {
  node: Text;
  start: number;
}

const LAYER_SELECTOR = `.${TEXT_LAYER_CLASS}[${TEXT_LAYER_PAGE_ATTR}]`;
const layersIn = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(LAYER_SELECTOR)];
const pageOf = (layer: HTMLElement) => Number(layer.getAttribute(TEXT_LAYER_PAGE_ATTR));

/** The text nodes a selection can hold, in order (the unselectable hyphen spans are left out). */
function selectableTexts(layer: HTMLElement): SpanText[] {
  const out: SpanText[] = [];
  for (const span of layer.querySelectorAll<HTMLElement>('span[data-start]:not(.sop-unselectable)')) {
    const node = span.firstChild;
    if (node instanceof Text) out.push({ node, start: Number(span.dataset.start) });
  }
  return out;
}

/**
 * The PDFium char ranges a DOM range covers, one per page it touches. A boundary inside a span's text maps to
 * start + offset. A boundary elsewhere maps to the next selectable char after it (range start) or to just after the
 * last one before it (range end), so a gap such as a line break is never counted at either end.
 */
export function charRangeFromDomRange(root: HTMLElement, range: Range): CharRange[] {
  const out: CharRange[] = [];
  for (const layer of layersIn(root)) {
    if (!range.intersectsNode(layer)) continue;
    const texts = selectableTexts(layer);
    if (texts.length === 0) continue;
    const last = texts[texts.length - 1];
    const start = layer.contains(range.startContainer) ? boundary(texts, range.startContainer, range.startOffset, 'start') : texts[0].start;
    const end = layer.contains(range.endContainer) ? boundary(texts, range.endContainer, range.endOffset, 'end') : last.start + last.node.length;
    if (end > start) out.push({ pageIndex: pageOf(layer), start, end });
  }
  return out;
}

function boundary(texts: SpanText[], node: Node, offset: number, side: 'start' | 'end'): number {
  const own = texts.find((t) => t.node === node);
  if (own) return own.start + offset;
  const at = document.createRange();
  at.setStart(node, offset);
  if (side === 'start') {
    const next = texts.find((t) => at.comparePoint(t.node, t.node.length) > 0);
    return next ? next.start : texts[texts.length - 1].start + texts[texts.length - 1].node.length;
  }
  const prev = texts.findLast((t) => at.comparePoint(t.node, 0) < 0);
  return prev ? prev.start + prev.node.length : texts[0].start;
}

/** The char ranges the document's selection covers inside `viewerRoot`'s text layers, in page order; [] for none. */
export function getSelectionRanges(viewerRoot: HTMLElement): CharRange[] {
  const sel = document.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return [];
  const out: CharRange[] = [];
  for (let i = 0; i < sel.rangeCount; i++) out.push(...charRangeFromDomRange(viewerRoot, sel.getRangeAt(i)));
  return mergeRanges(out);
}

/** Sorted by page and start, with overlapping or touching ranges of a page joined. */
function mergeRanges(ranges: CharRange[]): CharRange[] {
  const sorted = [...ranges].sort((a, b) => a.pageIndex - b.pageIndex || a.start - b.start);
  const out: CharRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && last.pageIndex === r.pageIndex && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

/** The DOM position where char `charIndex` starts (or, when it is not in the layer, where the next shown char starts). */
function startPosition(layer: HTMLElement, charIndex: number): { node: Text; offset: number } | null {
  for (const t of selectableTexts(layer)) {
    if (t.start + t.node.length > charIndex) return { node: t.node, offset: Math.max(0, charIndex - t.start) };
  }
  return null;
}

/** The DOM position where char `charIndex − 1` ends (or, when it is not in the layer, where the last shown char before it ends). */
function endPosition(layer: HTMLElement, charIndex: number): { node: Text; offset: number } | null {
  const texts = selectableTexts(layer);
  for (let k = texts.length - 1; k >= 0; k--) {
    const t = texts[k];
    if (t.start < charIndex) return { node: t.node, offset: Math.min(t.node.length, charIndex - t.start) };
  }
  return null;
}

/**
 * Selects chars of the text layers in `viewerRoot` (Find's matches, a double-clicked word, a selection kept across a
 * rebuild). The browser keeps one selection range, so this selects from the start of the first range to the end of
 * the last (in page order). Ranges on pages with no text layer are left out; with none left, the selection is cleared.
 */
export function selectCharRanges(viewerRoot: HTMLElement, ranges: CharRange[]): void {
  const sel = document.getSelection();
  if (!sel) return;
  const layers = new Map(layersIn(viewerRoot).map((l) => [pageOf(l), l]));
  const shown = mergeRanges(ranges.filter((r) => r.end > r.start && layers.has(r.pageIndex)));
  const first = shown[0];
  const last = shown[shown.length - 1];
  const from = first && startPosition(layers.get(first.pageIndex)!, first.start);
  const to = last && endPosition(layers.get(last.pageIndex)!, last.end);
  if (!from || !to) {
    sel.removeAllRanges();
    return;
  }
  sel.setBaseAndExtent(from.node, from.offset, to.node, to.offset);
}

/**
 * The char whose rendered box contains the client point, if any (topmost span first). PDFium's joined line-end hyphen
 * (shown unselectable) counts only with `withHyphen`: a double-click on it selects the word it joins.
 */
export function charAtPoint(root: HTMLElement, x: number, y: number, withHyphen = false): { pageIndex: number; charIndex: number } | null {
  for (const el of document.elementsFromPoint(x, y)) {
    if (!(el instanceof HTMLElement) || el.dataset.start === undefined || (!withHyphen && el.classList.contains('sop-unselectable'))) continue;
    const layer = el.closest<HTMLElement>(LAYER_SELECTOR);
    const node = el.firstChild;
    if (!layer || !root.contains(layer) || !(node instanceof Text)) continue;
    const r = document.createRange();
    for (let k = 0; k < node.length; k++) {
      const code = node.data.charCodeAt(k);
      const len = code >= 0xd800 && code <= 0xdbff && k + 1 < node.length ? 2 : 1;
      r.setStart(node, k);
      r.setEnd(node, k + len);
      const b = r.getBoundingClientRect();
      if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) return { pageIndex: pageOf(layer), charIndex: Number(el.dataset.start) + k };
      k += len - 1;
    }
  }
  return null;
}

/** The DOM position just before or just after a char (a surrogate pair counts as one char). */
export function domPositionOfChar(root: HTMLElement, pageIndex: number, charIndex: number, side: 'before' | 'after'): { node: Text; offset: number } | null {
  const layer = layersIn(root).find((l) => pageOf(l) === pageIndex);
  if (!layer) return null;
  for (const t of selectableTexts(layer)) {
    const k = charIndex - t.start;
    if (k < 0 || k >= t.node.length) continue;
    const code = t.node.data.charCodeAt(k);
    const len = code >= 0xd800 && code <= 0xdbff && k + 1 < t.node.length ? 2 : 1;
    return { node: t.node, offset: side === 'before' ? k : k + len };
  }
  return null;
}

/** A selection end: a DOM position, and the char it was taken from (glyph-inclusive ends) or none (a caret position). */
export interface GlyphHit {
  pageIndex: number;
  charIndex: number;
}

/**
 * The selection a drag from glyph `from` makes, as Chrome's PDF viewer makes it (R27): from the start of the glyph under
 * the mouse-down point to the end of the glyph under the pointer (or the other way round for a backward drag), so both
 * end glyphs are inside. With no glyph under the pointer, `focus` (the browser's caret position) is the far end.
 * Returns the anchor and focus positions, or null when a char is not in the layers.
 */
export function glyphSelection(
  root: HTMLElement,
  from: GlyphHit,
  to: GlyphHit | null,
  focus: { node: Node; offset: number } | null,
): { anchor: { node: Node; offset: number }; focus: { node: Node; offset: number } } | null {
  const before = domPositionOfChar(root, from.pageIndex, from.charIndex, 'before');
  const after = domPositionOfChar(root, from.pageIndex, from.charIndex, 'after');
  if (!before || !after) return null;
  const at = document.createRange();
  at.setStart(before.node, before.offset);
  if (to) {
    const toBefore = domPositionOfChar(root, to.pageIndex, to.charIndex, 'before');
    const toAfter = domPositionOfChar(root, to.pageIndex, to.charIndex, 'after');
    if (!toBefore || !toAfter) return null;
    const forward = at.comparePoint(toBefore.node, toBefore.offset) >= 0;
    return { anchor: forward ? before : after, focus: forward ? toAfter : toBefore };
  }
  if (!focus) return null;
  const forward = at.comparePoint(focus.node, focus.offset) >= 0;
  return { anchor: forward ? before : after, focus };
}

/** A DOM range from two selection ends, in document order. */
export function rangeBetween(a: { node: Node; offset: number }, b: { node: Node; offset: number }): Range {
  const r = document.createRange();
  r.setStart(a.node, a.offset);
  if (r.comparePoint(b.node, b.offset) >= 0) {
    r.setEnd(b.node, b.offset);
  } else {
    r.setStart(b.node, b.offset);
    r.setEnd(a.node, a.offset);
  }
  return r;
}

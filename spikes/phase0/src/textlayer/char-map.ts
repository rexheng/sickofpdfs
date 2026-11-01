// DOM selection ↔ PDFium char indices for text layers built by text-layer.ts. Task 22 ports this file.
// A layer is a `.textLayer[data-page-index]`; each span has `data-start` (the PDFium index of its first char)
// and one text node whose UTF-16 offsets are consecutive char indices. Spans are in char-index order. PDFium's
// generated line breaks are not in the DOM (a <br> stands for them), so char indices can skip between spans.

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

const layersIn = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('.textLayer[data-page-index]')];

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
 * The PDFium char ranges a DOM range covers, one per page it touches. A boundary inside a span's text maps
 * to start + offset. A boundary elsewhere maps to the next selectable char after it (range start) or to just
 * after the last one before it (range end), so a gap such as a line break is never counted at either end.
 */
export function charRangeFromDomRange(root: HTMLElement, range: Range): CharRange[] {
  const out: CharRange[] = [];
  for (const layer of layersIn(root)) {
    if (!range.intersectsNode(layer)) continue;
    const texts = selectableTexts(layer);
    if (texts.length === 0) continue;
    const last = texts[texts.length - 1]!;
    const start = layer.contains(range.startContainer) ? boundary(texts, range.startContainer, range.startOffset, 'start') : texts[0]!.start;
    const end = layer.contains(range.endContainer) ? boundary(texts, range.endContainer, range.endOffset, 'end') : last.start + last.node.length;
    if (end > start) out.push({ pageIndex: Number(layer.dataset.pageIndex), start, end });
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
    return next ? next.start : texts[texts.length - 1]!.start + texts[texts.length - 1]!.node.length;
  }
  const prev = texts.findLast((t) => at.comparePoint(t.node, 0) < 0);
  return prev ? prev.start + prev.node.length : texts[0]!.start;
}

/** The char whose rendered box contains the client point, if any (topmost span first). */
export function charAtPoint(root: HTMLElement, x: number, y: number): { pageIndex: number; charIndex: number } | null {
  for (const el of document.elementsFromPoint(x, y)) {
    if (!(el instanceof HTMLElement) || el.dataset.start === undefined || el.classList.contains('sop-unselectable')) continue;
    const layer = el.closest<HTMLElement>('.textLayer[data-page-index]');
    const node = el.firstChild;
    if (!layer || !root.contains(layer) || !(node instanceof Text)) continue;
    const r = document.createRange();
    for (let k = 0; k < node.length; k++) {
      const code = node.data.charCodeAt(k);
      const len = code >= 0xd800 && code <= 0xdbff && k + 1 < node.length ? 2 : 1;
      r.setStart(node, k);
      r.setEnd(node, k + len);
      const b = r.getBoundingClientRect();
      if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) return { pageIndex: Number(layer.dataset.pageIndex), charIndex: Number(el.dataset.start) + k };
      k += len - 1;
    }
  }
  return null;
}

/** The DOM position just before or just after a char (a surrogate pair counts as one char). */
export function domPositionOfChar(root: HTMLElement, pageIndex: number, charIndex: number, side: 'before' | 'after'): { node: Text; offset: number } | null {
  const layer = layersIn(root).find((l) => Number(l.dataset.pageIndex) === pageIndex);
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

/**
 * Makes a mouse drag select whole glyphs, as Chrome's PDF viewer does: the selection runs from the start of
 * the glyph under the mouse-down point to the end of the glyph under the mouse-up point (or the other way
 * round for a backward drag). The browser places selection ends at the nearest caret position instead, and
 * at a glyph's centre that side is a coin toss. Only a single-click drag is changed; a double or triple click
 * keeps the browser's word and line selection, and an end not over a glyph keeps the browser's position.
 */
export function enableGlyphSelection(root: HTMLElement): () => void {
  const ac = new AbortController();
  let down: { pageIndex: number; charIndex: number; x: number; y: number } | null = null;
  root.addEventListener(
    'mousedown',
    (e) => {
      const hit = e.button === 0 && e.detail <= 1 ? charAtPoint(root, e.clientX, e.clientY) : null;
      down = hit && { ...hit, x: e.clientX, y: e.clientY };
    },
    { signal: ac.signal },
  );
  document.addEventListener(
    'mouseup',
    (e) => {
      const from = down;
      down = null;
      if (!from || e.button !== 0 || Math.hypot(e.clientX - from.x, e.clientY - from.y) < 3) return;
      const sel = document.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const before = domPositionOfChar(root, from.pageIndex, from.charIndex, 'before');
      const after = domPositionOfChar(root, from.pageIndex, from.charIndex, 'after');
      if (!before || !after) return;
      const at = document.createRange();
      at.setStart(before.node, before.offset);
      const to = charAtPoint(root, e.clientX, e.clientY);
      if (to) {
        const toBefore = domPositionOfChar(root, to.pageIndex, to.charIndex, 'before');
        const toAfter = domPositionOfChar(root, to.pageIndex, to.charIndex, 'after');
        if (!toBefore || !toAfter) return;
        const forward = at.comparePoint(toBefore.node, toBefore.offset) >= 0;
        const anchor = forward ? before : after;
        const focus = forward ? toAfter : toBefore;
        sel.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
      } else if (!sel.isCollapsed && sel.focusNode) {
        const forward = at.comparePoint(sel.focusNode, sel.focusOffset) >= 0;
        const anchor = forward ? before : after;
        sel.setBaseAndExtent(anchor.node, anchor.offset, sel.focusNode, sel.focusOffset);
      }
    },
    { signal: ac.signal },
  );
  return () => ac.abort();
}

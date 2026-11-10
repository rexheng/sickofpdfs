// Selecting text with a finger (R110). A phone has no mouse drag and no right-click, so:
// - A long press on a word selects it. Keep the finger down and move it to stretch the selection, as in Android's own apps.
// - Two round handles then sit at the selection's ends. Drag either to move that end; the other end stays put.
// - A tap anywhere else lets the selection go (the text layer's own click does that).
//
// It only sets the page's DOM selection. The text layer reads every change to it into its selection model (TextLayer's
// syncFromDom), which paints the selection and is what the marks, Comment and Copy act on, exactly as with a mouse. The
// action bar (SelectionBar.tsx) shows while there is a selection.
//
// Android's own long-press selection (its handles and its Copy/Share bar) is turned off for the pages: the page cancels the
// long press's contextmenu event, the CSS turns off the touch callout, and MainActivity closes the system's text action bar.
// So there is one set of handles, and one bar.

import { isNativeApp, SopPlatform } from '../platform/native';

/** How long a finger rests on a word before it selects it (Android's long-press time). */
const LONG_PRESS_MS = 450;
/** A finger that moves further than this before then is scrolling, not pressing. */
const SLOP_PX = 10;
/** A handle is dragged by a point this far above the finger, so the finger never hides the end it moves. */
const HANDLE_LIFT_PX = 28;

const pagesEl = (): HTMLElement | null => document.querySelector<HTMLElement>('[role="document"]');

/** A text node of a page's text layer (the only text a finger selects). */
function inTextLayer(node: Node | null): node is Text {
  return node instanceof Text && node.parentElement?.closest('.sop-text-layer') !== null;
}

/** A finger is not a pointer: a word this far from the touch point still counts as under it. */
const REACH_PX = 24;

/** The page text layer under a point (the page box the point is in). */
function layerAt(x: number, y: number): HTMLElement | null {
  for (const layer of document.querySelectorAll<HTMLElement>('.sop-text-layer')) {
    const b = layer.getBoundingClientRect();
    if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) return layer;
  }
  return null;
}

/** The text nodes of a layer, with their line boxes. */
function textNodes(layer: HTMLElement): Text[] {
  const out: Text[] = [];
  const walk = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n !== null; n = walk.nextNode()) if (n instanceof Text && n.data.length > 0) out.push(n);
  return out;
}

/** How far a point is from a box (0 inside); a line above or below counts more than a gap beside. */
function distance(b: DOMRect, x: number, y: number): number {
  const dx = x < b.left ? b.left - x : x > b.right ? x - b.right : 0;
  const dy = y < b.top ? b.top - y : y > b.bottom ? y - b.bottom : 0;
  return dx + dy * 2;
}

/**
 * The caret position under a point, in a page's text. The text layer's spans are laid over the glyphs and the gaps between
 * them are part of no span, so this looks for the nearest span within a finger's reach, then for the char under the point.
 */
function caretAt(x: number, y: number): { node: Text; offset: number } | null {
  const layer = layerAt(x, y);
  if (layer === null) return null;
  let best: { node: Text; d: number } | null = null;
  const range = document.createRange();
  for (const node of textNodes(layer)) {
    range.selectNodeContents(node);
    const d = distance(range.getBoundingClientRect(), x, y);
    if (d <= REACH_PX && (best === null || d < best.d)) best = { node, d };
  }
  if (best === null) return null;
  // The char whose box is nearest across (its middle splits "before" from "after").
  const { node } = best;
  let offset = 0;
  let nearest = Infinity;
  for (let i = 0; i < node.data.length; i++) {
    range.setStart(node, i);
    range.setEnd(node, i + 1);
    const b = range.getBoundingClientRect();
    if (b.width === 0 && b.height === 0) continue;
    const mid = (b.left + b.right) / 2;
    const d = Math.abs(mid - x);
    if (d < nearest) {
      nearest = d;
      offset = x > mid ? i + 1 : i;
    }
  }
  return inTextLayer(node) ? { node, offset } : null;
}

const WORD = /[\p{L}\p{N}\p{M}'’_-]/u;

/** Whether two text nodes sit on the same line (their boxes overlap up and down). */
function sameLine(a: Text, b: Text): boolean {
  const r = document.createRange();
  r.selectNodeContents(a);
  const p = r.getBoundingClientRect();
  r.selectNodeContents(b);
  const q = r.getBoundingClientRect();
  return Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top) > Math.min(p.height, q.height) / 2;
}

type Point = { node: Text; offset: number };

/**
 * The word round a caret position (or the one character there, for a symbol). The text layer splits a line into several
 * spans, so a word can run on into the next text node on the same line: it is followed there.
 */
function wordAt(at: Point): { start: Point; end: Point } | null {
  const text = at.node.data;
  if (text.length === 0) return null;
  let i = Math.min(at.offset, text.length - 1);
  // A press just after a word's last letter still means that word.
  if (!WORD.test(text[i] ?? '') && i > 0 && WORD.test(text[i - 1] ?? '')) i -= 1;
  if (!WORD.test(text[i] ?? '')) return /\s/u.test(text[i] ?? ' ') ? null : { start: { node: at.node, offset: i }, end: { node: at.node, offset: i + 1 } };
  const layer = at.node.parentElement?.closest<HTMLElement>('.sop-text-layer');
  const nodes = layer ? textNodes(layer) : [at.node];
  let k = nodes.indexOf(at.node);
  let start = i;
  let startNode = at.node;
  for (;;) {
    while (start > 0 && WORD.test(startNode.data[start - 1] ?? '')) start -= 1;
    const prev = nodes[k - 1];
    if (start > 0 || prev === undefined || !WORD.test(prev.data.at(-1) ?? '') || !sameLine(prev, startNode)) break;
    k -= 1;
    startNode = prev;
    start = prev.data.length;
  }
  k = nodes.indexOf(at.node);
  let end = i + 1;
  let endNode = at.node;
  for (;;) {
    while (end < endNode.data.length && WORD.test(endNode.data[end] ?? '')) end += 1;
    const next = nodes[k + 1];
    if (end < endNode.data.length || next === undefined || !WORD.test(next.data[0] ?? '') || !sameLine(next, endNode)) break;
    k += 1;
    endNode = next;
    end = 0;
  }
  return { start: { node: startNode, offset: start }, end: { node: endNode, offset: end } };
}

/** The page's selection, when it is some text on the pages. */
export function pageSelection(): Range | null {
  const sel = document.getSelection();
  if (sel === null || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const r = sel.getRangeAt(0);
  const pages = pagesEl();
  return pages !== null && pages.contains(r.commonAncestorContainer) ? r : null;
}

/** The first and last line boxes of a range (its rects on screen, without the empty ones). */
export function endRects(r: Range): { first: DOMRect; last: DOMRect } | null {
  const rects = [...r.getClientRects()].filter((b) => b.width > 0.5 && b.height > 0.5);
  const first = rects[0];
  const last = rects.at(-1);
  return first !== undefined && last !== undefined ? { first, last } : null;
}

function makeHandle(which: 'start' | 'end'): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'sop-touch-handle';
  el.dataset.handle = which;
  el.setAttribute('aria-hidden', 'true');
  el.hidden = true;
  document.body.appendChild(el);
  return el;
}

/** Starts touch selection for this page. */
export function installTouchSelection(): void {
  const handles = { start: makeHandle('start'), end: makeHandle('end') };
  let press: { x: number; y: number; timer: ReturnType<typeof setTimeout>; id: number } | null = null;
  /** After a long press selected a word, until the finger lifts: moving it stretches the selection. */
  let stretching: { node: Text; offset: number; id: number } | null = null;
  let dragging: { fixed: { node: Node; offset: number }; id: number; which: 'start' | 'end' } | null = null;
  let frame = 0;

  let told = false;
  const place = () => {
    frame = 0;
    const r = pageSelection();
    if (isNativeApp() && told !== (r !== null)) {
      told = r !== null;
      void SopPlatform.setPageSelection({ on: told }).catch(() => {});
    }
    const ends = r === null ? null : endRects(r);
    const area = pagesEl()?.getBoundingClientRect();
    for (const which of ['start', 'end'] as const) {
      const el = handles[which];
      const box = ends === null ? null : which === 'start' ? ends.first : ends.last;
      const x = box === null ? 0 : which === 'start' ? box.left : box.right;
      const y = box === null ? 0 : box.bottom;
      const visible = box !== null && area !== undefined && y > area.top && y < area.bottom && x >= area.left - 1 && x <= area.right + 1;
      el.hidden = !visible && dragging?.which !== which;
      if (box !== null) el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    }
  };
  const schedule = () => {
    if (frame === 0) frame = requestAnimationFrame(place);
  };

  const cancelPress = () => {
    if (press !== null) clearTimeout(press.timer);
    press = null;
  };

  const select = (from: { node: Node; offset: number }, to: { node: Node; offset: number }) => {
    document.getSelection()?.setBaseAndExtent(from.node, from.offset, to.node, to.offset);
    schedule();
  };

  const longPress = (x: number, y: number, id: number) => {
    press = null;
    const at = caretAt(x, y);
    if (at === null) return;
    const word = wordAt(at);
    if (word === null) return;
    // Any focused field lets go first, so the text layer takes this as the reader's selection.
    if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) document.activeElement.blur();
    select(word.start, word.end);
    stretching = { ...word.start, id };
  };

  const onPages = (t: EventTarget | null): boolean => {
    const pages = pagesEl();
    if (pages === null || !(t instanceof Node) || !pages.contains(t)) return false;
    return !(t instanceof Element && t.closest('a, button, input, textarea, [role="button"], [contenteditable="true"]'));
  };

  document.addEventListener(
    'touchstart',
    (e) => {
      cancelPress();
      stretching = null;
      const t = e.changedTouches[0];
      if (e.touches.length !== 1 || t === undefined || !onPages(e.target)) return;
      const { clientX: x, clientY: y, identifier: id } = t;
      press = { x, y, id, timer: setTimeout(() => longPress(x, y, id), LONG_PRESS_MS) };
    },
    { capture: true, passive: true },
  );

  document.addEventListener(
    'touchmove',
    (e) => {
      const t = [...e.changedTouches].find((c) => c.identifier === (stretching?.id ?? press?.id));
      if (t === undefined) return;
      if (stretching !== null) {
        // The finger that selected a word stretches the selection from that word; the pages do not scroll meanwhile.
        e.preventDefault();
        const at = caretAt(t.clientX, t.clientY);
        if (at !== null) select({ node: stretching.node, offset: stretching.offset }, at);
        return;
      }
      if (press !== null && Math.hypot(t.clientX - press.x, t.clientY - press.y) > SLOP_PX) cancelPress();
    },
    { capture: true, passive: false },
  );

  const end = (e: TouchEvent) => {
    cancelPress();
    if (stretching !== null && [...e.changedTouches].some((c) => c.identifier === stretching?.id)) {
      stretching = null;
      // No click (and no mouse events) after a long press: the text layer would take them as a tap that lets go.
      if (e.cancelable) e.preventDefault();
      schedule();
    }
  };
  document.addEventListener('touchend', end, { capture: true, passive: false });
  document.addEventListener('touchcancel', end, { capture: true, passive: false });

  // Android's long press asks for a context menu: on the pages there is none (the action bar is the menu).
  document.addEventListener(
    'contextmenu',
    (e) => {
      if (onPages(e.target) || pageSelection() !== null) e.preventDefault();
    },
    { capture: true },
  );

  // ---- the handles

  for (const which of ['start', 'end'] as const) {
    const el = handles[which];
    el.addEventListener(
      'touchstart',
      (e) => {
        const r = pageSelection();
        const t = e.changedTouches[0];
        if (r === null || t === undefined) return;
        e.preventDefault();
        e.stopPropagation();
        cancelPress();
        // The other end stays where it is.
        const fixed = which === 'start' ? { node: r.endContainer, offset: r.endOffset } : { node: r.startContainer, offset: r.startOffset };
        dragging = { fixed, id: t.identifier, which };
        el.dataset.dragging = '';
      },
      { passive: false },
    );
  }

  document.addEventListener(
    'touchmove',
    (e) => {
      if (dragging === null) return;
      const t = [...e.changedTouches].find((c) => c.identifier === dragging?.id);
      if (t === undefined) return;
      e.preventDefault();
      const at = caretAt(t.clientX, t.clientY - HANDLE_LIFT_PX);
      if (at === null) return;
      // Never empty: a handle dragged onto the other end keeps one character.
      const range = document.createRange();
      range.setStart(dragging.fixed.node, dragging.fixed.offset);
      const order = range.comparePoint(at.node, at.offset);
      if (order === 0) return;
      select(dragging.fixed, at);
    },
    { capture: true, passive: false },
  );
  const endDrag = (e: TouchEvent) => {
    if (dragging === null || ![...e.changedTouches].some((c) => c.identifier === dragging?.id)) return;
    delete handles[dragging.which].dataset.dragging;
    dragging = null;
    if (e.cancelable) e.preventDefault();
    schedule();
  };
  document.addEventListener('touchend', endDrag, { capture: true, passive: false });
  document.addEventListener('touchcancel', endDrag, { capture: true, passive: false });

  document.addEventListener('selectionchange', schedule);
  document.addEventListener('scroll', schedule, { capture: true, passive: true });
  window.addEventListener('resize', schedule);
}

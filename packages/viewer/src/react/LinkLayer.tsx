// Links inside a PDF page (Task 24): an anchor over each link's box, in a layer above the text layer. Only the anchors
// take the pointer, so everything between them reaches the text layer.
//
// - A link to a page of this document is `<a class="sop-link" data-kind="page" href="#page=N">`. A click (with or
//   without Ctrl or Shift, as in Chrome's viewer) jumps there through onInternal; the browser never follows the href.
// - A web link is a real `<a href rel="noopener noreferrer">`, drawn only for http:, https: and mailto: addresses
//   (safeLinkHref). The browser opens it as Chrome's viewer would: a click in this tab, Ctrl or middle click in a
//   background tab, Ctrl+Shift in a new foreground tab, Shift in a new window. Nothing is fetched on hover, and a press
//   reaches the network only if it ends in a click on the link (liftHref).
// - Links never block text selection. A press on a link that moves 3 px or more becomes a text selection from the
//   press point: every link layer lets the pointer through for the rest of the drag, and the selection is extended to
//   the pointer (the text layer then makes it glyph-exact on release). A press without movement is a click. A press
//   never drags the link, and never takes the focus (Tab still reaches every link).
// - While Alt is held the links let the pointer through too (Alt+drag draws an area; links are ignored).
import { type JSX, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { LinkTarget, PageSize, PdfLink, PdfRect, Rotation } from '../backend/types';
import type { PageBox } from '../layout/page-layout';
import { turnRect } from '../view/page-transform';
import { safeLinkHref, type PageLinkSource } from '../navigation/links';
import styles from './LinkLayer.module.css';

type PageTarget = LinkTarget & { kind: 'page' };

export interface LinkLayerProps {
  links: PdfLink[];
  box: PageBox;
  /**
   * The page's unrotated size in points (OpenResult.pages[box.index]), to place the links' rects. Without it the box
   * is taken to show the page at 100%.
   */
  page?: PageSize;
  onInternal(this: void, t: PageTarget): void;
  /** R108: the page number shown for a page (the reader's page order), for the links' names; pageIndex + 1 by default. */
  pageNumber?: (pageIndex: number) => number;
}

/** A press that moves this far is a drag (a text selection), not a click: the text layer's threshold. */
const DRAG_MIN_PX = 3;
/** CSS px per point at 100%. */
const CSS_PER_PT = 96 / 72;

// ---- every link layer at once: Alt and drags switch them all off, synchronously -------------------------------

const layers = new Set<HTMLElement>();
let altHeld = false;
let dragging = false;
/** A drag that started on a link just ended: the click that follows must not follow the link. */
let swallowClick = false;
let removeWatch: (() => void) | null = null;

function syncLayers(): void {
  const off = altHeld || dragging;
  for (const el of layers) el.classList.toggle(styles.off, off);
}

function setAlt(held: boolean): void {
  if (held === altHeld) return;
  altHeld = held;
  syncLayers();
}

/** Watches Alt while any link layer is mounted. */
function watchAlt(): () => void {
  const onKey = (e: KeyboardEvent) => setAlt(e.altKey);
  const onPointer = (e: PointerEvent) => setAlt(e.altKey);
  const onBlur = () => setAlt(false);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKey, true);
  window.addEventListener('pointermove', onPointer, { capture: true, passive: true });
  window.addEventListener('blur', onBlur);
  return () => {
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('keyup', onKey, true);
    window.removeEventListener('pointermove', onPointer, true);
    window.removeEventListener('blur', onBlur);
    setAlt(false);
  };
}

function register(el: HTMLElement): () => void {
  layers.add(el);
  el.classList.toggle(styles.off, altHeld || dragging);
  removeWatch ??= watchAlt();
  return () => {
    layers.delete(el);
    if (layers.size === 0) {
      removeWatch?.();
      removeWatch = null;
    }
  };
}

/**
 * The text position under a client point (the links are off by then), or null when no text is there. A text layer may
 * lay a cover over itself while a selection is made (pdf.js's endOfContent), so when the caret lands on that, the text
 * span under the point is found and the char boundary nearest the point is used.
 */
function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const p = document.caretPositionFromPoint(x, y);
  if (p && p.offsetNode.nodeType === Node.TEXT_NODE) return { node: p.offsetNode, offset: p.offset };
  for (const el of document.elementsFromPoint(x, y)) {
    const text = el.firstChild;
    if (!(text instanceof Text) || el.childNodes.length !== 1 || text.length === 0) continue;
    const r = document.createRange();
    let best = 0;
    let bestDistance = Infinity;
    for (let k = 0; k <= text.length; k++) {
      r.setStart(text, k);
      r.setEnd(text, k);
      const d = Math.abs(r.getBoundingClientRect().left - x);
      if (d < bestDistance) {
        best = k;
        bestDistance = d;
      }
    }
    return { node: text, offset: best };
  }
  return null;
}

/** Follows a mouse press that began on a link: a click, or (after DRAG_MIN_PX) a text selection from the press point. */
function trackPress(down: ReactPointerEvent): void {
  const x0 = down.clientX;
  const y0 = down.clientY;
  const id = down.pointerId;
  let start: { node: Node; offset: number } | null = null;
  let selecting = false;
  const end = () => {
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('pointercancel', onCancel, true);
    window.removeEventListener('dragstart', noDrag, true);
    if (selecting) {
      dragging = false;
      syncLayers();
    }
  };
  const onMove = (e: PointerEvent) => {
    if (e.pointerId !== id) return;
    if ((e.buttons & 1) === 0) {
      end();
      return;
    }
    if (!selecting) {
      if (Math.hypot(e.clientX - x0, e.clientY - y0) < DRAG_MIN_PX) return;
      selecting = true;
      dragging = true;
      syncLayers();
      start = caretAt(x0, y0);
    }
    const focus = caretAt(e.clientX, e.clientY);
    start ??= focus;
    if (start && focus) document.getSelection()?.setBaseAndExtent(start.node, start.offset, focus.node, focus.offset);
  };
  const onUp = (e: PointerEvent) => {
    if (e.pointerId !== id) return;
    if (selecting) {
      swallowClick = true;
      setTimeout(() => (swallowClick = false), 0);
    }
    end();
  };
  const onCancel = (e: PointerEvent) => {
    if (e.pointerId === id) end();
  };
  // Chrome would start dragging the link, or the text just selected under the pointer, instead of selecting on.
  const noDrag = (e: DragEvent) => e.preventDefault();
  window.addEventListener('dragstart', noDrag, true);
  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('pointercancel', onCancel, true);
}

/**
 * Chrome preconnects to a web link's host the moment the pointer is pressed on it (its anchor preloading reads the href
 * before any listener runs): a DNS look-up and a TLS handshake, before any click. A press on a link may become a text
 * selection, or be dragged off to cancel, and must not reach the network then. So while the pointer is over a web link
 * its href is lifted, and it is put back when the pointer comes up on the link (just before the click that reads it)
 * or leaves it. Hover alone never preconnects. The keyboard (Tab, Enter) never lifts it.
 */
const liftHref = (a: HTMLAnchorElement) => a.removeAttribute('href');
const putHrefBack = (a: HTMLAnchorElement, href: string) => a.setAttribute('href', href);

// ---- the layer ---------------------------------------------------------------------------------------------------

/** A rect in unrotated page space as a rect on the page as shown (turned by `r`), in points: the page's one turn. */
const shownRect: (rect: PdfRect, r: Rotation, w: number, h: number) => PdfRect = turnRect;

/** The page's unrotated size: `page`, or the box read at 100%. */
function sizeOf(box: PageBox, page: PageSize | undefined): { width: number; height: number } {
  if (page) return page;
  const turned = box.rotation % 180 !== 0;
  return { width: (turned ? box.height : box.width) / CSS_PER_PT, height: (turned ? box.width : box.height) / CSS_PER_PT };
}

const pct = (v: number) => `${v * 100}%`;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** The links of one page, as anchors over the page box (PageList's `renderPage` slot). */
export function LinkLayer({ links, box, page, onInternal, pageNumber = (i) => i + 1 }: LinkLayerProps): JSX.Element {
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => register(root.current!), []);
  const { width, height } = sizeOf(box, page);
  const turned = box.rotation % 180 !== 0;
  const shownW = turned ? height : width;
  const shownH = turned ? width : height;

  const onPointerDown = (e: ReactPointerEvent<HTMLAnchorElement>) => {
    if (e.altKey) setAlt(true);
    if (e.button === 0 && e.pointerType === 'mouse' && !e.altKey) trackPress(e);
  };
  // The press is ours (a click, or a selection made by trackPress): no link drag, and the focus stays where it was, so
  // the reading keys keep moving the pages. The keyboard still reaches the links with Tab.
  const onMouseDown = (e: ReactMouseEvent<HTMLAnchorElement>) => {
    if (e.button === 0 && !e.altKey) e.preventDefault();
  };
  const guard = (e: ReactMouseEvent<HTMLAnchorElement>): boolean => {
    // After a drag, and with Alt (Chrome would download a web link on Alt+click), a link does nothing.
    if (!swallowClick && !e.altKey) return false;
    e.preventDefault();
    return true;
  };

  return (
    <div ref={root} className={`sop-link-layer ${styles.layer}`}>
      {links.map((link, k) => {
        const s = shownRect(link.rect, box.rotation, width, height);
        const left = clamp01(s.x / shownW);
        const top = clamp01(s.y / shownH);
        const style = {
          left: pct(left),
          top: pct(top),
          width: pct(clamp01((s.x + s.width) / shownW) - left),
          height: pct(clamp01((s.y + s.height) / shownH) - top),
        };
        const t = link.target;
        if (t.kind === 'page') {
          return (
            <a
              key={k}
              className={`sop-link ${styles.link}`}
              data-kind="page"
              href={`#page=${t.pageIndex + 1}`}
              aria-label={`Go to page ${pageNumber(t.pageIndex)}`}
              draggable={false}
              style={style}
              onPointerDown={onPointerDown}
              onMouseDown={onMouseDown}
              onClick={(e) => {
                if (guard(e)) return;
                e.preventDefault();
                onInternal(t);
              }}
              // A middle click would open the viewer again in a new tab, fetching the PDF again.
              onAuxClick={(e) => e.preventDefault()}
            />
          );
        }
        const href = safeLinkHref(t.url);
        if (href === null) return null;
        return (
          <a
            key={k}
            className={`sop-link ${styles.link}`}
            data-kind="url"
            href={href}
            rel="noopener noreferrer"
            aria-label={href}
            draggable={false}
            style={style}
            onPointerEnter={(e) => liftHref(e.currentTarget)}
            onPointerLeave={(e) => putHrefBack(e.currentTarget, href)}
            onPointerUp={(e) => {
              const a = e.currentTarget;
              putHrefBack(a, href);
              // After the click has read it, lifted again while the pointer is still on the link.
              setTimeout(() => a.matches(':hover') && liftHref(a), 0);
            }}
            onPointerDown={onPointerDown}
            onMouseDown={onMouseDown}
            onClick={guard}
            onAuxClick={guard}
          />
        );
      })}
    </div>
  );
}

export interface PageLinksProps {
  source: PageLinkSource;
  box: PageBox;
  page: PageSize;
  onInternal(this: void, t: PageTarget): void;
  /** R108: the page number shown for a page, for the links' names. */
  pageNumber?: (pageIndex: number) => number;
}

/** Links are read no later than this after their page appears, however busy the page is. */
const LINKS_IDLE_TIMEOUT_MS = 500;

/** A page's LinkLayer, once its links are read (PageLinkSource reads each page once). Nothing for a page without links. */
export function PageLinks({ source, box, page, onInternal, pageNumber }: PageLinksProps): JSX.Element | null {
  const index = box.index;
  const [read, setRead] = useState<{ index: number; links: PdfLink[] } | null>(() => {
    const links = source.cached(index);
    return links ? { index, links } : null;
  });
  useEffect(() => {
    let live = true;
    // Links share the one engine with the page renders: they are read once the main thread is idle, so a page's first
    // render is always asked for first, and pages scrolled past at speed are never read at all.
    const idle = requestIdleCallback(() => void source.get(index).then((links) => live && setRead({ index, links })), { timeout: LINKS_IDLE_TIMEOUT_MS });
    return () => {
      live = false;
      cancelIdleCallback(idle);
    };
  }, [source, index]);
  if (read === null || read.index !== index || read.links.length === 0) return null;
  return <LinkLayer links={read.links} box={box} page={page} onInternal={onInternal} {...(pageNumber ? { pageNumber } : {})} />;
}

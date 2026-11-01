// The numbered pins on figures (Phase 2, S16): one button per pin note, in the page list's overlay so it scrolls with
// the pages, takes clicks above the text layer and is not blended into the page. Each figure's pins are numbered 1, 2,
// 3 … in the order they were made, and the card says the same number. A click opens the pin's card.
import type { ThreadId } from '@sop/core';
import { normToCss, type PageBox, useViewerState, type ViewerStore } from '@sop/viewer';
import type { PageListApi } from '@sop/viewer/react';
import { type RefObject, useCallback, useEffect, useReducer, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { figureName, notePlace, pinNumbers, placedAnchor } from './anchors';
import type { FigureController } from './controller';
import styles from './figures.module.css';

export function FigurePins({ controller }: { controller: FigureController }) {
  const { host } = controller;
  const { session } = host;
  const subscribe = useCallback((cb: () => void) => session.subscribe(cb), [session]);
  const s = useSyncExternalStore(subscribe, () => session.state());
  const overlay = useOverlayHost(host.pageList);
  const tick = useLayoutTick(host.view, overlay);
  void tick; // the boxes below are read again whenever the pages are laid out again

  const boxes = host.pageList.current?.pageBoxes() ?? [];
  const numbers = pinNumbers(s.threads, s.placement);
  const pins: { id: ThreadId; x: number; y: number; n: number; page: number; label: string }[] = [];
  for (const t of s.threads) {
    const a = placedAnchor(t, s.placement.get(t.id));
    const place = notePlace(a);
    const n = numbers.get(t.id);
    if (place?.pin == null || n === undefined || a?.kind !== 'figure') continue;
    const box = boxes[place.page];
    if (!box) continue;
    pins.push({ id: t.id, n, page: place.page, label: figureName(a.figure.label), ...pointInContent(place.pin, box) });
  }
  if (overlay === null || pins.length === 0) return null;
  return createPortal(
    <>
      {pins.map((p) => {
        const active = s.active === p.id;
        return (
          <button
            key={p.id}
            type="button"
            className={styles.pin}
            data-figure-pin={p.n}
            // An active pin is the open card's own: a press on it is not a click away from the card (S14).
            {...(active ? { 'data-note-pin': '' } : {})}
            data-theme="light"
            data-active={active ? 'true' : 'false'}
            style={{ left: p.x, top: p.y }}
            aria-label={`Pin ${p.n} on ${p.label}, Page ${p.page + 1}`}
            aria-pressed={active}
            onClick={() => session.setActive(p.id)}
          >
            {p.n}
          </button>
        );
      })}
    </>,
    overlay,
  );
}

/** The page list's overlay, once its first layout has made it. */
function useOverlayHost(pages: RefObject<PageListApi | null>): HTMLElement | null {
  const [host, setHost] = useState<HTMLElement | null>(() => pages.current?.overlayHost() ?? null);
  useEffect(() => {
    if (host?.isConnected) return;
    let frame = 0;
    const look = () => {
      const el = pages.current?.overlayHost() ?? null;
      if (el) setHost(el);
      else frame = requestAnimationFrame(look);
    };
    look();
    return () => cancelAnimationFrame(frame);
  }, [pages, host]);
  return host;
}

/** Changes whenever the pages are laid out again: a zoom, a rotation, a spread, or the scroll area's size. */
function useLayoutTick(store: ViewerStore, host: HTMLElement | null): string {
  const view = useViewerState(store, (v) => `${v.scale}|${v.viewRotation}|${v.spread}`);
  const [resized, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const sizer = host?.parentElement;
    if (!sizer) return;
    const ro = new ResizeObserver(() => bump());
    ro.observe(sizer);
    return () => ro.disconnect();
  }, [host]);
  return `${view}|${resized}`;
}

/** A 0–1 point of a page (unrotated, as stored) → where it is in the page list's content px. */
function pointInContent(p: readonly [number, number], box: PageBox): { x: number; y: number } {
  const sideways = box.rotation % 180 !== 0;
  const unrotated = { width: sideways ? box.height : box.width, height: sideways ? box.width : box.height };
  const b = normToCss([p[0], p[1], p[0], p[1]], unrotated, 1, box.rotation);
  return { x: box.left + b.x, y: box.top + b.y };
}

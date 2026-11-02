// The words a search jump landed on, picked out for a moment (S15). `hitFlash.show` is called by the jump (jump-to-hit.ts);
// the layer below is a viewer feature, drawn on every page, and draws only on the page the words are on. The rects are the
// ones a selection of the same chars would be painted with, so the band lines up with the text.
import { highlightPath, markLineRects, normToCss, type PageBox, type PdfRect, pdfRectToNorm, type PageSize } from '@sop/viewer';
import type { PageLayerContext } from '@sop/viewer/react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { NotesHost, ViewerFeature } from './annotations/wire';
import styles from './hit-flash.module.css';

export interface Flash {
  pageIndex: number;
  /** The words to pick out: their chars, as PDFium counts them on the page. */
  ranges: readonly { start: number; count: number }[];
}

/** How long the words stay picked out (the animation takes about the same). */
const SHOWN_MS = 2600;

interface Shown extends Flash {
  /** Makes each flash a new element, so its animation starts over. */
  seq: number;
}

let current: Shown | null = null;
let seq = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function set(next: Shown | null): void {
  current = next;
  for (const cb of [...listeners]) cb();
}

export const hitFlash = {
  show(f: Flash): void {
    clearTimeout(timer);
    set({ ...f, seq: ++seq });
    timer = setTimeout(() => set(null), SHOWN_MS);
  },
  clear(): void {
    clearTimeout(timer);
    set(null);
  },
};

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

/** CSS px for a point of the page, for this box (a box keeps the page's aspect ratio). */
const cssPerPoint = (box: PageBox, page: PageSize): number => box.width / (box.rotation % 180 === 0 ? page.width : page.height);

function Words({ host, box, ctx, flash }: { host: NotesHost; box: PageBox; ctx: PageLayerContext; flash: Shown }) {
  const [rects, setRects] = useState<PdfRect[] | null>(null);
  const { pageText } = host;
  useEffect(() => {
    let live = true;
    Promise.all(flash.ranges.map((r) => markLineRects(pageText, flash.pageIndex, r.start, r.count))).then(
      (all) => live && setRects(all.flat()),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [pageText, flash.pageIndex, flash.ranges]);
  const page = host.pages[box.index];
  if (rects === null || page === undefined) return null;
  const k = cssPerPoint(box, page);
  const d = highlightPath(rects.map((r) => normToCss(pdfRectToNorm(r, page), page, k, box.rotation)), { pixelRatio: ctx.dpr });
  return (
    <svg className={styles.flash} aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

function HitFlashLayer({ host, box, ctx }: { host: NotesHost; box: PageBox; ctx: PageLayerContext }) {
  const flash = useSyncExternalStore(subscribe, () => current);
  if (flash === null || flash.pageIndex !== box.index) return null;
  return <Words key={flash.seq} host={host} box={box} ctx={ctx} flash={flash} />;
}

/** Registered with the other viewer features (App.tsx). It has no commands and no view: only the layer. */
export const hitFlashFeature: ViewerFeature = { id: 'hit-flash', PageLayer: HitFlashLayer };

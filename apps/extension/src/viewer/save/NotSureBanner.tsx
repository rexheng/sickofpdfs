// The quiet "not sure" banner (spec, "When the filter is wrong"): on a PDF the filter is not sure about, after 20 seconds
// of reading, a bar under the toolbar offers Save, Not now, Never for this file and "Always save from <the place>". It never
// takes the focus. Not now closes it for this tab, and any of the others settles the question for good.
// R95 (TB4 critics): it never covers the page.
// - It is an inline bar directly under the toolbar: the page list starts below it (`--viewer-banner-h`, which the page area's
//   top inset adds, NavRail.module.css), so the pages move down by its height and nothing is under it.
// - It is centred on the reading area (the page list's visible width), not on the window.
// - Esc means "Not now" (unless a menu, a dialog, a field or another layer used the key first).
// - In the Tab order it comes right after the chip: it is drawn in the header, right after the chip, and placed under the
//   toolbar from there.
// - Its choices are also in the chip's menu (StatusChip.tsx, `notSureChoices`).
// R91: "Always save from …" (TB5: a button with a verb) names the place, on its button and in its note ("Always save from
// moodle.lse.ac.uk", "Always save from the folder Week 3 readings"), and is not there at all for a catch-all place (Downloads,
// a mail attachment, a shared store).
import { Icon, TextButton } from '@sop/ui';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ViewerUi } from '../commands';
import { overlayOpen } from '../annotations/mark-input';
import { isTypingTarget } from '../shortcuts';
import type { SiteRule } from '../filter/rules-source';
import type { SaveControllerImpl } from './save-controller';
import { useSaveView } from './StatusChip';
import styles from './NotSureBanner.module.css';

/** How long the PDF must be on screen as "not sure" before the banner shows. */
export const NOT_SURE_BANNER_MS = 20_000;

export const NOT_SURE_MESSAGE = 'Not sure if this PDF is for learning. Save it to your library?';

/** The CSS variable the page area's top inset adds while the banner is shown: the banner and the gaps over and under it. */
export const BANNER_HEIGHT_VAR = '--viewer-banner-h';
/** The gap between the toolbar and the banner (--space-4) and between the banner and the pages (--space-2), in CSS px. */
const GAP_ABOVE = 16;
const GAP_UNDER = 8;

/** A place's name on the button is cut to this many characters (the note says it in full). */
const PLACE_CHARS = 40;

/** "moodle.lse.ac.uk", or "the folder Week 3 readings". */
export function placeWords(rule: SiteRule, max = Infinity): string {
  const name = rule.place.length > max ? `${rule.place.slice(0, max - 1).trimEnd()}…` : rule.place;
  return rule.kind === 'site' ? name : `the folder ${name}`;
}

/** The button: "Always save from moodle.lse.ac.uk". */
export const alwaysLabel = (rule: SiteRule): string => `Always save from ${placeWords(rule, PLACE_CHARS)}`;

/** The note after it: the place, and what it still never saves (R91). */
export const alwaysNote = (rule: SiteRule): string =>
  `Saved. PDFs from ${placeWords(rule)} will be saved from now on, but never PDFs that look like receipts, statements or CVs.`;

/** The notes after each choice, the same from the banner and from the chip's menu. */
export const SAVED_NOTE = 'Saved to your library.';
export const NEVER_NOTE = 'This file won’t be saved.';
export const FAILED_NOTE = 'Couldn’t do that. Try again.';

export interface NotSureChoice {
  id: 'save' | 'never' | 'always';
  label: string;
  /** The full place name, when the label had to be cut. */
  title?: string;
  run: () => Promise<void>;
  /** The note once it is done. */
  done: string;
}

/** Save, Never for this file and Always save from <place> (when the place may be on the allow list): the banner's and the chip's. */
export function notSureChoices(save: SaveControllerImpl): NotSureChoice[] {
  const out: NotSureChoice[] = [
    { id: 'save', label: 'Save', run: () => save.requestSave(), done: SAVED_NOTE },
    { id: 'never', label: 'Never for this file', run: () => save.neverSave(), done: NEVER_NOTE },
  ];
  const rule = save.siteRule;
  if (rule !== null) {
    const label = alwaysLabel(rule);
    out.push({ id: 'always', label, ...(label.endsWith('…') ? { title: placeWords(rule) } : {}), run: () => save.alwaysForSite(), done: alwaysNote(rule) });
  }
  return out;
}

export interface NotSureBannerProps {
  save: SaveControllerImpl | null;
  /** Its `showNote`: a short note at the bottom of the window, after an action. */
  ui: Pick<ViewerUi, 'showNote'>;
  /** A presentation is showing the pages full screen: the 20-second count pauses (R95). */
  presenting?: boolean;
}

/**
 * Counts time on screen only (R95): the tab visible, its window focused, and not presenting. A tab in the background, a
 * window behind another one, or pages shown full screen in a presentation (where the bar would be hidden, then pop up as
 * it ends) are not being read here. The count pauses and goes on from where it was; a new "not sure" spell starts afresh.
 */
function useVisibleFor(ms: number, running: boolean, presenting: boolean): boolean {
  const [done, setDone] = useState(false);
  const presentingNow = useRef(presenting);
  const recheck = useRef<() => void>(() => {});
  useEffect(() => {
    presentingNow.current = presenting;
    recheck.current();
  }, [presenting]);
  useEffect(() => {
    setDone(false);
    if (!running) return;
    let left = ms;
    let since: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onScreen = (): boolean => document.visibilityState === 'visible' && document.hasFocus() && !presentingNow.current;
    const pause = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (since !== null) left -= performance.now() - since;
      since = null;
    };
    const resume = (): void => {
      if (timer !== null) return;
      since = performance.now();
      timer = setTimeout(() => setDone(true), Math.max(0, left));
    };
    const check = (): void => (onScreen() ? resume() : pause());
    recheck.current = check;
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    window.addEventListener('blur', check);
    check();
    return () => {
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('focus', check);
      window.removeEventListener('blur', check);
      recheck.current = () => {};
      pause();
    };
  }, [ms, running]);
  return running && done;
}

/** The reading area's left edge and visible width (the page list, without its scroll bar), followed as it changes. */
function useReadingArea(on: boolean): { left: number; width: number } | null {
  const [area, setArea] = useState<{ left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    if (!on) return;
    const scroller = document.querySelector<HTMLElement>('[role="document"]');
    if (scroller === null) return;
    const measure = (): void => {
      const r = scroller.getBoundingClientRect();
      const next = { left: Math.round(r.left), width: Math.round(scroller.clientWidth) };
      setArea((a) => (a !== null && a.left === next.left && a.width === next.width ? a : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(scroller);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [on]);
  return on ? area : null;
}

export function NotSureBanner({ save, ui, presenting = false }: NotSureBannerProps) {
  const { state, busy } = useSaveView(save);
  const [closed, setClosed] = useState<SaveControllerImpl | null>(null);
  const unsure = save !== null && state?.kind === 'unsure' && busy === null && save.hasRules;
  const due = useVisibleFor(NOT_SURE_BANNER_MS, unsure, presenting);
  const shown = unsure && due && closed !== save;
  const area = useReadingArea(shown);
  const bar = useRef<HTMLDivElement>(null);
  /** The banner's button had the focus and is going: the chip, its neighbour in the Tab order, takes it. */
  const focusChip = (): void => {
    if (bar.current?.contains(document.activeElement) !== true) return;
    bar.current.parentElement?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
  };

  // The pages start under the banner while it is shown (R95): its height and the gaps go to the page area's top inset.
  useLayoutEffect(() => {
    const el = bar.current;
    if (!shown || el === null) return;
    const root = document.documentElement;
    const set = (): void => root.style.setProperty(BANNER_HEIGHT_VAR, `${GAP_ABOVE + Math.ceil(el.getBoundingClientRect().height) + GAP_UNDER}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty(BANNER_HEIGHT_VAR);
    };
  }, [shown]);

  // Esc means "Not now" (R95): from the banner itself, or from the pages when nothing else used the key.
  useEffect(() => {
    if (!shown || save === null) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
      const inBanner = bar.current?.contains(document.activeElement) === true;
      if (!inBanner && (isTypingTarget(e.target) || overlayOpen())) return;
      if (inBanner) bar.current?.parentElement?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
      setClosed(save);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shown, save]);

  if (!shown || save === null) return null;

  const close = (): void => {
    focusChip();
    setClosed(save);
  };
  const act = (c: NotSureChoice): void => {
    close();
    c.run().then(
      () => ui.showNote(c.done),
      () => ui.showNote(FAILED_NOTE),
    );
  };
  const [first, ...rest] = notSureChoices(save);

  return (
    <div ref={bar} className={styles.place} style={area === null ? { visibility: 'hidden' } : { left: area.left, width: area.width }}>
      <div role="status" className={styles.banner}>
        <div className={styles.row}>
          <Icon name="library_add" size={20} className={styles.icon} />
          <p className={styles.message}>{NOT_SURE_MESSAGE}</p>
        </div>
        <div className={styles.actions}>
          {first !== undefined && <TextButton label={first.label} title={first.title} onClick={() => act(first)} />}
          <TextButton label="Not now" onClick={close} />
          {rest.map((c) => (
            <TextButton key={c.id} label={c.label} title={c.title} onClick={() => act(c)} />
          ))}
        </div>
      </div>
    </div>
  );
}

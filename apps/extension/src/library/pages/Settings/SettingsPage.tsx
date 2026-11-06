// Settings (plan S14): every section of the registry (settings/sections.ts) on one page, one under the other, with Drive's
// section list on the left so the owner can jump to one. The address names a section (`#/settings/backup`), so a link or a
// bookmark opens it there; the list follows the scrolling.
import { Icon } from '@sop/ui';
import { ContentCard, PageTitle } from '@sop/ui/library';
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { SETTINGS_SECTIONS } from '../../settings/sections';
import styles from './Settings.module.css';

/** Below this width (px) of the card's body, the section list steps aside and the sections take the whole width. */
const LIST_MIN = 860;
/**
 * A section counts as the current one once its top is this close to the top of the page (px), or has come into the top third
 * of the window, whichever is more (TB6: with only 96 px, a section whose heading was well in view still left the list on the
 * one above it, "Online lookups" while Claude was on screen).
 */
const CURRENT_AT = 96;
const CURRENT_FRACTION = 1 / 3;
/** After a jump, the scrolling it causes does not move the list's choice for this long (ms). */
const JUMP_MS = 800;

const sectionOfHash = (hash: string): string | null => {
  const id = /^#\/settings\/([a-z]+)/.exec(hash)?.[1];
  return SETTINGS_SECTIONS.some((s) => s.id === id) ? (id ?? null) : null;
};
const slotId = (id: string) => `settings-${id}`;

function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    setWidth(el.clientWidth);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

export function SettingsPage() {
  const body = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState<string>(SETTINGS_SECTIONS[0]?.id ?? '');
  const jumpedAt = useRef(0);
  const width = useWidth(body);
  const withList = width === 0 || width >= LIST_MIN;

  const jump = useCallback((id: string) => {
    const el = document.getElementById(slotId(id));
    if (el === null) return;
    jumpedAt.current = performance.now();
    setCurrent(id);
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
  }, []);

  // The section the address names: on opening, and when a link changes it.
  useEffect(() => {
    const follow = () => {
      const id = sectionOfHash(location.hash);
      if (id !== null) jump(id);
    };
    follow();
    // The sections above may grow as their data comes in, so on opening the jump is made again once they have.
    const again = setTimeout(() => {
      const id = sectionOfHash(location.hash);
      if (id !== null && performance.now() - jumpedAt.current < 2 * JUMP_MS) jump(id);
    }, JUMP_MS);
    addEventListener('hashchange', follow);
    return () => {
      clearTimeout(again);
      removeEventListener('hashchange', follow);
    };
  }, [jump]);

  // The list follows the scrolling: the last section whose top has reached the top of the page.
  useEffect(() => {
    const scroller = body.current;
    if (scroller === null) return;
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (performance.now() - jumpedAt.current < JUMP_MS) return;
        const top = scroller.getBoundingClientRect().top;
        const reach = Math.max(CURRENT_AT, scroller.clientHeight * CURRENT_FRACTION);
        let id = SETTINGS_SECTIONS[0]?.id ?? '';
        for (const s of SETTINGS_SECTIONS) {
          const el = document.getElementById(slotId(s.id));
          if (el !== null && el.getBoundingClientRect().top - top <= reach) id = s.id;
        }
        if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) id = SETTINGS_SECTIONS.at(-1)?.id ?? id;
        setCurrent(id);
      });
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <ContentCard header={<PageTitle title="Settings" />} bodyRef={body}>
      <div className={withList ? styles.layout : `${styles.layout} ${styles.narrow}`}>
        {withList && (
          <nav className={styles.list} aria-label="Settings sections">
            <ul className={styles.items}>
              {SETTINGS_SECTIONS.map((s) => {
                const on = s.id === current;
                return (
                  <li key={s.id}>
                    <a
                      href={`#/settings/${s.id}`}
                      className={on ? `${styles.item} ${styles.on}` : styles.item}
                      aria-current={on ? 'true' : undefined}
                      onClick={(e) => {
                        // the address changes too (so Back and a bookmark work); a second click on the same one still jumps
                        if (sectionOfHash(location.hash) === s.id) {
                          e.preventDefault();
                          jump(s.id);
                        }
                      }}
                    >
                      <Icon name={s.icon} size={20} filled={on} />
                      <span className={styles.label}>{s.label}</span>
                    </a>
                  </li>
                );
              })}
            </ul>
          </nav>
        )}
        <div className={styles.sections}>
          {SETTINGS_SECTIONS.map(({ id, Component }) => (
            <div key={id} id={slotId(id)} className={styles.slot}>
              <Component />
            </div>
          ))}
        </div>
      </div>
    </ContentCard>
  );
}

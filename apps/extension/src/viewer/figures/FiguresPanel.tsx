// The rail's Figures tab for the open document (Phase 2, S16): every outlined figure and table, found page by page.
//
// - The pages already searched (at idle after their full render) show at once. While the tab is open, the rest are
//   searched one at a time at idle, so the search never holds up drawing a page; it stops when the tab closes and goes
//   on from there next time.
// - Only figures that get an outline are listed (OUTLINE_RULE): a wrong entry is worse than none.
// - A click or Enter goes to the figure through the jump history (Back returns) and selects it.
import { isOutlined } from '@sop/viewer';
import { FiguresTab, type FiguresTabItem } from '@sop/viewer/react';
import { useCallback, useEffect, useMemo, useReducer, useState, useSyncExternalStore } from 'react';
import type { NotesHost } from '../annotations/wire';
import { goToSpot } from '../notes-panel/navigate';
import { figureName, figureRect, type FoundFigure } from './anchors';
import { thumbKey, thumbnailBlob } from './images';
import { controllerOf } from './registry';

/** Waits for an idle moment (at most a second). */
function idle(): { wait: Promise<void>; cancel: () => void } {
  let cancel = () => {};
  const wait = new Promise<void>((resolve) => {
    const id = requestIdleCallback(() => resolve(), { timeout: 1000 });
    cancel = () => cancelIdleCallback(id);
  });
  return { wait, cancel };
}

const keyOf = (f: FoundFigure) => `${f.page}:${f.figure.index}`;

export function FiguresPanel({ host }: { host: NotesHost }) {
  const c = controllerOf(host);
  const { figures, pages } = host;
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => figures.subscribe(() => bump()), [figures]);
  useSyncExternalStore(c.thumbnails.subscribe, c.thumbnails.version);
  const selected = useSyncExternalStore(c.subscribe, () => c.state().selected);
  const [wanted, setWanted] = useState<ReadonlySet<string>>(() => new Set());

  // Searches the pages not searched yet, one at a time, at idle, while the tab is open.
  useEffect(() => {
    let live = true;
    let stop = () => {};
    void (async () => {
      for (let i = 0; i < pages.length && live; i++) {
        if (figures.peek(i) !== undefined) continue;
        const w = idle();
        stop = w.cancel;
        await w.wait;
        if (!live) return;
        await figures.figures(i).catch(() => {});
        bump();
      }
    })();
    return () => {
      live = false;
      stop();
    };
  }, [figures, pages]);

  const found: FoundFigure[] = [];
  let searched = 0;
  for (let page = 0; page < pages.length; page++) {
    const list = figures.peek(page);
    const size = pages[page];
    if (list === undefined || size === undefined) continue;
    searched++;
    for (const figure of list) if (isOutlined(figure)) found.push({ page, figure, rect: figureRect(figure, size) });
  }
  const byKey = new Map(found.map((f) => [keyOf(f), f]));
  const items: FiguresTabItem[] = found.map((f) => {
    const key = keyOf(f);
    const size = pages[f.page];
    const thumbnail =
      wanted.has(key) && size !== undefined ? c.thumbnails.get(thumbKey(f.page, f.rect, null), () => thumbnailBlob(host.backend, host.doc, f.page, size, f.rect, null)) : null;
    return { key, label: figureName(f.figure.label, f.figure.kind), pageIndex: f.page, thumbnail };
  });

  const onShow = useCallback((key: string) => setWanted((w) => (w.has(key) ? w : new Set([...w, key]))), []);
  const onSelect = (item: FiguresTabItem) => {
    const f = byKey.get(item.key);
    const api = host.pageList.current;
    if (!f || !api) return;
    goToSpot({ pageIndex: f.page, x: f.rect[0], y: f.rect[1] }, { jumps: host.jumps, api, pages, scale: host.view.get().scale });
    c.select(f);
  };
  const progress = useMemo(() => (searched < pages.length ? { done: searched, total: pages.length } : null), [searched, pages.length]);
  return <FiguresTab items={items} progress={progress} selectedKey={selected === null ? null : keyOf(selected)} onSelect={onSelect} onShow={onShow} />;
}

// The quiet "not sure" banner (spec, "When the filter is wrong"): on a PDF the filter is not sure about, after 20 seconds
// of reading, a notice under the toolbar pill offers Save, Not now, Never for this file and Always for this site (a folder,
// for a file on this computer). It never takes the focus and never covers the page's text for long: Not now closes it for
// this tab, and any of the others settles the question for good.
import { Icon, TextButton } from '@sop/ui';
import { useEffect, useState } from 'react';
import type { ViewerUi } from '../commands';
import type { SaveControllerImpl } from './save-controller';
import { useSaveView } from './StatusChip';
import styles from './NotSureBanner.module.css';

/** How long the PDF must be on screen as "not sure" before the banner shows. */
export const NOT_SURE_BANNER_MS = 20_000;

export const NOT_SURE_MESSAGE = 'Not sure if this PDF is for learning. Save it to your library?';

export interface NotSureBannerProps {
  save: SaveControllerImpl | null;
  /** Its `showNote`: a short note at the bottom of the window, after an action. */
  ui: Pick<ViewerUi, 'showNote'>;
}

/** Counts time on screen only: a tab in the background is not being read. */
function useVisibleFor(ms: number, running: boolean): boolean {
  const [done, setDone] = useState(false);
  useEffect(() => {
    setDone(false);
    if (!running) return;
    let left = ms;
    let since: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const pause = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (since !== null) left -= performance.now() - since;
      since = null;
    };
    const resume = (): void => {
      if (timer !== null || document.visibilityState !== 'visible') return;
      since = performance.now();
      timer = setTimeout(() => setDone(true), Math.max(0, left));
    };
    const onVisibility = (): void => (document.visibilityState === 'visible' ? resume() : pause());
    document.addEventListener('visibilitychange', onVisibility);
    resume();
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      pause();
    };
  }, [ms, running]);
  return running && done;
}

export function NotSureBanner({ save, ui }: NotSureBannerProps) {
  const { state, busy } = useSaveView(save);
  const [closed, setClosed] = useState<SaveControllerImpl | null>(null);
  const unsure = save !== null && state?.kind === 'unsure' && busy === null && save.hasRules;
  const due = useVisibleFor(NOT_SURE_BANNER_MS, unsure);
  if (!unsure || !due || closed === save) return null;

  const close = (): void => setClosed(save);
  const act = (p: Promise<void>, done: string): void => {
    close();
    p.then(
      () => ui.showNote(done),
      () => ui.showNote('Couldn’t do that. Try again.'),
    );
  };
  const rule = save.siteRule;
  const actions: { label: string; run: () => void }[] = [
    { label: 'Save', run: () => act(save.requestSave(), 'Saved to your library.') },
    { label: 'Not now', run: close },
    { label: 'Never for this file', run: () => act(save.neverSave(), 'This file won’t be saved.') },
  ];
  if (rule !== null) {
    const where = rule.kind === 'site' ? 'site' : 'folder';
    actions.push({
      label: `Always for this ${where}`,
      run: () => act(save.alwaysForSite(), rule.kind === 'site' ? `Saved. PDFs from ${rule.entry} will be saved from now on.` : 'Saved. PDFs from this folder will be saved from now on.'),
    });
  }

  return (
    <div className={styles.place}>
      <div role="status" className={styles.banner}>
        <div className={styles.row}>
          <Icon name="library_add" size={20} className={styles.icon} />
          <p className={styles.message}>{NOT_SURE_MESSAGE}</p>
        </div>
        <div className={styles.actions}>
          {actions.map((a) => (
            <TextButton key={a.label} label={a.label} onClick={a.run} />
          ))}
        </div>
      </div>
    </div>
  );
}

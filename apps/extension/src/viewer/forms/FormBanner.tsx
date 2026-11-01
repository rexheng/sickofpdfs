// What the viewer says about a PDF with fillable fields (Task 31): either that it is reopening in Chrome's viewer, or,
// when the link can't be fetched again, that it stays here (with a close button).
import { Banner } from '@sop/ui';
import type { PdfBackend } from '@sop/viewer';
import { useEffect, useState } from 'react';
import type { OpenedDocument } from '../open-document';
import type { SaveControllerImpl } from '../save/save-controller';
import { runFormBounce } from './form-bounce';
import styles from './FormBanner.module.css';

export const OPENING_IN_CHROME = "This PDF has fillable fields. Opening it in Chrome's viewer so you can fill it in…";
export const STAYS_HERE = "This PDF has fillable fields. Chrome's viewer can't reopen it from this link, so it stays here.";

export type FormNotice = 'opening' | 'stays';

export interface FormBannerProps {
  /** `opening`: the tab is about to go to Chrome's viewer. `stays`: it can't, so the PDF stays here. */
  kind: FormNotice;
  /** Closes the `stays` banner. */
  onDismiss: () => void;
}

/** A quiet notice over the top of the pages, under the toolbar pill. It never takes the focus. */
export function FormBanner({ kind, onDismiss }: FormBannerProps) {
  return (
    <div className={styles.place}>
      <div className={styles.banner}>
        {kind === 'opening' ? <Banner message={OPENING_IN_CHROME} /> : <Banner message={STAYS_HERE} onDismiss={onDismiss} />}
      </div>
    </div>
  );
}

/**
 * Runs the form check once per save controller (after its decision), and says which notice to show: null for none.
 * `dismiss` closes the `stays` banner.
 */
export function useFormBounce(o: {
  opened: OpenedDocument | null;
  save: SaveControllerImpl | null;
  source: string | null;
  backend: PdfBackend;
}): { notice: FormNotice | null; dismiss: () => void } {
  const { opened, save, source, backend } = o;
  const [notice, setNotice] = useState<{ for: SaveControllerImpl; kind: FormNotice } | null>(null);
  useEffect(() => {
    if (opened === null || save === null) return;
    let live = true;
    void runFormBounce({
      opened,
      backend,
      save,
      source,
      onAction: (action) => live && setNotice({ for: save, kind: action === 'bounce' ? 'opening' : 'stays' }),
    });
    return () => {
      live = false;
    };
  }, [opened, save, source, backend]);
  return { notice: notice !== null && notice.for === save ? notice.kind : null, dismiss: () => setNotice(null) };
}

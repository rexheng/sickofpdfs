import { Dialog, TextField } from '@sop/ui';
import { type KeyboardEvent, useId, useRef, useState } from 'react';
import { Choice } from '../save/Choice';
import saveStyles from '../save/SaveDialogs.module.css';
import { pagesToPrint } from './print';
import styles from './PrintDialog.module.css';

/** What Ctrl+P asks about (R99): the document's pages, the page in view, and whether it has marks that could print. */
export interface PrintAsk {
  pageCount: number;
  /** The page in view, 0-based ("This page"). */
  currentPage: number;
  /** The document has marks: the "Print my marks too" box shows. */
  marks: boolean;
}

/** The answer: the pages to print (0-based, in order) and whether the marks print on them. */
export interface PrintChoice {
  pages: number[];
  withMarks: boolean;
}

export interface PrintDialogProps {
  ask: PrintAsk;
  /** Called once: the choice, or null for Cancel, Escape or a click outside (nothing prints). */
  onAnswer(this: void, choice: PrintChoice | null): void;
}

type Range = 'all' | 'this' | 'pages';

/**
 * Ctrl+P's first step (R99): which pages print (All, This page, or Pages such as 3–7), and, when the PDF has marks,
 * whether they print too (ticked: printing is not destructive). Only the chosen pages are drawn, so one chapter of a
 * book prints at once. "Print" has the focus, and Enter anywhere in the dialog means Print, never Cancel. Escape, a click
 * outside and Cancel print nothing. Plain words: it says what prints and what does not.
 */
export function PrintDialog({ ask, onAnswer }: PrintDialogProps) {
  const [range, setRange] = useState<Range>('all');
  const [typed, setTyped] = useState('');
  const [marks, setMarks] = useState(true);
  const [wrong, setWrong] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const name = useId();
  const hint = useId();
  const { pageCount, currentPage } = ask;

  const print = (): void => {
    const pages = range === 'all' ? pagesToPrint('', pageCount) : range === 'this' ? [currentPage] : typed.trim() === '' ? null : pagesToPrint(typed, pageCount);
    if (pages === null || pages.length === 0) {
      setRange('pages');
      setWrong(true);
      field.current?.focus();
      return;
    }
    onAnswer({ pages, withMarks: ask.marks && marks });
  };
  // Enter anywhere but on a button (which does its own thing) means Print.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing || (e.target instanceof HTMLElement && e.target.closest('button') !== null)) return;
    e.preventDefault();
    print();
  };

  return (
    <Dialog
      open
      focusPrimary
      title="Print"
      actions={[
        { label: 'Cancel', onClick: () => onAnswer(null) },
        { label: 'Print', primary: true, onClick: print },
      ]}
      onOpenChange={(open) => !open && onAnswer(null)}
    >
      <div onKeyDown={onKeyDown}>
        <div role="radiogroup" aria-label="Pages to print" className={saveStyles.choices}>
          <Choice type="radio" name={name} label={`All pages (${pageCount})`} checked={range === 'all'} onChange={() => setRange('all')} />
          <Choice type="radio" name={name} label={`This page (page ${currentPage + 1})`} checked={range === 'this'} onChange={() => setRange('this')} />
          <div className={styles.pagesRow}>
            <Choice type="radio" name={name} label="Pages" checked={range === 'pages'} onChange={() => setRange('pages')} />
            <TextField
              ref={field}
              className={styles.pagesField}
              label="Pages to print, such as 3–7"
              placeholder="e.g. 3–7"
              value={typed}
              width={120}
              invalid={wrong}
              aria-describedby={hint}
              onFocus={() => setRange('pages')}
              onChange={(v) => {
                setTyped(v);
                setRange('pages');
                setWrong(false);
              }}
            />
          </div>
        </div>
        <p id={hint} className={styles.wrong} role="status">
          {wrong ? `Type pages from 1 to ${pageCount}, like 3–7 or 1, 4, 9.` : ''}
        </p>
        {ask.marks && (
          <div className={styles.marks}>
            <Choice type="checkbox" label="Print my marks too" checked={marks} onChange={setMarks} />
            <p className={saveStyles.small}>Your highlights, underlines and other marks print just as you see them. Your notes don’t print.</p>
          </div>
        )}
      </div>
    </Dialog>
  );
}

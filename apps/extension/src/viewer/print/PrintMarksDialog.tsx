import { Dialog } from '@sop/ui';
import cards from '../ui/cards.module.css';

export interface PrintMarksDialogProps {
  /** 'with' prints the marks on the pages, 'without' prints the plain pages, null prints nothing. Called once. */
  onAnswer(this: void, choice: 'with' | 'without' | null): void;
}

/**
 * Ctrl+P on a PDF that has marks (print.ts): should they print too? Escape, a click outside and Cancel print nothing.
 * Plain words: it says what prints and what does not, and the buttons say what they do.
 */
export function PrintMarksDialog({ onAnswer }: PrintMarksDialogProps) {
  return (
    <Dialog
      open
      title="Print your marks too?"
      actions={[
        { label: 'Cancel', onClick: () => onAnswer(null) },
        { label: 'Print without marks', onClick: () => onAnswer('without') },
        { label: 'Print with marks', primary: true, onClick: () => onAnswer('with') },
      ]}
      onOpenChange={(open) => !open && onAnswer(null)}
    >
      <p className={cards.body}>Your highlights, underlines and other marks can print on the pages, just as you see them.</p>
      <p className={cards.body}>Your notes don’t print.</p>
    </Dialog>
  );
}

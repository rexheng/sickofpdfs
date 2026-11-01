// "Report a wrong decision" (File menu): the owner says what the PDF really is. Only that label and a salted fingerprint of
// the file are kept, on this computer (spec, "Local traces"); never the file, its name or its text.
import { Dialog } from '@sop/ui';
import { useEffect, useId, useState } from 'react';
import type { FilterReportLabel } from '../../local-only/secrets-store';
import cards from '../ui/cards.module.css';
import type { ViewerUi } from '../commands';
import type { SaveControllerImpl } from './save-controller';
import { Choice } from './Choice';
import styles from './SaveDialogs.module.css';

export const REPORT_TITLE = 'Report a wrong decision';

const CHOICES: { label: FilterReportLabel; text: string }[] = [
  { label: 'learning', text: 'It’s for learning. It should be saved.' },
  { label: 'not-learning', text: 'It’s not for learning. It shouldn’t be saved.' },
];

export interface ReportDialogProps {
  save: SaveControllerImpl;
  open: boolean;
  onClose: () => void;
  ui: Pick<ViewerUi, 'showNote'>;
}

/** The answer that disagrees with what happened: a saved PDF was wrongly saved, an unsaved one wrongly skipped. */
function likelyAnswer(save: SaveControllerImpl): FilterReportLabel {
  return save.state.kind === 'saved' ? 'not-learning' : 'learning';
}

export function ReportDialog({ save, open, onClose, ui }: ReportDialogProps) {
  const [answer, setAnswer] = useState<FilterReportLabel>(() => likelyAnswer(save));
  const name = useId();
  useEffect(() => {
    if (open) setAnswer(likelyAnswer(save));
  }, [open, save]);

  const send = (): void => {
    onClose();
    save.report(answer).then(
      () => ui.showNote('Thanks. Your report is kept on this computer only.'),
      () => ui.showNote('Couldn’t keep your report. Try again.'),
    );
  };

  return (
    <Dialog
      open={open}
      title={REPORT_TITLE}
      actions={[
        { label: 'Cancel', onClick: onClose },
        { label: 'Report', primary: true, onClick: send },
      ]}
      onOpenChange={(o) => !o && onClose()}
    >
      <p className={cards.body}>What is this PDF?</p>
      <div role="radiogroup" aria-label="What is this PDF?" className={styles.choices}>
        {CHOICES.map((c) => (
          <Choice key={c.label} type="radio" name={name} label={c.text} checked={answer === c.label} onChange={() => setAnswer(c.label)} />
        ))}
      </div>
      <p className={styles.small}>Only your answer and a scrambled code for this file are kept, on this computer. The file itself is not kept.</p>
    </Dialog>
  );
}

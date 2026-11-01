// The save decision's dialogs and notes, mounted once in App.tsx (Phase 3, S11): "Forget this PDF" and "Report a wrong
// decision" (opened by the commands and the saved chip, save-dialogs.ts), and the warning line of a PDF with card or bank
// numbers that the owner saved anyway (D9).
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { ViewerUi } from '../commands';
import { ForgetDialog } from './ForgetDialog';
import { ReportDialog } from './ReportDialog';
import type { SaveControllerImpl } from './save-controller';
import { closeSaveDialog, useSaveDialog } from './save-dialogs';

export interface SaveDialogsProps {
  save: SaveControllerImpl | null;
  /** Its `showNote`: a short note at the bottom of the window (the App's snackbar). */
  ui: Pick<ViewerUi, 'showNote'>;
}

export function SaveDialogs({ save, ui }: SaveDialogsProps) {
  const open = useSaveDialog();
  const subscribe = useCallback((cb: () => void) => save?.subscribe(cb) ?? (() => {}), [save]);
  const warning = useSyncExternalStore(subscribe, () => save?.saveWarning ?? null);
  // D9: said once, when the save by choice is done; the saved chip's tooltip keeps saying it.
  useEffect(() => {
    if (warning !== null) ui.showNote(warning);
  }, [warning, ui]);
  // A new PDF in the tab closes what was open for the last one.
  useEffect(() => closeSaveDialog, [save]);
  if (save === null || !save.hasRules) return null;
  return (
    <>
      <ForgetDialog save={save} open={open === 'forget'} onClose={closeSaveDialog} />
      <ReportDialog save={save} open={open === 'report'} onClose={closeSaveDialog} ui={ui} />
    </>
  );
}

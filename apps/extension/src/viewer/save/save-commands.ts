// The File menu's "Forget this PDF" (Ctrl+Shift+Delete) and "Report a wrong decision" (Phase 3, S11). Registered with the
// other commands in App.tsx; neither is shown in Incognito, where nothing is saved and there is nothing to report.
import type { CommandBehaviour, ViewerCommandId } from '../commands';
import type { SaveControllerImpl } from './save-controller';
import { openSaveDialog } from './save-dialogs';

export function saveDecisionCommands(save: SaveControllerImpl | null): Partial<Record<ViewerCommandId, CommandBehaviour>> {
  if (save === null || !save.hasRules) return {};
  return {
    'file.forget': {
      run: () => openSaveDialog('forget'),
      enabled: () => save.state.kind === 'saved' && save.busy === null,
      disabledReason: () => (save.state.kind === 'saved' ? 'wait until it has finished saving' : 'this PDF isn’t in your library'),
    },
    'file.reportDecision': {
      run: () => openSaveDialog('report'),
      enabled: () => save.state.kind !== 'checking' && save.state.kind !== 'incognito',
      disabledReason: () => 'still checking this PDF',
    },
  };
}

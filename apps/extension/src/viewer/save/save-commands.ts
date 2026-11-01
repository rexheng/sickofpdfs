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
      // Not tied to `busy`: the menus are rebuilt when the save state changes, not when a save ends; Forget waits for it.
      enabled: () => save.state.kind === 'saved',
      disabledReason: () => 'this PDF isn’t in your library',
    },
    'file.reportDecision': {
      run: () => openSaveDialog('report'),
      enabled: () => save.state.kind !== 'checking' && save.state.kind !== 'incognito',
      disabledReason: () => 'still checking this PDF',
    },
  };
}

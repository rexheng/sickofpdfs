// File → About this PDF (S18): opens the details panel, or closes it when it is open.
import type { CommandBehaviour, ViewerCommandId } from '../commands';
import { aboutPanel } from './about-panel-state';

export function aboutCommands(): Partial<Record<ViewerCommandId, CommandBehaviour>> {
  return { 'file.about': { run: () => aboutPanel.toggle(), enabled: () => true } };
}

// The area tool in the toolbar pill (spec "Figures and areas": "Alt+drag, or the area tool in the toolbar, draws any
// rectangle"). Pressed, the next drag on the pages draws a rectangle and opens a note on it; Esc lets the tool go. It is
// the 'tools.area' command ("Area note"), so the Tools menu has it too. Hidden where there are no notes (Incognito).
import { IconButton } from '@sop/ui';
import { useSyncExternalStore } from 'react';
import type { ViewerCommands } from '../commands';
import { areaToolOn, subscribeAreaTool } from './controller';

export function AreaToolButton({ commands }: { commands: ViewerCommands }) {
  const on = useSyncExternalStore(subscribeAreaTool, areaToolOn);
  const cmd = commands.get('tools.area');
  if (cmd === undefined || !cmd.built) return null;
  return (
    <IconButton
      icon={cmd.icon ?? 'select'}
      label={on ? 'Area note: drag on the page' : cmd.label}
      pressed={on}
      disabled={!cmd.enabled()}
      // Keep the selection and the focus where they are: the drag that follows is what counts.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => cmd.run()}
    />
  );
}

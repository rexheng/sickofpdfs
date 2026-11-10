// The web's version of apps/extension/src/viewer/notes-panel/PanelEdge.tsx (swapped in by vite.config.ts; same props): on a
// phone the notes panel is the phone app's bottom sheet, with its grip; on a computer, the panel's resize edge.
import type { PanelEdgeProps } from '@ext/viewer/notes-panel/PanelEdge';
import { PanelEdge as DeskEdge } from '@ext/viewer/notes-panel/PanelEdge';
import { PanelEdge as SheetGrip } from '@mobile/phone/SheetGrip';
import { PHONE_LAYOUT } from '../layout';

export type { PanelEdgeProps } from '@ext/viewer/notes-panel/PanelEdge';

export function PanelEdge(p: PanelEdgeProps) {
  return PHONE_LAYOUT ? <SheetGrip {...p} /> : <DeskEdge {...p} />;
}

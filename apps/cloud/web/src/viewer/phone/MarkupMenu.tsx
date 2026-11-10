// The web's version of apps/extension/src/viewer/annotations/MarkupMenu.tsx (swapped in by vite.config.ts; same props): on a
// phone, the phone app's action bar over a touch selection (with its handles, touch-select.ts); on a computer, the
// extension's right-click menu.
import type { MarkupMenuProps } from '@ext/viewer/annotations/MarkupMenu';
import { MarkupMenu as DeskMenu } from '@ext/viewer/annotations/MarkupMenu';
import { MarkupMenu as PhoneBar } from '@mobile/phone/SelectionBar';
import { PHONE_LAYOUT } from '../layout';

export type { MarkupMenuProps } from '@ext/viewer/annotations/MarkupMenu';

export function MarkupMenu(p: MarkupMenuProps) {
  return PHONE_LAYOUT ? <PhoneBar {...p} /> : <DeskMenu {...p} />;
}

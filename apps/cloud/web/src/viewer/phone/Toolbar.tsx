// The web's version of apps/extension/src/viewer/chrome/Toolbar.tsx (swapped in by vite.config.ts; same props): the phone
// app's page chip on a phone (pinch and double-tap zoom there), the extension's toolbar pill on a computer.
import type { ToolbarProps } from '@ext/viewer/chrome/Toolbar';
import { Toolbar as DeskToolbar } from '@ext/viewer/chrome/Toolbar';
import { Toolbar as PhoneToolbar } from '@mobile/phone/PhoneToolbar';
import { PHONE_LAYOUT } from '../layout';

export type { ToolbarProps, ToolbarView } from '@ext/viewer/chrome/Toolbar';

export function Toolbar(p: ToolbarProps) {
  return PHONE_LAYOUT ? <PhoneToolbar {...p} /> : <DeskToolbar {...p} />;
}

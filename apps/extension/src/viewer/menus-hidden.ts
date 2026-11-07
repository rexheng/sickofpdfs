// "Hide the menus" (as Google Docs has it): the title and menu row is folded away so the toolbar pill sits at the top and
// the page gains its height. Remembered on this computer for every PDF and followed live by every viewer tab
// (remembered-switch.ts). Open at first. The value is one boolean: nothing about any PDF is stored.
import { rememberedSwitch, useSwitch } from './remembered-switch';

/** The chrome.storage.local key: true when the owner has hidden the menus. */
export const MENUS_HIDDEN_KEY = 'view.menusHidden';

export const menusHiddenSwitch = rememberedSwitch(MENUS_HIDDEN_KEY, 'hide the menus');

/** Whether the menus are hidden now; re-renders when it changes (in this tab or another). */
export function useMenusHidden(): boolean {
  return useSwitch(menusHiddenSwitch);
}

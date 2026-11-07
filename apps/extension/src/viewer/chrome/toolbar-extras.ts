// What the toolbar pill carries while "Hide the menus" is on (menus-hidden.ts): the header is folded away, so the save
// status chip (in its short form) and the header's other actions move here. App.tsx provides it; the pill reads it.
import type { MenuItemDef } from '@sop/ui';
import { createContext, type ReactNode } from 'react';

export interface ToolbarExtras {
  /** The compact save status chip, shown at the right of the pill while the menus are hidden. */
  chip: ReactNode;
  /** Rows for the pill's "More" menu while the menus are hidden ("Back to page"). */
  moreRows: MenuItemDef[];
}

export const ToolbarExtrasContext = createContext<ToolbarExtras>({ chip: null, moreRows: [] });

// Which component draws each page. Each page's slice registers it here with one line (plan Phase 3 rules): S7 has My
// library, Recent, Starred and Trash; S14 adds Home, Notes and Settings.
import type { ComponentType } from 'react';
import { MyLibraryPage } from '../pages/MyLibrary';
import { RecentPage } from '../pages/Recent';
import { StarredPage } from '../pages/Starred';
import { TrashPage } from '../pages/Trash';
import type { RouteId } from './routes';

export const PAGES: Partial<Record<RouteId, ComponentType>> = {
  library: MyLibraryPage,
  recent: RecentPage,
  starred: StarredPage,
  trash: TrashPage,
};

/** Where the library opens: Home once it exists, else My library. */
export const DEFAULT_ROUTE: RouteId = PAGES.home !== undefined ? 'home' : 'library';

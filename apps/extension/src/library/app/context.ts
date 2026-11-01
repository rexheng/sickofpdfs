import type { SnackbarMessage } from '@sop/ui/library';
import { createContext, useContext } from 'react';
import type { ThumbnailCache } from '../data/thumbnails';
import type { LibraryData } from '../data/types';

export interface LibraryContextValue {
  data: LibraryData;
  thumbnails: ThumbnailCache;
  /** Shows a message in the snackbar (bottom left). */
  notify(this: void, message: Omit<SnackbarMessage, 'id'>): void;
  /** What is typed in the search pill. */
  search: string;
  /** Opens the file picker of "+ New" → Open file. */
  pickFile(this: void): void;
}

export const LibraryContext = createContext<LibraryContextValue | null>(null);

export function useLibrary(): LibraryContextValue {
  const value = useContext(LibraryContext);
  if (value === null) throw new Error('useLibrary outside the library app');
  return value;
}

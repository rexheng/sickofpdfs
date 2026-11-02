// "Open original link" for a reading that was opened from its saved copy (`?doc=`, S15): the link it was last opened from,
// read from the library once the viewer has connected to it. Null for any other PDF, and while it is not known.
import type { DocumentId } from '@sop/core';
import { useEffect, useState } from 'react';
import { isOpenableUrl } from '../shared/urls';
import type { ViewerParams } from '../shared/viewer-url';
import { libraryStore } from './use-store';

export function useOriginalLink(p: Pick<ViewerParams, 'doc'>): string | null {
  const id = p.doc ?? null;
  const [link, setLink] = useState<string | null>(null);
  useEffect(() => {
    if (id === null) return;
    let live = true;
    void libraryStore()
      .then((store) => store?.listLocations(id as DocumentId))
      .then((places) => {
        const last = places?.reduce<(typeof places)[number] | null>((best, l) => (best === null || l.lastSeen > best.lastSeen ? l : best), null)?.raw ?? null;
        if (live && last !== null && isOpenableUrl(last)) setLink(last);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [id]);
  return link;
}

// The page an annotation row belongs to and where it sits on it (0 to 1): its `pageIndex` and `sortKey`, for ordering. The
// annotation session writes rows with it, and "Save this page to library" (R103) uses it when it moves notes to a newer version.
import type { Anchor } from '@sop/core';

/** The page a row belongs to and where it sits on it (0 to 1), for ordering. */
export function placeOf(a: Anchor): { pageIndex: number | null; sortKey: number | null } {
  switch (a.kind) {
    case 'text': {
      const onStart = a.rects.find((r) => r.page === a.start.page) ?? a.rects[0];
      return { pageIndex: a.start.page, sortKey: onStart?.rects[0]?.[1] ?? 0 };
    }
    case 'area':
    case 'figure':
      return { pageIndex: a.page, sortKey: a.rect[1] };
    case 'point':
      return { pageIndex: a.page, sortKey: a.point[1] };
    case 'page':
      return { pageIndex: a.page, sortKey: 0 };
    case 'document':
      return { pageIndex: null, sortKey: null };
  }
}

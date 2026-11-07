// The order pages are read in (Phase 7–8 plan, 7.3): the pages on screen first, then the next few in the way the reader is
// scrolling, then the rest outward from where the reader is, the scroll direction first at each distance. One page is read at a
// time; the service asks for the next page each time one is done (or stopped). Pure.

/** Pages ahead of the visible ones, in the scroll direction, read before the rest. */
export const NEAR_AHEAD = 3;

export interface ScheduleInput {
  pageCount: number;
  /** Still to read: not recognised, not known to have text of its own, not given up on. */
  todo(pageIndex: number): boolean;
  /** The pages on screen now (from the tab's hint), most important first; [] before any hint. */
  visible: readonly number[];
  direction: 1 | -1;
}

/** The next page to read, or null when nothing is left. */
export function nextPage(s: ScheduleInput): number | null {
  const ok = (i: number) => i >= 0 && i < s.pageCount && s.todo(i);
  for (const i of s.visible) if (ok(i)) return i;
  const shown = s.visible.filter((i) => i >= 0 && i < s.pageCount);
  const d = s.direction;
  const lead = shown.length === 0 ? 0 : d === 1 ? Math.max(...shown) : Math.min(...shown);
  for (let k = 1; k <= NEAR_AHEAD; k++) if (ok(lead + d * k)) return lead + d * k;
  const centre = shown.length === 0 ? 0 : shown[0];
  if (ok(centre)) return centre;
  for (let k = 1; k < s.pageCount; k++) {
    if (ok(centre + d * k)) return centre + d * k;
    if (ok(centre - d * k)) return centre - d * k;
  }
  return null;
}

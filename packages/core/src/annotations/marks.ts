// Style planning: what to write when the owner applies a style (highlight, underline, bold or strikethrough) to a
// passage. Pure; the caller turns the plan into rows (new ids, anchors with quotes and rects) and writes them in one
// transaction. A plan only ever names marks. Threads are separate rows and are never touched, so adding or removing a
// style cannot lose a comment (contracts §2).
//
// The rules (spec "Marks"):
//  - One passage can carry several styles at once. Each style is planned on its own and ignores the others.
//  - Applying a style that already covers the whole passage, in the same colour, takes it off that passage. A mark that
//    extends past the passage is cut: it shrinks to what is left, or splits in two when text is left on both sides.
//  - Anything else puts the style on the whole passage. Marks of the same style in another colour lose the passage
//    (that is how a highlight changes colour); gaps in the same colour are filled with new marks.
//  - Marks of one style and colour do not overlap, so a mark is never darker where two meet.
import type { MarkId } from '../ids';
import type { CharPos } from '../model/anchor';
import type { MarkColor, MarkRow, MarkStyle } from '../model/rows';

export interface StylePlan {
  create: { style: MarkStyle; color: MarkColor | null; start: CharPos; end: CharPos }[];
  shrink: { id: MarkId; start: CharPos; end: CharPos }[];
  remove: MarkId[];
}

/** Position order: page first, then char index. */
function cmp(a: CharPos, b: CharPos): number {
  return a.page - b.page || a.index - b.index;
}

interface Span {
  row: MarkRow;
  start: CharPos;
  end: CharPos;
}

export function planStyle(
  existing: readonly MarkRow[],
  target: { start: CharPos; end: CharPos },
  style: Exclude<MarkStyle, 'area'>,
  color: MarkColor | null,
): StylePlan {
  const plan: StylePlan = { create: [], shrink: [], remove: [] };
  let { start: from, end: to } = target;
  if (cmp(from, to) > 0) [from, to] = [to, from];
  if (cmp(from, to) === 0) return plan;
  const wanted = color ?? null;

  const spans: Span[] = [];
  for (const row of existing) {
    if (row.deletedAt != null || row.style !== style || row.anchor.kind !== 'text') continue;
    const { start, end } = row.anchor;
    if (cmp(start, end) < 0) spans.push({ row, start, end });
  }
  const overlapping = spans.filter((s) => cmp(s.start, to) < 0 && cmp(s.end, from) > 0);
  const sameColour = spans.filter((s) => (s.row.color ?? null) === wanted).sort((x, y) => cmp(x.start, y.start));

  // The parts of the passage that this colour of the style does not cover yet.
  const gaps: { start: CharPos; end: CharPos }[] = [];
  let cursor = from;
  for (const s of sameColour) {
    if (cmp(s.end, cursor) <= 0) continue;
    if (cmp(s.start, to) >= 0) break;
    if (cmp(s.start, cursor) > 0) gaps.push({ start: cursor, end: s.start });
    if (cmp(s.end, cursor) > 0) cursor = s.end;
    if (cmp(cursor, to) >= 0) break;
  }
  if (cmp(cursor, to) < 0) gaps.push({ start: cursor, end: to });

  if (gaps.length === 0) {
    // Already there: take the style off the passage, whatever colour the marks over it are.
    for (const s of overlapping) cut(plan, s, from, to);
    plan.create.sort((x, y) => cmp(x.start, y.start));
    return plan;
  }

  for (const s of overlapping) if ((s.row.color ?? null) !== wanted) cut(plan, s, from, to);
  for (const g of gaps) plan.create.push({ style, color: wanted, start: { ...g.start }, end: { ...g.end } });
  plan.create.sort((x, y) => cmp(x.start, y.start));
  return plan;
}

/** Takes [from, to) out of a mark. */
function cut(plan: StylePlan, s: Span, from: CharPos, to: CharPos): void {
  const left = cmp(s.start, from) < 0;
  const right = cmp(s.end, to) > 0;
  const { row } = s;
  if (left && right) {
    plan.shrink.push({ id: row.id, start: { ...s.start }, end: { ...from } });
    plan.create.push({ style: row.style, color: row.color ?? null, start: { ...to }, end: { ...s.end } });
  } else if (left) {
    plan.shrink.push({ id: row.id, start: { ...s.start }, end: { ...from } });
  } else if (right) {
    plan.shrink.push({ id: row.id, start: { ...to }, end: { ...s.end } });
  } else {
    plan.remove.push(row.id);
  }
}

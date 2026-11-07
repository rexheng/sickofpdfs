// Readings grouped by course (spec "Courses"; plan 8.5b), and the rows that the owner's changes write. Pure: no store, no
// `chrome.*`, so it runs the same in any page.
//
// How a reading finds its course, most specific first:
//   1. Where the owner put it (`course.of.<sha>`): that course, or no course at all. It wins over everything below, so the
//      categoriser finding a code later never undoes it. A course merged into another leads on to that one.
//   2. Its course codes (its course tags). A code a course of the owner's holds (renamed, merged or made) is that course;
//      any other code is a course found by itself, named by the code.
// A reading with two codes of two courses is in both. Courses come in the order of their most recently opened reading.
import type { DocumentId } from '@sop/core';
import type { CourseInputs, CourseRowWrite, StoredCourse } from '../../store/courses-api';

export interface Course {
  /** `id:<course id>` for a course with a row of its own; `code:<CODE>` for one found by itself. */
  key: string;
  /** The `course.<id>` row's id, or null while the course is only found by itself. */
  id: string | null;
  name: string;
  /** Its course codes, as written ("CS231n", "14.01"). A course the owner made by hand may have none. */
  codes: string[];
  /** Its readings, the most recently opened first. */
  readings: DocumentId[];
}

export interface CourseGroups {
  courses: Course[];
  /** Readings in no course, the most recently opened first. */
  loose: DocumentId[];
  /** The keys of each reading's courses. */
  of: ReadonlyMap<DocumentId, readonly string[]>;
}

const upper = (code: string): string => code.toUpperCase();

/** The live course an id names, following merges; null when there is none (a row that is gone, or a loop). */
export function resolveCourse(id: string, courses: Readonly<Record<string, StoredCourse>>): string | null {
  let at = id;
  for (let hop = 0; hop < 16; hop++) {
    const c = courses[at];
    if (c === undefined) return null;
    if (c.mergedInto === undefined) return at;
    at = c.mergedInto;
  }
  return null;
}

export function groupByCourse(inputs: CourseInputs): CourseGroups {
  const { readings, courses, placements } = inputs;
  const ids = Object.keys(courses).sort();
  // Which course holds each code: the owner's live courses first, then a merged course's codes go where it went.
  const holder = new Map<string, string>();
  for (const id of ids) {
    const c = courses[id];
    if (c === undefined || c.mergedInto !== undefined) continue;
    for (const code of c.codes) if (!holder.has(upper(code))) holder.set(upper(code), id);
  }
  for (const id of ids) {
    const c = courses[id];
    const to = c?.mergedInto === undefined ? null : resolveCourse(id, courses);
    if (c === undefined || to === null) continue;
    for (const code of c.codes) if (!holder.has(upper(code))) holder.set(upper(code), to);
  }

  const byKey = new Map<string, Course>();
  const of = new Map<DocumentId, string[]>();
  const loose: DocumentId[] = [];
  const course = (key: string, make: () => Course): Course => {
    let c = byKey.get(key);
    if (c === undefined) {
      c = make();
      byKey.set(key, c);
    }
    return c;
  };
  const stored = (id: string): Course => {
    const row = courses[id];
    return course(`id:${id}`, () => ({ key: `id:${id}`, id, name: row?.name ?? id, codes: [...(row?.codes ?? [])], readings: [] }));
  };

  for (const r of readings) {
    const placed = Object.hasOwn(placements, r.id) ? placements[r.id] : undefined;
    const pinned = placed === undefined || placed === null ? null : resolveCourse(placed, courses);
    const mine: Course[] = [];
    if (pinned !== null) mine.push(stored(pinned));
    else if (placed !== null) {
      // No placement, or one whose course is gone: the reading's codes decide.
      for (const code of r.codes) {
        const id = holder.get(upper(code));
        const c = id !== undefined ? stored(id) : course(`code:${upper(code)}`, () => ({ key: `code:${upper(code)}`, id: null, name: code, codes: [code], readings: [] }));
        if (!mine.includes(c)) mine.push(c);
      }
    }
    if (mine.length === 0) loose.push(r.id);
    for (const c of mine) c.readings.push(r.id);
    of.set(r.id, mine.map((c) => c.key));
  }
  return { courses: [...byKey.values()].filter((c) => c.readings.length > 0), loose, of };
}

// ---- the owner's changes, as rows ----------------------------------------------------------------------------------------

/** The longest course name: the store cuts a longer one to this (store/courses-api.ts). */
export const MAX_COURSE_NAME = 80;

/** A new course id: "c" and 12 lower-case letters and digits. */
export function newCourseId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `c${[...bytes].map((b) => (b % 36).toString(36)).join('')}`;
}

/** The codes of both, each once (ignoring case), in their order. */
function joinCodes(a: readonly string[], b: readonly string[]): string[] {
  const out: string[] = [];
  for (const code of [...a, ...b]) if (!out.some((c) => upper(c) === upper(code))) out.push(code);
  return out;
}

/** The course's row id, and the row that makes one when the course is only found by itself. */
function ensureRow(c: Course, courses: Readonly<Record<string, StoredCourse>>): { id: string; rows: CourseRowWrite[] } {
  if (c.id !== null && courses[c.id] !== undefined) return { id: c.id, rows: [] };
  const id = newCourseId();
  return { id, rows: [{ kind: 'course', id, course: { name: c.name, codes: [...c.codes] } }] };
}

/** Rename: the name sticks; finding the course's codes again never changes it. */
export function renameRows(c: Course, name: string, courses: Readonly<Record<string, StoredCourse>>): CourseRowWrite[] {
  const row = c.id === null ? undefined : courses[c.id];
  if (c.id !== null && row !== undefined) return [{ kind: 'course', id: c.id, course: { ...row, name } }];
  return [{ kind: 'course', id: newCourseId(), course: { name, codes: [...c.codes] } }];
}

/**
 * Merge `other` into `keep`, under `name`: one course with the codes of both, so readings with any of them are in it. The
 * course that goes is kept as a row marked `mergedInto`, so a reading the owner put there follows to the merged course.
 */
export function mergeRows(keep: Course, other: Course, name: string, courses: Readonly<Record<string, StoredCourse>>): CourseRowWrite[] {
  const keepRow = keep.id === null ? undefined : courses[keep.id];
  const otherRow = other.id === null ? undefined : courses[other.id];
  const target = keepRow !== undefined ? keep.id : otherRow !== undefined ? other.id : null;
  const id = target ?? newCourseId();
  const codes = joinCodes(keepRow?.codes ?? keep.codes, otherRow?.codes ?? other.codes);
  const rows: CourseRowWrite[] = [{ kind: 'course', id, course: { name, codes } }];
  for (const [c, row] of [
    [keep, keepRow],
    [other, otherRow],
  ] as const) {
    if (c.id !== null && row !== undefined && c.id !== id) rows.push({ kind: 'course', id: c.id, course: { ...row, mergedInto: id } });
  }
  return rows;
}

/** Puts a reading in a course (only that one). */
export function moveRows(documentId: DocumentId, to: Course, courses: Readonly<Record<string, StoredCourse>>): CourseRowWrite[] {
  const { id, rows } = ensureRow(to, courses);
  return [...rows, { kind: 'placement', documentId, courseId: id }];
}

/** Makes a new course by hand, with this reading in it. */
export function newCourseRows(documentId: DocumentId, name: string): CourseRowWrite[] {
  const id = newCourseId();
  return [
    { kind: 'course', id, course: { name, codes: [] } },
    { kind: 'placement', documentId, courseId: id },
  ];
}

/** Takes a reading out of one course. It stays in its other course, if it has one; otherwise it is in no course. */
export function takeOutRows(documentId: DocumentId, from: Course, groups: CourseGroups, courses: Readonly<Record<string, StoredCourse>>): CourseRowWrite[] {
  const rest = (groups.of.get(documentId) ?? []).filter((k) => k !== from.key);
  const stay = groups.courses.find((c) => c.key === rest[0]);
  if (stay === undefined) return [{ kind: 'placement', documentId, courseId: null }];
  return moveRows(documentId, stay, courses);
}

/** The rows that put back what `rows` change, as `inputs` had it: the snackbar's Undo. */
export function undoRows(rows: readonly CourseRowWrite[], inputs: CourseInputs): CourseRowWrite[] {
  const out: CourseRowWrite[] = [];
  for (const row of rows) {
    if (row.kind === 'course') out.push({ kind: 'course', id: row.id, course: inputs.courses[row.id] ?? null });
    else if (Object.hasOwn(inputs.placements, row.documentId)) out.push({ kind: 'placement', documentId: row.documentId, courseId: inputs.placements[row.documentId] ?? null });
    else out.push({ kind: 'unplace', documentId: row.documentId });
  }
  return out;
}

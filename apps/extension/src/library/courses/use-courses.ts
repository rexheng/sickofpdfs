// The Courses page's data, kept up to date (plan 8.5b): the readings grouped by course, each course with its readings (the
// library's rows, so a click opens them as anywhere else) and its newest notes, and the readings in no course. Any change to a
// reading, a note, a course tag or a course row, in this tab or another, asks again.
import type { DocumentId } from '@sop/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { NoteItem } from '../data/pages-data';
import type { LibraryData, LibraryItem } from '../data/types';
import type { CourseInputs, CourseRowWrite } from './courses-data';
import { type Course, type CourseGroups, groupByCourse } from './group';

/** One course as its card shows it. */
export interface CourseCardData {
  course: Course;
  readings: LibraryItem[];
  /** Its newest notes, newest first, at most NOTES_PER_COURSE. */
  notes: NoteItem[];
}

export interface CoursesView {
  cards: CourseCardData[];
  /** Readings in no course (and not private), the most recently opened first. */
  loose: LibraryItem[];
  inputs: CourseInputs;
  groups: CourseGroups;
}

export type CoursesState = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; view: CoursesView } | { kind: 'none' };

export interface Courses {
  state: CoursesState;
  /** Writes the owner's change. Rejects when the store refuses it; the page then says so. */
  save(this: void, rows: CourseRowWrite[]): Promise<void>;
  retry(this: void): void;
}

/** How many notes a course card shows. */
export const NOTES_PER_COURSE = 2;
/** The newest notes looked through for the cards. A course whose notes are all older shows none (its count still shows). */
const NOTES_LOOKED_AT = 200;
const PAGE = 200;
/** A library bigger than this shows the courses of its most recently opened readings only. */
const MOST_READINGS = 5000;

/** Every reading in the library (not in Trash), the most recently opened first. */
async function allReadings(data: LibraryData): Promise<LibraryItem[]> {
  const out: LibraryItem[] = [];
  let cursor: string | undefined;
  do {
    const page = await data.listDocuments({ view: 'all', sort: { by: 'lastOpened', dir: 'desc' }, limit: PAGE, ...(cursor === undefined ? {} : { cursor }) });
    out.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined && out.length < MOST_READINGS);
  return out;
}

function build(inputs: CourseInputs, items: readonly LibraryItem[], notes: readonly NoteItem[]): CoursesView {
  const byId = new Map<DocumentId, LibraryItem>(items.map((i) => [i.doc.id, i]));
  // Only readings the store offers may be in a course (R102, D9): a private one is never listed, whatever the rows say.
  const groups = groupByCourse({ ...inputs, readings: inputs.readings.filter((r) => byId.has(r.id)) });
  const pick = (ids: readonly DocumentId[]): LibraryItem[] => ids.flatMap((id) => byId.get(id) ?? []);
  const cards = groups.courses.map((course) => {
    const mine = new Set<string>(course.readings);
    return { course, readings: pick(course.readings), notes: notes.filter((n) => mine.has(n.thread.documentId)).slice(0, NOTES_PER_COURSE) };
  });
  return { cards, loose: pick(groups.loose), inputs, groups };
}

export function useCourses(data: LibraryData): Courses {
  const courses = data.courses;
  const [state, setState] = useState<CoursesState>(courses === undefined ? { kind: 'none' } : { kind: 'loading' });
  const generation = useRef(0);

  const load = useCallback(() => {
    if (courses === undefined) return;
    const mine = ++generation.current;
    Promise.all([courses.listCourseInputs(), allReadings(data), data.listNotes({ limit: NOTES_LOOKED_AT }).then((p) => p.items, () => [] as NoteItem[])]).then(
      ([inputs, items, notes]) => mine === generation.current && setState({ kind: 'ready', view: build(inputs, items, notes) }),
      () => mine === generation.current && setState({ kind: 'error' }),
    );
  }, [courses, data]);

  useEffect(() => {
    load();
    if (courses === undefined) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const soon = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(load, 80);
    };
    const stopReadings = data.onChange(soon);
    const stopCourses = courses.onCoursesChange(soon);
    return () => {
      stopReadings();
      stopCourses();
      if (timer !== null) clearTimeout(timer);
    };
  }, [courses, data, load]);

  const save = useCallback(
    async (rows: CourseRowWrite[]) => {
      if (courses === undefined || rows.length === 0) return;
      await courses.saveCourseRows(rows);
      load();
    },
    [courses, load],
  );

  const retry = useCallback(() => {
    setState({ kind: 'loading' });
    load();
  }, [load]);

  return { state, save, retry };
}

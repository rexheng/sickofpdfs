// What the Courses page reads and changes (plan 8.5b): the readings that may be in a course with their course codes, the
// owner's course rows, and the writes of those rows. The store does the work (store/courses-api.ts); this is the library's
// view of it, so the page never talks to the store directly.
import type { StoreChange } from '../../store/change-bus';
import type { StoreClient } from '../../store/client';
import type { CourseInputs, CourseRowWrite } from '../../store/courses-api';

export type { CourseInputs, CourseRowWrite, StoredCourse } from '../../store/courses-api';

export interface CoursesData {
  listCourseInputs(this: void): Promise<CourseInputs>;
  saveCourseRows(this: void, rows: CourseRowWrite[]): Promise<void>;
  /** Calls `cb` after anything that can change the courses: a course row, a course tag, a reading, from any tab. */
  onCoursesChange(this: void, cb: () => void): () => void;
}

/** The tables whose changes can move a reading between courses. A settings change counts when it is a course row. */
const COURSE_TABLES: ReadonlySet<StoreChange['table']> = new Set(['tags', 'reading_tags', 'auto_tag_removed', 'documents']);

export function createStoreCoursesData(client: StoreClient): CoursesData {
  return {
    listCourseInputs: () => client.listCourseInputs(),
    saveCourseRows: (rows) => client.saveCourseRows(rows),
    onCoursesChange: (cb) =>
      client.onChange((c) => {
        if (COURSE_TABLES.has(c.table) || (c.table === 'settings' && c.ids.some((k) => k.startsWith('course.')))) cb();
      }),
  };
}

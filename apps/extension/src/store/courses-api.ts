// The Courses page's side of the store (plan Phases 7–8, slice 8.5b; spec "Courses": "groups by course code found in the
// link, folder or first page; rename or merge freely").
//
// Courses are found from the readings' course tags (R92: "Course: CS50", made by the categoriser from the link, the folder,
// the file name, page 1 and the page the PDF was opened from, or added by the owner). The owner's changes are kept as rows of
// the `settings` table, so the backup and (Release 2) sync carry them like any other setting. There is no table of their own:
//   - `course.<id>`     = { name, codes, mergedInto? }: a course the owner renamed, merged or made. `codes` are the course
//                         codes it holds; a reading with one of them is in it. `mergedInto` marks one merged into another.
//   - `course.of.<sha>` = a course id, or null: where the owner put one reading. null is "in no course". It wins over the
//                         reading's codes, so the categoriser never undoes it.
//
// Wiring: `StoreApi extends CoursesApi`, and the object `createStoreApi` returns spreads `createCoursesApi(db, deps)`.
// `protocol.ts` serves `COURSES_API_METHODS`, and `client.ts` proxies them.
//
// Rules this file keeps:
// - Private readings are never in a course (R102, D9): a reading whose text is kept out of the library, or that the owner saved
//   although the filter judged it "not learning", is not listed, and the owner cannot place one either. Readings in Trash are
//   not listed.
// - A reading that is forgotten leaves nothing here: `forgetCoursePlacements` deletes its `course.of.<sha>` row (and the
//   outbox entries for it) in the transaction that forgets it, so its fingerprint does not stay behind in the settings.
// - Every write is one transaction, stamps `hlc`, and publishes its change only after it commits.
// - Errors are rejections whose message starts with a code (`bad-input: …`), so the code survives a message port.
import type { DocumentId, HlcStamp } from '@sop/core';
import type { StoreChange } from './change-bus';
import { UNDERSTOOD } from './reading-flags';
import { isReadOnly, type SqlDb, type SqlValue } from './schema-v2';
import { COURSE_PREFIX } from './tags-api';

/** A course the owner renamed, merged or made (`course.<id>`). */
export interface StoredCourse {
  name: string;
  /** The course codes it holds, as written ("CS231n", "14.01"). */
  codes: string[];
  /** Set when it was merged into that course; it then holds nothing of its own. */
  mergedInto?: string;
}

/** One reading that may be in a course. */
export interface CourseReadingInput {
  id: DocumentId;
  /** Its course codes, as written: the names of its live course tags (auto or the owner's) without "Course: ". */
  codes: string[];
}

export interface CourseInputs {
  /** The readings that may be in a course: in the library, not in Trash, not private. The most recently opened first. */
  readings: CourseReadingInput[];
  /** The `course.<id>` rows, by id. */
  courses: Record<string, StoredCourse>;
  /** The `course.of.<sha>` rows of the readings above, by reading id: a course id, or null for "in no course". */
  placements: Record<string, string | null>;
}

/**
 * One row the Courses page writes. `course: null` removes a course row and `unplace` a placement row (an Undo: back to how it
 * was before). A placement with `courseId: null` is kept: it says "in no course".
 */
export type CourseRowWrite =
  | { kind: 'course'; id: string; course: StoredCourse | null }
  | { kind: 'placement'; documentId: DocumentId; courseId: string | null }
  | { kind: 'unplace'; documentId: DocumentId };

export interface CoursesApi {
  /** What the Courses page groups: the readings with their codes, and the owner's course rows. */
  listCourseInputs(): Promise<CourseInputs>;
  /** Writes these course rows in one transaction. A placement of a reading that is not in the library, or is private, is refused. */
  saveCourseRows(rows: CourseRowWrite[]): Promise<void>;
}

export const COURSES_API_METHODS = ['listCourseInputs', 'saveCourseRows'] as const satisfies readonly (keyof CoursesApi)[];
/** The methods that only read: their answers are not kept for replays. */
export const COURSES_READ_METHODS = ['listCourseInputs'] as const satisfies readonly (keyof CoursesApi)[];

/** The key of a course row. */
export const courseKey = (id: string): string => `course.${id}`;
/** The key of a reading's placement row. */
export const placementKey = (documentId: string): string => `course.of.${documentId}`;

/** A course id: "c" and lower-case letters and digits (never "of", so it cannot meet the placement rows). */
export const COURSE_ID = /^c[a-z0-9]{4,31}$/;
const COURSE_ROW = /^course\.(c[a-z0-9]{4,31})$/;
const PLACEMENT_ROW = /^course\.of\.([0-9a-f]{64})$/;
const HEX64 = /^[0-9a-f]{64}$/;
/** A text cell as a string ('' for anything else). */
const text = (v: SqlValue | undefined): string => (typeof v === 'string' ? v : '');
/** The longest course name and code. */
export const MAX_COURSE_NAME = 80;
const MAX_CODE = 40;
const MAX_CODES = 40;
const MAX_ROWS = 500;

export interface CoursesDeps {
  hlc: { tick(): HlcStamp };
  publish(c: StoreChange): void;
}

class CoursesError extends Error {
  constructor(code: 'bad-input' | 'read-only', message: string) {
    super(`${code}: ${message}`);
    this.name = 'StoreError';
  }
}

function fail(code: 'bad-input' | 'read-only', message: string): never {
  throw new CoursesError(code, message);
}

function attempt<T>(f: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    try {
      resolve(f());
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g;

/** Text as it is kept: no control or direction characters, one space between words, cut to `max` letters. Null when empty. */
function tidy(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null;
  const t = [...raw.normalize('NFC').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()].slice(0, max).join('').trim();
  return t === '' ? null : t;
}

/** The codes, tidied, each once (ignoring case), in their order. */
function tidyCodes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of raw) {
    const code = tidy(c, MAX_CODE);
    if (code === null || seen.has(code.toUpperCase())) continue;
    seen.add(code.toUpperCase());
    out.push(code);
    if (out.length >= MAX_CODES) break;
  }
  return out;
}

/** A stored course from its JSON, or null when it is not one. */
function readCourse(value: unknown, id: string): StoredCourse | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const name = tidy(v.name, MAX_COURSE_NAME);
  if (name === null) return null;
  const course: StoredCourse = { name, codes: tidyCodes(v.codes) };
  if (typeof v.mergedInto === 'string' && COURSE_ID.test(v.mergedInto) && v.mergedInto !== id) course.mergedInto = v.mergedInto;
  return course;
}

function parse(text: SqlValue | undefined): unknown {
  if (typeof text !== 'string') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Deletes the placement rows of these readings, and every outbox entry for them. Call it in the transaction that forgets
 * readings (Forget, Undo of a save, the Trash purge), so a forgotten PDF's fingerprint does not stay in the settings.
 */
export function forgetCoursePlacements(tx: SqlDb, documentIds: readonly string[]): void {
  if (documentIds.length === 0) return;
  const keys = JSON.stringify(documentIds.map(placementKey));
  tx.exec({ sql: 'DELETE FROM settings WHERE key IN (SELECT value FROM json_each(?))', bind: [keys] });
  tx.exec({ sql: `DELETE FROM outbox WHERE table_name = 'settings' AND row_id IN (SELECT value FROM json_each(?))`, bind: [keys] });
}

export function createCoursesApi(db: SqlDb, deps: CoursesDeps): CoursesApi {
  const select = (sql: string, bind?: SqlValue[]): Record<string, SqlValue>[] => db.selectObjects(sql, bind);
  /** The readings that may be in a course, the most recently opened first. */
  const eligible = (): string[] =>
    select(
      `SELECT d.id AS id FROM documents d LEFT JOIN history h ON h.document_id = d.id
       WHERE d.deleted_at IS NULL AND ${UNDERSTOOD} ORDER BY coalesce(h.last_opened, d.created_at) DESC, d.id`,
    ).map((r) => text(r.id));

  return {
    listCourseInputs: () =>
      attempt(() => {
        const ids = eligible();
        const codes = new Map<string, string[]>(ids.map((id) => [id, []]));
        for (const r of select(
          `SELECT rt.document_id AS id, t.name AS name FROM reading_tags rt
             JOIN tags t ON t.id = rt.tag_id AND t.kind = 'course' AND t.deleted_at IS NULL
           ORDER BY rt.document_id, t.name`,
        )) {
          const list = codes.get(text(r.id));
          if (list === undefined) continue;
          const name = text(r.name);
          const code = tidy(name.startsWith(COURSE_PREFIX) ? name.slice(COURSE_PREFIX.length) : name, MAX_CODE);
          if (code !== null && !list.some((c) => c.toUpperCase() === code.toUpperCase())) list.push(code);
        }
        const courses: Record<string, StoredCourse> = {};
        const placements: Record<string, string | null> = {};
        for (const r of select(`SELECT key, value FROM settings WHERE key LIKE 'course.%'`)) {
          const key = text(r.key);
          const value = parse(r.value);
          const place = PLACEMENT_ROW.exec(key);
          if (place !== null) {
            const id = place[1] ?? '';
            if (!codes.has(id)) continue; // a private, trashed or unknown reading: nothing about it is given out
            if (value === null) placements[id] = null;
            else if (typeof value === 'string' && COURSE_ID.test(value)) placements[id] = value;
            continue;
          }
          const row = COURSE_ROW.exec(key);
          if (row === null) continue;
          const id = row[1] ?? '';
          const course = readCourse(value, id);
          if (course !== null) courses[id] = course;
        }
        return { readings: ids.map((id) => ({ id: id as DocumentId, codes: codes.get(id) ?? [] })), courses, placements };
      }),

    saveCourseRows: (rows) =>
      attempt(() => {
        if (!Array.isArray(rows) || rows.length === 0 || rows.length > MAX_ROWS) fail('bad-input', `course changes come as a list of 1 to ${MAX_ROWS} rows`);
        /** `text: null`: the row goes. */
        const writes: { key: string; text: string | null }[] = [];
        const placed: string[] = [];
        for (const row of rows) {
          if (typeof row !== 'object' || row === null) fail('bad-input', 'a course change is an object');
          if (row.kind === 'course') {
            if (typeof row.id !== 'string' || !COURSE_ID.test(row.id)) fail('bad-input', 'the course id is not valid');
            if (row.course === null) {
              writes.push({ key: courseKey(row.id), text: null });
              continue;
            }
            const name = tidy(row.course?.name, MAX_COURSE_NAME);
            if (name === null) fail('bad-input', 'A course needs a name.');
            const course: StoredCourse = { name, codes: tidyCodes(row.course.codes) };
            const into = row.course.mergedInto;
            if (into !== undefined) {
              if (typeof into !== 'string' || !COURSE_ID.test(into) || into === row.id) fail('bad-input', 'a course is merged into another course');
              course.mergedInto = into;
            }
            writes.push({ key: courseKey(row.id), text: JSON.stringify(course) });
          } else if (row.kind === 'placement') {
            if (typeof row.documentId !== 'string' || !HEX64.test(row.documentId)) fail('bad-input', 'the reading id is not a SHA-256');
            if (row.courseId !== null && (typeof row.courseId !== 'string' || !COURSE_ID.test(row.courseId))) fail('bad-input', 'the course id is not valid');
            writes.push({ key: placementKey(row.documentId), text: JSON.stringify(row.courseId) });
            placed.push(row.documentId);
          } else if (row.kind === 'unplace') {
            if (typeof row.documentId !== 'string' || !HEX64.test(row.documentId)) fail('bad-input', 'the reading id is not a SHA-256');
            writes.push({ key: placementKey(row.documentId), text: null });
          } else {
            fail('bad-input', 'a course change is a course or a placement');
          }
        }
        if (isReadOnly(db)) fail('read-only', 'Update sickofpdfs. This library was saved by a newer version, so it cannot be changed.');
        const changed: string[] = [];
        db.savepoint(() => {
          if (placed.length > 0) {
            // R102, D9: a private reading is never put in a course; nor is one in Trash or one the library does not hold.
            const ok = new Set(
              select(`SELECT d.id AS id FROM documents d WHERE d.id IN (SELECT value FROM json_each(?)) AND d.deleted_at IS NULL AND ${UNDERSTOOD}`, [JSON.stringify(placed)]).map((r) =>
                text(r.id),
              ),
            );
            if (placed.some((id) => !ok.has(id))) fail('bad-input', 'This reading can’t be in a course.');
          }
          for (const w of writes) {
            const now = db.selectValue('SELECT value FROM settings WHERE key = ?', [w.key]);
            if (w.text === null) {
              if (now === undefined) continue;
              db.exec({ sql: 'DELETE FROM settings WHERE key = ?', bind: [w.key] });
              changed.push(w.key);
              continue;
            }
            if (now === w.text) continue;
            db.exec({
              sql: `INSERT INTO settings (key, value, hlc) VALUES (?, ?, ?)
                    ON CONFLICT (key) DO UPDATE SET value = excluded.value, hlc = excluded.hlc`,
              bind: [w.key, w.text, deps.hlc.tick()],
            });
            changed.push(w.key);
          }
        });
        if (changed.length > 0) {
          try {
            deps.publish({ table: 'settings', ids: changed, op: 'upsert' }); // the page reads the courses again either way
          } catch {
            // Other tabs read the courses again the next time they show them.
          }
        }
      }),
  };
}

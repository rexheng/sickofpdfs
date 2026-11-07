// The Courses page's two other dialogs (plan 8.5b): Rename a course, and Move a reading to a course (or make a new course
// for it). Both are plain: one field or one list, and the way forward.
import { Dialog, FileTypeIcon, Icon, TextField } from '@sop/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { readingTitle } from '../components/format';
import type { LibraryItem } from '../data/types';
import { cx, fold } from '../tags/tag-format';
import styles from './CourseDialogs.module.css';
import { MAX_COURSE_NAME } from './group';
import { CoursePicker } from './MergeDialog';
import type { CourseCardData } from './use-courses';

export interface RenameCourseDialogProps {
  /** The course to rename; null: closed. */
  course: CourseCardData | null;
  onRename(this: void, name: string): void;
  onClose(this: void): void;
}

export function RenameCourseDialog({ course, onRename, onClose }: RenameCourseDialogProps) {
  const [value, setValue] = useState('');
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (course === null) return;
    setValue(course.course.name);
    requestAnimationFrame(() => field.current?.select());
  }, [course]);
  const clean = value.trim().slice(0, MAX_COURSE_NAME);
  const save = () => {
    if (course === null || clean === '') return;
    if (clean === course.course.name) onClose();
    else onRename(clean);
  };
  const codes = course?.course.codes ?? [];
  return (
    <Dialog
      open={course !== null}
      title="Rename course"
      onOpenChange={(next) => !next && onClose()}
      actions={[
        { label: 'Cancel', onClick: onClose },
        { label: 'Rename', primary: true, onClick: save, disabled: clean === '' },
      ]}
    >
      <div className={styles.body}>
        <TextField ref={field} label="Course name" value={value} onChange={setValue} onEnter={save} invalid={clean === ''} maxLength={MAX_COURSE_NAME} />
        <p className={styles.note}>
          The new name stays.
          {codes.length > 0 && ` Readings with ${codes.length === 1 ? 'the code' : 'the codes'} ${codes.join(', ')} still join this course.`}
        </p>
      </div>
    </Dialog>
  );
}

/** Where a reading goes: a course on the page, or a new course with this name. */
export type MoveTarget = { kind: 'course'; card: CourseCardData } | { kind: 'new'; name: string };

export interface MoveDialogProps {
  /** The reading to move, and the course it is moved from (null: it is in no course); null: closed. */
  move: { item: LibraryItem; from: CourseCardData | null } | null;
  all: readonly CourseCardData[];
  onMove(this: void, to: MoveTarget): void;
  onClose(this: void): void;
}

const NEW = 'new';

export function MoveDialog({ move, all, onMove, onClose }: MoveDialogProps) {
  const [chosen, setChosen] = useState<string | null>(null);
  const [name, setName] = useState('');
  const field = useRef<HTMLInputElement>(null);
  const others = useMemo(
    () => all.filter((c) => c.course.key !== move?.from?.course.key).sort((a, b) => fold(a.course.name).localeCompare(fold(b.course.name), undefined, { numeric: true })),
    [all, move],
  );
  useEffect(() => {
    if (move === null) return;
    setChosen(null);
    setName('');
  }, [move]);
  useEffect(() => {
    if (chosen === NEW) requestAnimationFrame(() => field.current?.focus());
  }, [chosen]);
  const target = others.find((c) => c.course.key === chosen) ?? null;
  const clean = name.trim().slice(0, MAX_COURSE_NAME);
  const ready = chosen === NEW ? clean !== '' : target !== null;
  const go = () => {
    if (chosen === NEW && clean !== '') onMove({ kind: 'new', name: clean });
    else if (target !== null) onMove({ kind: 'course', card: target });
  };
  const verb = move?.from === null ? 'Add' : 'Move';
  return (
    <Dialog
      open={move !== null}
      title={move?.from === null ? 'Add to a course' : 'Move to another course'}
      onOpenChange={(next) => !next && onClose()}
      actions={[
        { label: 'Cancel', onClick: onClose },
        { label: verb, primary: true, onClick: go, disabled: !ready },
      ]}
    >
      {move !== null && (
        <div className={styles.body}>
          <p className={styles.reading} title={readingTitle(move.item)}>
            <FileTypeIcon kind="pdf" size={24} />
            <span className={styles.readingTitle}>{readingTitle(move.item)}</span>
          </p>
          <p className={styles.note}>It stays in the course you pick. sickofpdfs won’t move it again by itself.</p>
          <CoursePicker choices={others} chosen={chosen} onChoose={setChosen} label="Courses">
            <button type="button" role="radio" aria-checked={chosen === NEW} className={cx(styles.choice, chosen === NEW && styles.chosen)} onClick={() => setChosen(NEW)}>
              <Icon name={chosen === NEW ? 'radio_button_checked' : 'radio_button_unchecked'} size={20} />
              <span className={styles.choiceText}>
                <span className={styles.choiceName}>A new course</span>
              </span>
            </button>
          </CoursePicker>
          {chosen === NEW && <TextField ref={field} label="Name of the new course" placeholder="Name of the new course" value={name} onChange={setName} onEnter={go} maxLength={MAX_COURSE_NAME} />}
        </div>
      )}
    </Dialog>
  );
}

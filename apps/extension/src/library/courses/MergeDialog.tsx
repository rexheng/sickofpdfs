// Merge two courses (plan 8.5b: "rename and merge freely"), in one plain dialog: pick the other course, keep or change the
// name, Merge. The merged course holds the codes of both, so a reading with either code is in it from then on.
import { Dialog, Icon, TextField } from '@sop/ui';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { cx, fold } from '../tags/tag-format';
import { courseLine } from './CourseCard';
import styles from './CourseDialogs.module.css';
import { MAX_COURSE_NAME } from './group';
import type { CourseCardData } from './use-courses';

export interface CoursePickerProps {
  choices: readonly CourseCardData[];
  chosen: string | null;
  onChoose(this: void, key: string): void;
  label: string;
  /** More rows after the courses, in the same group ("A new course"). */
  children?: ReactNode;
}

/** The courses to choose from, as radio rows: the course's icon, its name, and its codes and count. */
export function CoursePicker({ choices, chosen, onChoose, label, children }: CoursePickerProps) {
  return (
    <div className={styles.choices} role="radiogroup" aria-label={label}>
      {choices.map(({ course, readings }) => (
        <button key={course.key} type="button" role="radio" aria-checked={chosen === course.key} className={cx(styles.choice, chosen === course.key && styles.chosen)} onClick={() => onChoose(course.key)}>
          <Icon name={chosen === course.key ? 'radio_button_checked' : 'radio_button_unchecked'} size={20} />
          <span className={styles.choiceText}>
            <span className={styles.choiceName}>{course.name}</span>
            <span className={styles.choiceMeta}>{courseLine(course.codes, readings.length)}</span>
          </span>
        </button>
      ))}
      {children}
    </div>
  );
}

export interface MergeDialogProps {
  /** The course whose menu was used; null: closed. */
  from: CourseCardData | null;
  /** Every course on the page. */
  all: readonly CourseCardData[];
  onMerge(this: void, other: CourseCardData, name: string): void;
  onClose(this: void): void;
}

export function MergeDialog({ from, all, onMerge, onClose }: MergeDialogProps) {
  const [chosen, setChosen] = useState<string | null>(null);
  const [name, setName] = useState('');
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (from === null) return;
    setChosen(null);
    setName(from.course.name);
  }, [from]);
  const others = useMemo(() => all.filter((c) => c.course.key !== from?.course.key).sort((a, b) => fold(a.course.name).localeCompare(fold(b.course.name), undefined, { numeric: true })), [all, from]);
  const other = others.find((c) => c.course.key === chosen) ?? null;
  const clean = name.trim().slice(0, MAX_COURSE_NAME);
  const merge = () => {
    if (other === null || clean === '') return;
    onMerge(other, clean);
  };
  return (
    <Dialog
      open={from !== null}
      title="Merge courses"
      onOpenChange={(next) => !next && onClose()}
      actions={[
        { label: 'Cancel', onClick: onClose },
        { label: 'Merge', primary: true, onClick: merge, disabled: other === null || clean === '' },
      ]}
    >
      {from !== null && (
        <div className={styles.body}>
          <p className={styles.note}>Put “{from.course.name}” and another course together. Their readings become one course.</p>
          <CoursePicker choices={others} chosen={chosen} onChoose={setChosen} label="Merge with" />
          <label className={styles.fieldLabel}>
            <span>Name of the merged course</span>
            <TextField ref={field} label="Name of the merged course" value={name} onChange={setName} onEnter={merge} invalid={clean === ''} maxLength={MAX_COURSE_NAME} />
          </label>
        </div>
      )}
    </Dialog>
  );
}

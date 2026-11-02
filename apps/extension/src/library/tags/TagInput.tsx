// "Add a tag": a field that suggests the tags you already have as you type, Gmail's "Label as" search. Enter adds the
// suggestion that is lit, or a new tag with the typed name when none is. Up and Down move; Esc empties the field.
import { Icon, TextField } from '@sop/ui';
import { type KeyboardEvent, useId, useMemo, useRef, useState } from 'react';
import { TAG_ICON, tagMatches, cx, fold } from './tag-format';
import styles from './TagInput.module.css';
import type { TagSummary } from './tags-data';

export interface TagInputProps {
  /** Every tag, for the suggestions; null while they load. */
  all: readonly TagSummary[] | null;
  /** Tags not to suggest (every reading has them already). */
  exclude: ReadonlySet<string>;
  /** A tag was picked or typed: its name. */
  onAdd(this: void, name: string): void;
  /** Esc in an empty field. */
  onCancel?(this: void): void;
  autoFocus?: boolean;
  label?: string;
}

/** The most suggestions shown. */
const SHOWN = 6;
/** The longest tag name the store keeps. */
const MAX_NAME = 60;

interface Option {
  key: string;
  name: string;
  /** A new tag with the typed name. */
  fresh: boolean;
  kind: TagSummary['kind'];
}

export function TagInput({ all, exclude, onAdd, onCancel, autoFocus = false, label = 'Add a tag' }: TagInputProps) {
  const [text, setText] = useState('');
  const [lit, setLit] = useState(0);
  const [open, setOpen] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const base = useId();
  const typed = text.trim().replace(/\s+/gu, ' ').replace(/^#+\s*/u, '');

  const options = useMemo<Option[]>(() => {
    if (typed === '') return [];
    const key = fold(typed);
    // A tag whose name starts with the typed words comes first ("deep" → Deep Learning); one that only has them later in
    // its name ("economics" in Mathematical Economics) comes after "Make a new tag", so Enter makes what was typed.
    const starts = (name: string) => fold(name).startsWith(key);
    const found = (all ?? [])
      .filter((t) => !exclude.has(t.id) && tagMatches(t.name, typed))
      .sort((a, b) => Number(starts(b.name)) - Number(starts(a.name)) || b.count - a.count)
      .slice(0, SHOWN)
      .map((t): Option => ({ key: t.id, name: t.name, fresh: false, kind: t.kind }));
    if ((all ?? []).some((t) => fold(t.name) === key)) return found;
    const fresh: Option = { key: `new:${typed}`, name: typed.slice(0, MAX_NAME), fresh: true, kind: 'tag' };
    const lead = found.filter((o) => starts(o.name));
    return [...lead, fresh, ...found.filter((o) => !starts(o.name))];
  }, [all, exclude, typed]);
  const shown = open && options.length > 0;
  const active = Math.min(lit, Math.max(0, options.length - 1));

  const pick = (o: Option | undefined) => {
    const name = o?.name ?? typed;
    if (name === '') return;
    onAdd(name);
    setText('');
    setLit(0);
    field.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (options.length === 0) return;
      e.preventDefault();
      setOpen(true);
      setLit((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(shown ? options[active] : undefined);
    } else if (e.key === 'Escape') {
      if (text !== '') {
        e.preventDefault();
        e.stopPropagation();
        setText('');
      } else if (onCancel !== undefined) {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }
    }
  };

  return (
    <div className={styles.box}>
      <TextField
        ref={field}
        label={label}
        placeholder={label}
        value={text}
        maxLength={MAX_NAME}
        autoFocus={autoFocus}
        autoComplete="off"
        spellCheck={false}
        role="combobox"
        aria-expanded={shown}
        aria-controls={`${base}-list`}
        aria-autocomplete="list"
        aria-activedescendant={shown ? `${base}-o${active}` : undefined}
        className={styles.field}
        onChange={(v) => {
          setText(v);
          setLit(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {shown && (
        <div id={`${base}-list`} role="listbox" aria-label="Tags" className={styles.list}>
          {options.map((o, i) => (
            <div
              key={o.key}
              id={`${base}-o${i}`}
              role="option"
              aria-selected={i === active}
              className={cx(styles.option, i === active && styles.lit)}
              onMouseMove={() => i !== active && setLit(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(o)}
            >
              <Icon name={o.fresh ? 'new_label' : TAG_ICON[o.kind]} size={20} />
              <span className={styles.optionText}>{o.fresh ? `Make a new tag “${o.name}”` : o.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

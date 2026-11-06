// The search palette (Ctrl+K), drawn as Drive draws its expanded search: a rounded panel with the search field at the top,
// filter chips under it, and the answers in groups. It is the same in the viewer (dark, like its menus) and in the library
// (light). Snippets are shown from parts (`splitMarked`), never as HTML.
//
// Keys: Up and Down move through the answers, Enter opens the one that is lit, Esc closes. Enter pressed while a search
// is still running opens the best answer as soon as it arrives.
import { DropdownMenu, FileTypeIcon, Icon, IconButton, type MenuItemDef } from '@sop/ui';
import { type ComponentPropsWithRef, type KeyboardEvent, type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { KIND_LABELS, KINDS, OPENED_LABELS, OPENED_RANGES } from '../../library/components/filters';
import styles from './Palette.module.css';
import type { PaletteCommandGroup, PaletteStore, PaletteTarget, TextPart } from './types';
import { operatorKeys, unknownOperator } from './query';
import { isNarrowed, NO_PALETTE_FILTERS, type PaletteFilters, type PaletteRow, usePalette } from './use-palette';

/**
 * Where the panel opens (TB5), measured as it opens and again when the window changes size. In the viewer it starts below
 * the toolbar, never across it. In the library it is the "Search in library" bar itself, grown into its answers, as Drive's
 * search does: the field lies exactly over the bar, with no dimming behind.
 */
export interface PaletteAnchor {
  /** Its top edge, in window px. */
  top: number;
  /** Its left edge and width; without them it is centred. */
  left?: number;
  width?: number;
  /** It grows out of a search bar: the bar's own shape, no scrim. */
  bar?: boolean;
}

export interface PaletteProps {
  /** The library store; null while it connects, or when there is none (then `unavailable` says why). */
  store: PaletteStore | null;
  /** Why there is no library to search (Incognito, or it could not be opened). Shown instead of results. */
  unavailable?: string | null;
  /** The commands, or the places to go, that the typed words can find. */
  commands: PaletteCommandGroup | null;
  initialQuery?: string;
  /** Opens a hit. Resolves with a plain sentence when it could not be opened (the palette stays open and says it), else null. */
  onOpen(this: void, target: PaletteTarget): Promise<string | null>;
  onClose(this: void): void;
  /** Where it opens; null (or no answer): centred, a tenth of the way down the window. */
  anchor?: (() => PaletteAnchor | null) | undefined;
}

/** The anchor now, and again whenever the window is resized. */
function useAnchor(measure: PaletteProps['anchor']): PaletteAnchor | null {
  const [at, setAt] = useState<PaletteAnchor | null>(() => measure?.() ?? null);
  useEffect(() => {
    if (measure === undefined) return;
    const again = () => setAt(measure());
    addEventListener('resize', again);
    return () => removeEventListener('resize', again);
  }, [measure]);
  return at;
}

const PLACEHOLDER = 'Search readings, pages and notes';

export function Palette({ store, unavailable = null, commands, initialQuery = '', onOpen, onClose, anchor }: PaletteProps) {
  const view = usePalette({ store, commands, initialQuery });
  const at = useAnchor(anchor);
  const base = useId();
  const input = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const enterWhenReady = useRef(false);

  // The field takes the focus; when the palette goes, the focus goes back to where it was.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const box = panel.current;
    // The caret after what it opened with: a letter typed into the library's search bar, and the next ones, run on.
    const field = input.current;
    field?.focus({ preventScroll: true });
    field?.setSelectionRange(field.value.length, field.value.length);
    return () => {
      const here = document.activeElement;
      if (opener?.isConnected === true && (here === null || here === document.body || box?.contains(here) === true)) opener.focus({ preventScroll: true });
    };
  }, []);

  const lit = view.rows[view.active];
  const litId = lit === undefined ? undefined : `${base}-o${view.active}`;
  useEffect(() => {
    if (litId !== undefined) document.getElementById(litId)?.scrollIntoView({ block: 'nearest' });
  }, [litId]);

  const { setQuery } = view;
  const choose = useCallback(
    async (row: PaletteRow) => {
      setNotice(null);
      if (row.complete !== undefined && row.complete !== null) {
        // A `tag:` suggestion: it goes in the field, and the list then shows that tag's readings.
        setQuery(row.complete);
        input.current?.focus({ preventScroll: true });
        return;
      }
      if (row.command !== null) {
        const run = row.command.run;
        onClose();
        // After the palette has gone and the focus is back, so a command that moves the focus (Find) keeps it.
        setTimeout(run, 0);
        return;
      }
      if (row.target !== null) {
        const problem = await onOpen(row.target);
        if (problem === null) onClose();
        else setNotice(problem);
      }
    },
    [onClose, onOpen, setQuery],
  );

  // Enter while the answer is still on its way: open the best one when it comes.
  const { searching, rows, active, failed } = view;
  useEffect(() => {
    if (!enterWhenReady.current || searching) return;
    enterWhenReady.current = false;
    const row = rows[active];
    if (row !== undefined && !failed) void choose(row);
  }, [searching, rows, active, failed, choose]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // A menu opened from a chip is drawn elsewhere but sends its keys here, through React: they are the menu's.
    const root = panel.current;
    if (root === null || !(e.target instanceof Node) || !root.contains(e.target) || e.nativeEvent.isComposing) return;
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      case 'ArrowDown':
      case 'ArrowUp':
        e.preventDefault();
        view.move(e.key === 'ArrowDown' ? 1 : -1);
        if (e.target !== input.current) input.current?.focus({ preventScroll: true });
        return;
      case 'Enter':
        if (e.target !== input.current) return; // a chip's own Enter presses it
        e.preventDefault();
        if (searching) enterWhenReady.current = true;
        else if (lit !== undefined) void choose(lit);
        return;
      case 'Tab': {
        const stops = Array.from(root.querySelectorAll<HTMLElement>('input, button:not([disabled])'));
        const first = stops[0];
        const last = stops.at(-1);
        if (first === undefined || last === undefined) return;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
        return;
      }
    }
  };

  let optionIndex = -1;
  const typed = view.query.trim() !== '';
  // S18's `tag:` and `course:`, said where they can be seen (TB5): "tag: or course:".
  const keys = operatorKeys();
  const tip = keys.length === 0 ? null : keys.map((k) => `${k}:`).join(' or ');
  const body = unavailable !== null ? (
    <p className={styles.note}>{unavailable}</p>
  ) : view.failed ? (
    <p className={styles.note}>Couldn’t search your library just now. Try again.</p>
  ) : view.nothingFound ? (
    <p className={styles.note}>
      No results for “{view.query.trim()}”.
      <br />
      {isNarrowed(view.filters)
        ? 'Try turning off a filter, or other words.'
        : unknownOperator(view.query) !== null && tip !== null
          ? `Try ${tip}, or other words.`
          : 'Try other words, or fewer of them.'}
    </p>
  ) : view.libraryEmpty ? (
    <p className={styles.note}>Your library is empty. A PDF you save will show up here.</p>
  ) : null;

  const summary = searching ? '' : typed ? (rows.length === 0 ? 'No results' : `${rows.length} ${rows.length === 1 ? 'result' : 'results'}`) : '';

  return createPortal(
    <div
      className={at?.bar === true ? `${styles.layer} ${styles.barLayer}` : styles.layer}
      onKeyDown={onKeyDown}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        className={at?.bar === true ? `${styles.panel} ${styles.barPanel}` : styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        style={
          at === null
            ? undefined
            : {
                position: 'absolute',
                top: at.top,
                ...(at.left === undefined ? {} : { left: at.left }),
                // Centred with no width of its own: the 16 px gutters it has when it is not anchored.
                ...(at.width === undefined ? { width: 'calc(100% - 2 * var(--space-4))' } : { width: at.width, maxWidth: 'none' }),
                maxHeight: `calc(100vh - ${Math.round(at.top)}px - var(--space-4))`,
              }
        }
      >
        <div className={styles.top}>
          <div className={styles.field}>
            <span className={styles.lead}>
              <Icon name="search" size={24} />
            </span>
            <input
              ref={input}
              className={styles.input}
              type="text"
              role="combobox"
              aria-expanded={rows.length > 0}
              aria-controls={`${base}-list`}
              aria-activedescendant={litId}
              aria-autocomplete="list"
              aria-label={PLACEHOLDER}
              aria-describedby={tip === null ? undefined : `${base}-tip`}
              placeholder={PLACEHOLDER}
              value={view.query}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              enterKeyHint="search"
              onChange={(e) => {
                setNotice(null);
                view.setQuery(e.currentTarget.value);
              }}
            />
            {view.query !== '' && (
              <IconButton
                icon="close"
                label="Clear search"
                size={40}
                onClick={() => {
                  view.setQuery('');
                  input.current?.focus({ preventScroll: true });
                }}
              />
            )}
          </div>
          {unavailable === null && <Chips filters={view.filters} onChange={view.setFilters} />}
        </div>
        <div ref={list} className={styles.results} data-stale={searching && view.rows.length > 0 ? 'true' : 'false'}>
          <div id={`${base}-list`} role="listbox" aria-label="Results" className={styles.list}>
            {view.groups.map((g) => (
              <div key={g.id} role="group" aria-labelledby={`${base}-g-${g.id}`} className={styles.group}>
                <div id={`${base}-g-${g.id}`} className={styles.heading}>
                  {g.heading}
                </div>
                {g.rows.map((row) => {
                  const i = ++optionIndex;
                  return (
                    <Option
                      key={row.key}
                      id={`${base}-o${i}`}
                      row={row}
                      lit={i === view.active}
                      onLight={() => view.setActive(i)}
                      onChoose={() => void choose(row)}
                    />
                  );
                })}
              </div>
            ))}
          </div>
          {body}
          {notice !== null && (
            <p className={styles.note} role="alert">
              {notice}
            </p>
          )}
        </div>
        <div className={styles.footer}>
          <span aria-hidden="true">
            <kbd className={styles.key}>↑</kbd> <kbd className={styles.key}>↓</kbd> Move
          </span>
          <span aria-hidden="true">
            <kbd className={styles.key}>Enter</kbd> Open
          </span>
          <span aria-hidden="true">
            <kbd className={styles.key}>Esc</kbd> Close
          </span>
          {tip !== null && (
            <span id={`${base}-tip`} className={styles.tip}>
              Tip: type {keys.map((k, i) => (
                <span key={k}>
                  {i > 0 && ' or '}
                  <kbd className={styles.key}>{k}:</kbd>
                </span>
              ))}{' '}
              to find readings by tag or course
            </span>
          )}
        </div>
        <p className={styles.srOnly} role="status">
          {summary}
        </p>
      </div>
    </div>,
    document.body,
  );
}

// ---- one answer -------------------------------------------------------------------------------------------------------------

function Marked({ parts }: { parts: readonly TextPart[] }): ReactNode {
  return parts.map((p, i) => (p.bold ? <b key={i}>{p.text}</b> : p.text));
}

function Option({ id, row, lit, onLight, onChoose }: { id: string; row: PaletteRow; lit: boolean; onLight(this: void): void; onChoose(this: void): void }) {
  return (
    <div
      id={id}
      role="option"
      aria-selected={lit}
      className={row.compact ? styles.compactRow : styles.row}
      data-lit={lit ? 'true' : 'false'}
      onMouseMove={() => {
        if (!lit) onLight();
      }}
      // The field keeps the focus: the press must not take it.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onChoose}
    >
      <span className={row.compact ? styles.smallIcon : styles.icon}>
        {row.icon === 'pdf' ? <FileTypeIcon kind="pdf" size={32} /> : <Icon name={row.icon} size={row.compact ? 20 : 24} />}
      </span>
      <span className={styles.text}>
        <span className={row.compact ? styles.label : styles.title}>
          <Marked parts={row.title} />
        </span>
        {row.detail.length > 0 && (
          <span className={styles.detail}>
            <Marked parts={row.detail} />
          </span>
        )}
      </span>
      {row.trail !== null && <span className={styles.trail}>{row.trail}</span>}
    </div>
  );
}

// ---- the filter chips -------------------------------------------------------------------------------------------------------

type ChipProps = Omit<ComponentPropsWithRef<'button'>, 'children'> & { label: string; selected: boolean; kind: 'toggle' | 'menu' };

/** Drive's filter chip (02 section 4.5). It passes its props and ref on to the <button>, so a menu can use it as its trigger. */
function ChipButton({ label, selected, kind, className, ...rest }: ChipProps) {
  return (
    <button type="button" {...rest} aria-pressed={kind === 'toggle' ? selected : undefined} className={[styles.chip, selected ? styles.chipOn : '', className ?? ''].join(' ').trim()}>
      {kind === 'toggle' && selected && <Icon name="check" size={20} />}
      <span>{label}</span>
      {kind === 'menu' && <Icon name="arrow_drop_down" size={20} />}
    </button>
  );
}

function Chips({ filters, onChange }: { filters: PaletteFilters; onChange(this: void, f: PaletteFilters): void }) {
  const kindsLabel = (() => {
    const [first, ...rest] = filters.kinds;
    return first === undefined ? 'Type' : rest.length === 0 ? KIND_LABELS[first] : `${KIND_LABELS[first]} +${rest.length}`;
  })();
  const openedItems: MenuItemDef[] = OPENED_RANGES.map((r) => ({
    kind: 'item',
    id: r,
    label: OPENED_LABELS[r],
    checked: filters.opened === r,
    onSelect: () => onChange({ ...filters, opened: filters.opened === r ? null : r }),
  }));
  const kindItems: MenuItemDef[] = KINDS.map((k) => ({
    kind: 'item',
    id: k,
    label: KIND_LABELS[k],
    checked: filters.kinds.includes(k),
    onSelect: () => onChange({ ...filters, kinds: filters.kinds.includes(k) ? filters.kinds.filter((x) => x !== k) : [...filters.kinds, k] }),
  }));
  return (
    <div className={styles.chips} role="group" aria-label="Narrow the search">
      <ChipButton kind="toggle" label="Starred" selected={filters.starred} onClick={() => onChange({ ...filters, starred: !filters.starred })} />
      <ChipButton kind="toggle" label="Has notes" selected={filters.hasNotes} onClick={() => onChange({ ...filters, hasNotes: !filters.hasNotes })} />
      <DropdownMenu
        items={openedItems}
        trigger={
          <ChipButton
            kind="menu"
            label={filters.opened === null ? 'Last opened' : OPENED_LABELS[filters.opened]}
            selected={filters.opened !== null}
            aria-label={`Last opened: ${filters.opened === null ? 'any time' : OPENED_LABELS[filters.opened]}`}
          />
        }
      />
      <DropdownMenu
        items={kindItems}
        trigger={<ChipButton kind="menu" label={kindsLabel} selected={filters.kinds.length > 0} aria-label={`Type: ${filters.kinds.length === 0 ? 'any' : kindsLabel}`} />}
      />
      {isNarrowed(filters) && (
        <button type="button" className={styles.clearFilters} onClick={() => onChange(NO_PALETTE_FILTERS)}>
          Clear filters
        </button>
      )}
    </div>
  );
}

import type { MarkColor } from '@sop/core';
import { DropdownMenu as RadixDropdownMenu } from 'radix-ui';
import { type FocusEvent, type KeyboardEvent, useRef } from 'react';
import { Icon } from '../icons/Icon';
import styles from './ColorSwatches.module.css';

/** The five colour slots, in the order the menu shows them (contracts D5). */
export const MARK_COLORS: readonly MarkColor[] = [1, 2, 3, 4, 5];

/** The name of each slot, for screen readers and any text that names a colour. The values are tokens --sop-mark-N. */
export const MARK_COLOR_NAMES: Readonly<Record<MarkColor, string>> = {
  1: 'Yellow',
  2: 'Green',
  3: 'Blue',
  4: 'Pink',
  5: 'Orange',
};

/**
 * The colour that a number key picks: 1 to 5 on the number row (or the number pad), with no modifier held, else null.
 * Matched by the key's position (`code`), not the character it types, as the spec asks for the number row; so it works
 * on AZERTY too, where the unshifted keys type & é " ' (.
 */
export function markColorForKey(e: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey'>): MarkColor | null {
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return null;
  const m = /^(?:Digit|Numpad)([1-5])$/u.exec(e.code);
  return m === null ? null : (Number(m[1]) as MarkColor);
}

export interface ColorSwatchesProps {
  /** The current colour (the setting marks.lastColor). Its swatch shows a check. */
  value: MarkColor;
  /** A swatch was clicked, or chosen with Enter or Space. (ContextMenu runs the pick once the menu has closed.) */
  onPick(this: void, c: MarkColor): void;
}

const ROW_ITEMS = '[role^="menuitem"]:not([data-disabled])';

/**
 * The row of five colour swatches at the top of ContextMenu: a menu radio group, one `menuitemradio` per colour,
 * named "Yellow" … "Orange" and checked on the current one. It only works inside a Radix DropdownMenu (ContextMenu).
 *
 * Keyboard: Left and Right move along the row. Up and Down treat the row as one stop: they leave it for the item
 * above or below, and coming back by keyboard lands on the current colour, not on whichever end is nearest.
 * Typeahead skips the swatches, so B still finds Bold. The keys 1 to 5 are handled by ContextMenu, anywhere in it.
 */
export function ColorSwatches({ value, onPick }: ColorSwatchesProps) {
  const row = useRef<HTMLDivElement | null>(null);
  const swatches = useRef<(HTMLDivElement | null)[]>([]);
  // Radix focuses whatever item the mouse moves over; only keyboard focus is sent to the current colour.
  const pointerInRow = useRef(false);

  const focusSwatch = (index: number) => {
    swatches.current[(index + MARK_COLORS.length) % MARK_COLORS.length]?.focus({ preventScroll: true });
  };

  // Up and Down: the next enabled item outside the row, wrapping round the menu as Radix's own loop does.
  const leaveRow = (direction: 1 | -1) => {
    const menu = row.current?.closest('[role="menu"]');
    if (menu === null || menu === undefined || row.current === null) return;
    const all = [...menu.querySelectorAll<HTMLElement>(ROW_ITEMS)];
    const first = all.findIndex((el) => row.current?.contains(el));
    const last = all.findLastIndex((el) => row.current?.contains(el));
    const after = all.slice(last + 1);
    const before = all.slice(0, first);
    const order = direction === 1 ? [...after, ...before] : [...before.reverse(), ...after.reverse()];
    order[0]?.focus({ preventScroll: true });
  };

  const onKeyDown = (index: number) => (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (step !== undefined) {
      e.preventDefault();
      focusSwatch(index + step);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      // preventDefault also stops Radix's own roving focus, which would step to the next swatch
      e.preventDefault();
      leaveRow(e.key === 'ArrowDown' ? 1 : -1);
    }
  };

  const onFocus = (index: number) => (e: FocusEvent<HTMLDivElement>) => {
    const current = MARK_COLORS.indexOf(value);
    if (pointerInRow.current || index === current) return;
    const from = e.relatedTarget;
    if (from instanceof Node && row.current?.contains(from) === true) return;
    // Radix's own focus handler runs after this one and would mark this swatch highlighted again after it has lost
    // focus to the current colour (two rings). preventDefault makes Radix skip it.
    e.preventDefault();
    focusSwatch(current);
  };

  return (
    <RadixDropdownMenu.RadioGroup
      ref={row}
      className={styles.row}
      value={String(value)}
      aria-label="Highlight colour"
      onPointerEnter={() => {
        pointerInRow.current = true;
      }}
      onPointerLeave={() => {
        pointerInRow.current = false;
      }}
    >
      {MARK_COLORS.map((color, index) => (
        <RadixDropdownMenu.RadioItem
          key={color}
          ref={(el) => {
            swatches.current[index] = el;
          }}
          className={styles.swatch}
          value={String(color)}
          data-color={color}
          aria-label={MARK_COLOR_NAMES[color]}
          aria-keyshortcuts={String(color)}
          // An empty text value keeps the swatches out of typeahead
          textValue=""
          onSelect={() => onPick(color)}
          onKeyDown={onKeyDown(index)}
          onFocus={onFocus(index)}
        >
          <span className={styles.dot}>
            <RadixDropdownMenu.ItemIndicator className={styles.check}>
              <Icon name="check" size={20} />
            </RadixDropdownMenu.ItemIndicator>
          </span>
        </RadixDropdownMenu.RadioItem>
      ))}
      <span className={styles.hint} aria-hidden="true">
        1–5
      </span>
    </RadixDropdownMenu.RadioGroup>
  );
}

import '../tokens/tokens.css';
import { cx } from '../components/classes';
import { Tooltip } from '../components/Tooltip';
import { Icon } from '../icons/Icon';
import type { IconName } from '../icons/names';
import styles from './SegmentedToggle.module.css';

export interface SegmentOption<V extends string> {
  value: V;
  icon: IconName;
  /** The accessible name and the tooltip: "List layout". */
  label: string;
}

export interface SegmentedToggleProps<V extends string> {
  options: readonly SegmentOption<V>[];
  value: V;
  onChange(this: void, value: V): void;
  /** The group's accessible name: "Layout". */
  label: string;
}

/**
 * Drive's list/grid toggle (02 section 4.5): a 32 px outlined segmented button with round ends and a 1 px #747775
 * divider. The selected half is #c2e7ff and shows a check before its icon (#001d35). The arrow keys move the choice.
 */
export function SegmentedToggle<V extends string>({ options, value, onChange, label }: SegmentedToggleProps<V>) {
  const move = (step: number) => {
    const at = options.findIndex((o) => o.value === value);
    const next = options[(at + step + options.length) % options.length];
    if (next !== undefined) onChange(next.value);
  };
  return (
    <div
      className={styles.group}
      role="radiogroup"
      aria-label={label}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') move(1);
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') move(-1);
        else return;
        e.preventDefault();
        // the newly chosen half takes the focus, as a radio group does
        const group = e.currentTarget;
        requestAnimationFrame(() => group.querySelector<HTMLElement>('[aria-checked="true"]')?.focus());
      }}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Tooltip key={o.value} label={o.label}>
            <button
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={o.label}
              tabIndex={on ? 0 : -1}
              className={cx(styles.half, on && styles.on)}
              onClick={() => onChange(o.value)}
            >
              {on && <Icon name="check" size={20} />}
              <Icon name={o.icon} size={20} />
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}

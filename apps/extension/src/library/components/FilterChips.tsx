import { DropdownMenu, TextButton } from '@sop/ui';
import { ChipRow, FilterChip } from '@sop/ui/library';
import { type Filters, isFiltered, KIND_LABELS, KINDS, NO_FILTERS, OPENED_LABELS, OPENED_RANGES } from './filters';

export type ChipName = 'type' | 'notes' | 'opened';

function typeLabel(f: Filters): string {
  const [first, ...rest] = f.kinds;
  if (first === undefined) return 'Type';
  return rest.length === 0 ? KIND_LABELS[first] : `${KIND_LABELS[first]} +${rest.length}`;
}

/** Drive's filter chips (02 section 4.5) for the library's filters: Type, Has notes and Last opened. */
export function FilterChips({ chips, value, onChange }: { chips: readonly ChipName[]; value: Filters; onChange(this: void, f: Filters): void }) {
  return (
    <ChipRow label="Filters">
      {chips.includes('type') && (
        <DropdownMenu
          items={KINDS.map((k) => ({
            kind: 'item',
            id: k,
            label: KIND_LABELS[k],
            checked: value.kinds.includes(k),
            onSelect: () => onChange({ ...value, kinds: value.kinds.includes(k) ? value.kinds.filter((x) => x !== k) : [...value.kinds, k] }),
          }))}
          trigger={<FilterChip kind="menu" label={typeLabel(value)} selected={value.kinds.length > 0} aria-label={`Type: ${value.kinds.length === 0 ? 'any' : typeLabel(value)}`} />}
        />
      )}
      {chips.includes('notes') && (
        <FilterChip kind="toggle" label="Has notes" selected={value.hasNotes} onClick={() => onChange({ ...value, hasNotes: !value.hasNotes })} />
      )}
      {chips.includes('opened') && (
        <DropdownMenu
          items={OPENED_RANGES.map((r) => ({
            kind: 'item',
            id: r,
            label: OPENED_LABELS[r],
            checked: value.opened === r,
            onSelect: () => onChange({ ...value, opened: value.opened === r ? null : r }),
          }))}
          trigger={
            <FilterChip
              kind="menu"
              label={value.opened === null ? 'Last opened' : OPENED_LABELS[value.opened]}
              selected={value.opened !== null}
              aria-label={`Last opened: ${value.opened === null ? 'any time' : OPENED_LABELS[value.opened]}`}
            />
          }
        />
      )}
      {isFiltered(value) && <TextButton label="Clear filters" onClick={() => onChange(NO_FILTERS)} />}
    </ChipRow>
  );
}

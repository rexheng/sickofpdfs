// "Group by" at the right of My library's title row: None, Topic, Course, Tag or Kind (R92 smart sorting).
import { DropdownMenu, type MenuItemDef } from '@sop/ui';
import { QuietButton } from '@sop/ui/library';
import { type Grouping, GROUPING_LABELS, GROUPINGS } from './grouping';

export function GroupByMenu({ value, onChange }: { value: Grouping; onChange(this: void, g: Grouping): void }) {
  const items: MenuItemDef[] = GROUPINGS.map((g) => ({ kind: 'item', id: `group-${g}`, label: GROUPING_LABELS[g], checked: value === g, onSelect: () => onChange(g) }));
  return (
    <DropdownMenu
      align="end"
      items={items}
      trigger={<QuietButton icon="workspaces" label={value === 'none' ? 'Group by' : `Grouped by ${GROUPING_LABELS[value].toLowerCase()}`} aria-label={`Group by: ${GROUPING_LABELS[value]}`} />}
    />
  );
}

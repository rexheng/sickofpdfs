import { DropdownMenu, type MenuItemDef } from '@sop/ui';
import { QuietButton } from '@sop/ui/library';
import { directionLabels, NATURAL_DIR, SORT_LABELS, type Sort, type SortBy } from './sort';

const FIELDS: readonly SortBy[] = ['title', 'lastOpened', 'added', 'pages'];

/** Drive's "Sort" button at the right of the table header: what to sort by, then which way round. */
export function SortMenu({ sort, onSort }: { sort: Sort; onSort(this: void, s: Sort): void }) {
  const dirs = directionLabels(sort.by);
  const items: MenuItemDef[] = [
    ...FIELDS.map(
      (by): MenuItemDef => ({
        kind: 'item',
        id: `by-${by}`,
        label: SORT_LABELS[by],
        checked: sort.by === by,
        onSelect: () => onSort(sort.by === by ? sort : { by, dir: NATURAL_DIR[by] }),
      }),
    ),
    { kind: 'separator' },
    ...(['asc', 'desc'] as const).map(
      (dir): MenuItemDef => ({ kind: 'item', id: `dir-${dir}`, label: dirs[dir], checked: sort.dir === dir, onSelect: () => onSort({ ...sort, dir }) }),
    ),
  ];
  return <DropdownMenu align="end" items={items} trigger={<QuietButton icon="sort" label="Sort" aria-label={`Sort: ${SORT_LABELS[sort.by]}, ${dirs[sort.dir]}`} />} />;
}

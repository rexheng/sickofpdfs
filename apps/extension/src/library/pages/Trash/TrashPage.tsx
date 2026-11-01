import { EmptyState } from '@sop/ui/library';
import { ReadingsView, ViewNote } from '../../components/ReadingsView';

/** Trash: readings you removed, kept 30 days (spec), each with Restore. */
export function TrashPage() {
  return (
    <ReadingsView
      title="Trash"
      view="trash"
      defaultSort={{ by: 'title', dir: 'asc' }}
      sortable
      chips={[]}
      note={<ViewNote>Readings in Trash are deleted for good after 30 days, with their notes.</ViewNote>}
      empty={
        <EmptyState icon="delete" title="Trash is empty">
          <p>Readings you move to Trash stay here for 30 days. You can restore them, with their notes, until then.</p>
        </EmptyState>
      }
    />
  );
}

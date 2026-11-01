import { EmptyState } from '@sop/ui/library';
import { ReadingsView } from '../../components/ReadingsView';

/** Starred: the readings you starred. */
export function StarredPage() {
  return (
    <ReadingsView
      title="Starred"
      view="starred"
      defaultSort={{ by: 'title', dir: 'asc' }}
      sortable
      chips={['type', 'notes', 'opened']}
      empty={
        <EmptyState icon="star" title="No starred readings">
          <p>Star the readings you go back to, so they are easy to find. Right-click a reading and choose Add to Starred.</p>
        </EmptyState>
      }
    />
  );
}

import { EmptyState } from '@sop/ui/library';
import { ReadingsView } from '../../components/ReadingsView';

/** Recent: readings by when you last opened them, newest first, under Drive's date headings. */
export function RecentPage() {
  return (
    <ReadingsView
      title="Recent"
      view="recent"
      defaultSort={{ by: 'lastOpened', dir: 'desc' }}
      sortable={false}
      groupByDate
      chips={['type', 'notes']}
      empty={
        <EmptyState icon="schedule" title="Nothing opened yet">
          <p>The PDFs you read show up here, newest first.</p>
        </EmptyState>
      }
    />
  );
}

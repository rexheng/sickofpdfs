import { TextButton } from '@sop/ui';
import { EmptyState } from '@sop/ui/library';
import { useLibrary } from '../../app/context';
import { ReadingsView } from '../../components/ReadingsView';
import { useTagInAddress } from '../../tags/tag-route';

/** My library: every saved reading, as a list or a grid, sorted like Drive (title A to Z to start with). */
export function MyLibraryPage() {
  const { pickFile } = useLibrary();
  const tag = useTagInAddress(); // S18: `#/library?tag=…` shows only that tag's readings
  return (
    <ReadingsView
      title="My library"
      view="all"
      defaultSort={{ by: 'title', dir: 'asc' }}
      sortable
      groupable
      tagFilter={tag}
      chips={['type', 'notes', 'opened']}
      empty={
        <EmptyState icon="auto_stories" title="Your learning PDFs will appear here" actions={<TextButton label="Open a PDF" variant="tonal" onClick={pickFile} />}>
          <p>Open a paper, lecture notes or a textbook in Chrome, and it is saved here by itself, with your notes.</p>
          <p>Receipts and private documents are never saved.</p>
        </EmptyState>
      }
    />
  );
}

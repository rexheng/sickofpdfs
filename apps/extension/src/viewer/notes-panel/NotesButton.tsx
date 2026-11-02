// "Notes" in the toolbar pill, beside "Comment": every note of the PDF in the panel (Shift+F4), with how many there are.
// It replaces the round "Show notes" button that sat at the bottom right over the margin, where it hid a card's Send
// button and its words (TB2 critics). When the cards do not fit beside the pages (R69), they fold into this button.
import { IconButton, TextButton, Tooltip } from '@sop/ui';
import { useCompactToolbar } from '../chrome/compact';
import { useNotesButton, useNotesPanelOpen } from './panel-state';
import styles from './NotesButton.module.css';

export function NotesButton() {
  const b = useNotesButton();
  const open = useNotesPanelOpen();
  const compact = useCompactToolbar();
  if (b === null) return null;
  const count = b.count === 1 ? '1 note' : `${b.count} notes`;
  // The compact pill (a narrow window, chrome/compact.ts): the icon and the count, without the word.
  if (compact && b.count === 0) {
    return (
      <IconButton
        icon="comment"
        label={open ? 'Hide notes' : 'Show all notes'}
        shortcut="Shift+F4"
        className={styles.icon}
        pressed={open}
        onMouseDown={(e) => e.preventDefault()}
        onClick={b.toggle}
      />
    );
  }
  return (
    <Tooltip label={open ? 'Hide notes' : 'Show all notes'} shortcut="Shift+F4">
      <TextButton
        label={compact ? String(b.count) : b.count > 0 ? `Notes ${b.count}` : 'Notes'}
        icon="comment"
        className={styles.button}
        aria-label={`Notes, ${count}`}
        aria-pressed={open}
        // Keep the text selection: opening the panel must not clear what the reader selected.
        onMouseDown={(e) => e.preventDefault()}
        onClick={b.toggle}
      />
    </Tooltip>
  );
}

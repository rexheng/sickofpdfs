// R77 (no lost notes): "Recovered notes" on the Notes page. Notes this computer kept that no PDF will take back: drafts an
// old build left with no document id, and notes waiting for a PDF that has not been opened for 7 days (recovered-notes.ts).
// Each shows its text and when it was typed, with Copy and Delete. Nothing here is ever deleted except by Delete, which asks
// once. The section is not there when it is empty.
import { CommentAvatar, Dialog, formatCommentTime, formatCommentTimeFull, TextButton } from '@sop/ui';
import { useCallback, useEffect, useState } from 'react';
import { deleteRecoveredNote, listRecoveredNotes, type RecoveredNote } from '../../../viewer/annotations/recovered-notes';
import { localPendingSaves } from '../../../viewer/annotations/save-pending';
import { tabsHoldingLocks } from '../../../viewer/annotations/tab-presence';
import { useLibrary } from '../../app/context';
import { copyText } from '../../components/reading-actions';
import styles from './Notes.module.css';

const KIND_WORDS: Record<RecoveredNote['kind'], string> = { note: 'Note', edit: 'Change to a note, not sent', highlight: 'Highlight' };

/** The recovered notes, without the ones a tab that is still open holds (they are recovered once that tab has gone). */
async function recoveredNow(): Promise<RecoveredNote[]> {
  const live = new Set(await tabsHoldingLocks());
  // A crash can take a waiting note out of localStorage: the copy of a tab that has gone goes back first (save-pending.ts).
  await localPendingSaves()?.recover?.(null, (rec) => live.has(rec.tab));
  return listRecoveredNotes().filter((n) => n.heldBy === undefined || !live.has(n.heldBy));
}

/** Read again when another tab changes the journal, and when the page comes back into view. */
export function useRecoveredNotes(): [RecoveredNote[], () => void] {
  const [notes, setNotes] = useState<RecoveredNote[]>(() => listRecoveredNotes().filter((n) => n.heldBy === undefined));
  const refresh = useCallback(() => void recoveredNow().then(setNotes), []);
  useEffect(() => {
    refresh(); // a note a tab that has gone held shows now
    addEventListener('storage', refresh);
    addEventListener('focus', refresh);
    return () => {
      removeEventListener('storage', refresh);
      removeEventListener('focus', refresh);
    };
  }, [refresh]);
  return [notes, refresh];
}

export function RecoveredNotes({ now }: { now: number }) {
  const { notify } = useLibrary();
  const [notes, refresh] = useRecoveredNotes();
  const [asking, setAsking] = useState<RecoveredNote | null>(null);
  if (notes.length === 0) return null;

  const copy = (n: RecoveredNote) => void copyText(n.text).then((ok) => notify({ text: ok ? 'Copied. Paste it anywhere you like.' : 'Couldn’t copy it. Try again.' }));
  const remove = (n: RecoveredNote) => {
    deleteRecoveredNote(n.key);
    refresh();
    notify({ text: 'Note deleted' });
  };

  return (
    <section className={styles.recovered} aria-labelledby="recovered-title">
      <h2 id="recovered-title" className={styles.recoveredTitle}>
        Recovered notes
      </h2>
      <p className={styles.recoveredText}>
        These notes were kept on this computer, but they can’t go back on their PDF. Copy the ones you want to keep, then delete them. Nothing here goes
        unless you choose Delete.
      </p>
      <ul className={styles.recoveredList}>
        {notes.map((n) => (
          <li key={n.key} className={styles.recoveredItem}>
            <CommentAvatar author="me" />
            <div className={styles.recoveredBody}>
              <span className={styles.recoveredMeta}>
                {KIND_WORDS[n.kind]} ·{' '}
                <time dateTime={new Date(n.at).toISOString()} title={formatCommentTimeFull(n.at)}>
                  {n.at > 0 ? `typed ${formatCommentTime(n.at, now)}` : 'time not known'}
                </time>
              </span>
              <p className={styles.recoveredNote}>{n.kind === 'highlight' ? (n.text === '' ? 'A highlight (its words were not kept)' : `“${n.text}”`) : n.text}</p>
            </div>
            <div className={styles.recoveredActions}>
              <TextButton label="Copy" icon="content_copy" disabled={n.text === ''} onClick={() => copy(n)} />
              <TextButton label="Delete" icon="delete" onClick={() => setAsking(n)} />
            </div>
          </li>
        ))}
      </ul>
      <Dialog
        open={asking !== null}
        title="Delete this note for good?"
        onOpenChange={(open) => !open && setAsking(null)}
        actions={[
          { label: 'Cancel', onClick: () => setAsking(null) },
          {
            label: 'Delete',
            primary: true,
            onClick: () => {
              const n = asking;
              setAsking(null);
              if (n !== null) remove(n);
            },
          },
        ]}
      >
        <p className={styles.dialogText}>It can’t be brought back. Copy it first if you want to keep it.</p>
      </Dialog>
    </section>
  );
}

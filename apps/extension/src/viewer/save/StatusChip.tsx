// The library status chip in the header (Task 30): it always shows the save decision, and clicking it saves (as
// Ctrl+Alt+S does). After a first mark saved the PDF, "Undo" stands next to it for 10 s.
import type { SaveState } from '@sop/core';
import { Chip, type ChipProps, TextButton } from '@sop/ui';
import { useCallback, useState, useSyncExternalStore } from 'react';
import type { SaveControllerImpl } from './save-controller';
import styles from './StatusChip.module.css';

/** The chip's tooltip on a PDF that was already in the library when it opened. */
export const ALREADY_SAVED = 'Already in your library';
/** The tooltip of a "Not saved" chip, which saves when clicked. */
const SAVE_HINT = 'Save it to your library (Ctrl+Alt+S)';

type ChipLook = Pick<ChipProps, 'label' | 'icon' | 'tone' | 'tooltip' | 'disabled'> & { saves: boolean };

/** The chip after a save failed (R67 a): the notes are still kept in this tab and on this computer. */
export const SAVE_FAILED = 'Couldn’t save. Try again';
const SAVE_FAILED_HINT = 'Your notes are kept on this computer. Click to try again.';

/** The tooltip of the "In Trash" chip (ruling R76). */
export const IN_TRASH_HINT = 'This PDF is in your library’s Trash. Restore it to keep it and its notes.';

/** What else the chip must know besides the state: an earlier save failed (R67 a), or the saved PDF is in the Trash (R76 d). */
export interface ChipFlags {
  failed?: boolean;
  trashed?: boolean;
  /** R67 tightened (4): a save left by a tab that closed or crashed is being finished. */
  resuming?: boolean;
}

/** The chip while a save left by a tab that closed or crashed is finished (R67 tightened 4). */
export const SAVING_NOTES = 'Saving your notes…';
const SAVING_NOTES_HINT = 'Your notes from last time are being saved to your library.';

/**
 * What the chip shows for a state; null for none (while the PDF is being checked). One look at a time, in this order:
 * 0. "Saving your notes…": a save a closed or crashed tab left is being finished (R67 tightened 4).
 * 1. "Saving…": a save running now is the newest fact, and it settles the other two (it ends in "Saved" or "Couldn't save").
 * 2. "In Trash": the PDF is in the library, so nothing failed to save; the owner must see that it is on its way out.
 * 3. "Couldn't save. Try again": an earlier attempt failed, and the notes are only on this computer until a save works.
 * 4. The state itself.
 * "In Trash" only comes with `saved`, and "Couldn't save" and "Saving…" never do, so the order decides nothing in practice;
 * it is written down so a later change keeps it.
 */
export function chipFor(state: SaveState, busy: SaveControllerImpl['busy'], savedReasons: readonly string[] | null, flags: ChipFlags = {}): ChipLook | null {
  const { failed = false, trashed = false, resuming = false } = flags;
  if (resuming && !failed && state.kind !== 'saved' && state.kind !== 'asking') {
    return { label: SAVING_NOTES, icon: 'library_add', tone: 'attention', tooltip: SAVING_NOTES_HINT, saves: false };
  }
  if (busy === 'save' && state.kind !== 'saved') return { label: 'Saving…', icon: 'library_add', tone: 'attention', saves: false };
  if (trashed && state.kind === 'saved') return { label: 'In Trash', icon: 'delete', tone: 'neutral', tooltip: IN_TRASH_HINT, saves: false };
  if (failed && busy === null && state.kind !== 'saved' && state.kind !== 'asking' && state.kind !== 'incognito') {
    return { label: SAVE_FAILED, icon: 'error', tone: 'attention', tooltip: SAVE_FAILED_HINT, saves: true };
  }
  switch (state.kind) {
    case 'checking':
      return null;
    case 'saved':
      return {
        label: 'Saved to library',
        icon: 'library_add_check',
        tone: 'saved',
        tooltip: tooltipOf(savedReasons ?? []) ?? ALREADY_SAVED,
        saves: false,
      };
    case 'unsure':
      return { label: 'Not sure: Save?', icon: 'library_add', tone: 'attention', tooltip: tooltipOf(state.reasons), saves: true };
    case 'not-learning':
      return { label: `Not saved: ${state.reasons[0] ?? 'not a learning PDF'}`, tone: 'neutral', tooltip: SAVE_HINT, saves: true };
    case 'asking':
      return { label: 'Not saved', tone: 'neutral', saves: false };
    case 'memory-only':
      return { label: 'Not saved: notes kept until you close this tab', tone: 'neutral', tooltip: SAVE_HINT, saves: true };
    case 'incognito':
      return { label: 'Incognito: view only', tone: 'neutral', disabled: true, saves: false };
  }
}

/** The tooltip shows this many reasons at most, so it stays one short line. */
const TOOLTIP_REASONS = 3;

function tooltipOf(reasons: readonly string[]): string | undefined {
  return reasons.length > 0 ? reasons.slice(0, TOOLTIP_REASONS).join(', ') : undefined;
}

/** The controller's state and running effect, re-read whenever it announces a change. */
export function useSaveView(save: SaveControllerImpl | null): {
  state: SaveState | null;
  busy: SaveControllerImpl['busy'];
  failed: boolean;
  trashed: boolean;
  resuming: boolean;
} {
  const subscribe = useCallback((cb: () => void) => save?.subscribe(cb) ?? (() => {}), [save]);
  const state = useSyncExternalStore(subscribe, () => save?.state ?? null);
  const busy = useSyncExternalStore(subscribe, () => save?.busy ?? null);
  const failed = useSyncExternalStore(subscribe, () => save?.failed ?? false);
  const trashed = useSyncExternalStore(subscribe, () => save?.trashed ?? false);
  const resuming = useSyncExternalStore(subscribe, () => save?.resuming ?? false);
  return { state, busy, failed, trashed, resuming };
}

export interface StatusChipProps {
  save: SaveControllerImpl;
}

/** A failed save or Undo is told by the App's note (SaveControllerImpl.onFailure); here it only must not go unhandled. */
const quietly = (p: Promise<void>): void => void p.catch(() => {});

export function StatusChip({ save }: StatusChipProps) {
  const { state, busy, failed, trashed, resuming } = useSaveView(save);
  const [restoring, setRestoring] = useState(false);
  if (state === null) return null;
  const look = chipFor(state, busy, save.savedReasons, { failed, trashed, resuming });
  if (look === null) return null;
  const { saves, ...chip } = look;
  return (
    <div className={styles.status}>
      <Chip {...chip} className={styles.chip} onClick={saves ? () => quietly(save.requestSave()) : undefined} />
      {state.kind === 'saved' && trashed && (
        <TextButton
          label="Restore"
          disabled={restoring}
          onClick={() => {
            setRestoring(true);
            quietly(save.restoreFromTrash().finally(() => setRestoring(false)));
          }}
        />
      )}
      {state.kind === 'saved' && state.undoable && (
        <TextButton label="Undo" disabled={busy === 'forget'} onClick={() => quietly(save.undo())} />
      )}
    </div>
  );
}

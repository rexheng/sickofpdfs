// The library status chip in the header (Task 30, worded for Phase 3's real filter by S11 and ruling R73): it always shows
// the save decision. On a PDF that is not saved, clicking it saves (as Ctrl+Alt+S does). On a saved PDF it opens a small
// menu with "Remove from library…" (the Forget flow). After a first mark saved the PDF, "Undo" stands next to it for 10 s.
//
// Wording (R73: plain, for an owner who reads best in short sentences):
//   not sure      "Save to library"                               hover: "This PDF isn't in your library yet. Save it to keep your notes."
//   not learning  "Not saved: looks like an invoice or receipt"   hover: "Click to save it to your library anyway." and what else it saw
//   saved         "Saved to library"                              hover: the reasons ("References section, DOI, 40 pages")
// "No filter yet" never shows.
import { STAND_IN_REASONS, type SaveState } from '@sop/core';
import { Chip, type ChipProps, DropdownMenu, TextButton } from '@sop/ui';
import { useCallback, useState, useSyncExternalStore } from 'react';
import type { SaveControllerImpl } from './save-controller';
import { openSaveDialog } from './save-dialogs';
import styles from './StatusChip.module.css';

/** The chip's tooltip on a PDF that was already in the library when it opened. */
export const ALREADY_SAVED = 'Already in your library';
/** The "Save to library" chip's tooltip (R73). */
export const NOT_IN_LIBRARY = 'This PDF isn’t in your library yet. Save it to keep your notes.';
/** The tooltip of a "Not saved: …" chip, which saves when clicked. */
const SAVE_ANYWAY = 'Click to save it to your library anyway.';
/** D9: what a "Not saved: has card or bank numbers" chip adds. */
const SAVE_ANYWAY_PRIVATE = 'Its text won’t be searchable.';
/** The memory-only chip's tooltip. */
const SAVE_HINT = 'Save it to your library (Ctrl+Alt+S)';
/** The saved chip's one menu item (R73), which opens the Forget flow (R75). */
export const REMOVE_FROM_LIBRARY = 'Remove from library…';

type ChipLook = Pick<ChipProps, 'label' | 'icon' | 'tone' | 'tooltip' | 'disabled'> & { saves: boolean; menu?: boolean };

/** The chip after a save failed (R67 a): the notes are still kept in this tab and on this computer. */
export const SAVE_FAILED = 'Couldn’t save. Try again';
const SAVE_FAILED_HINT = 'Your notes are kept on this computer. Click to try again.';

/** The tooltip of the "In Trash" chip (ruling R76). */
export const IN_TRASH_HINT = 'This PDF is in your library’s Trash. Restore it to keep it and its notes.';

/** What else the chip must know besides the state. */
export interface ChipFlags {
  /** An earlier save failed (R67 a). */
  failed?: boolean;
  /** The saved PDF is in the Trash (R76 d). */
  trashed?: boolean;
  /** R67 tightened (4): a save left by a tab that closed or crashed is being finished. */
  resuming?: boolean;
  /** D9: the saved PDF has card or bank numbers, so its text is not searchable: the warning line. */
  warning?: string | null;
  /** D9: a "not learning" PDF has card or bank numbers; saving it anyway keeps its text out of search. */
  privateNumbers?: boolean;
  /** The saved chip opens its menu ("Remove from library…"). Off where there is no Forget (an upload, no rules). */
  menu?: boolean;
}

/** The chip while a save left by a tab that closed or crashed is finished (R67 tightened 4). */
export const SAVING_NOTES = 'Saving your notes…';
const SAVING_NOTES_HINT = 'Your notes from last time are being saved to your library.';

/** Fixed filter labels that say nothing to the owner on their own: the "not sure" verdict, and the stand-in's words. */
const QUIET_REASONS = new Set<string>(['not sure if this is a reading', ...STAND_IN_REASONS]);

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
  const { failed = false, trashed = false, resuming = false, warning = null, privateNumbers = false, menu = false } = flags;
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
        tooltip: warning ?? reasonsLine(savedReasons ?? []) ?? ALREADY_SAVED,
        saves: false,
        menu,
      };
    case 'unsure': {
      const why = reasonsLine(state.reasons.filter((r) => !QUIET_REASONS.has(r)).slice(0, 2));
      return {
        label: 'Save to library',
        icon: 'library_add',
        tone: 'attention',
        tooltip: why === undefined ? NOT_IN_LIBRARY : `${NOT_IN_LIBRARY} Not sure it’s for learning: ${why}.`,
        saves: true,
      };
    }
    case 'not-learning': {
      const also = reasonsLine(state.reasons.slice(1, 3));
      const hint = privateNumbers ? `${SAVE_ANYWAY} ${SAVE_ANYWAY_PRIVATE}` : SAVE_ANYWAY;
      return {
        label: `Not saved: ${state.reasons[0] ?? 'not a learning PDF'}`,
        tone: 'neutral',
        tooltip: also === undefined ? hint : `${hint} It also has: ${also}.`,
        saves: true,
      };
    }
    case 'asking':
      return { label: 'Not saved', tone: 'neutral', saves: false };
    case 'memory-only':
      return { label: 'Not saved: notes stay until you close this tab', tone: 'neutral', tooltip: SAVE_HINT, saves: true };
    case 'incognito':
      return { label: 'Incognito: view only', tone: 'neutral', disabled: true, saves: false };
  }
}

/** The tooltip shows this many reasons at most, so it stays short. */
const TOOLTIP_REASONS = 3;

/** "References section, DOI, 40 pages"; undefined for none. */
function reasonsLine(reasons: readonly string[]): string | undefined {
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
  /** Where the focus goes when the saved chip's menu was closed with the pointer (the pages). */
  returnFocus?: () => void;
}

/** A failed save or Undo is told by the App's note (SaveControllerImpl.onFailure); here it only must not go unhandled. */
const quietly = (p: Promise<void>): void => void p.catch(() => {});

export function StatusChip({ save, returnFocus }: StatusChipProps) {
  const { state, busy, failed, trashed, resuming } = useSaveView(save);
  const subscribe = useCallback((cb: () => void) => save.subscribe(cb), [save]);
  const warning = useSyncExternalStore(subscribe, () => save.saveWarning);
  const [restoring, setRestoring] = useState(false);
  if (state === null) return null;
  const look = chipFor(state, busy, save.savedReasons, {
    failed,
    trashed,
    resuming,
    warning,
    privateNumbers: save.decision?.ownerSave !== undefined,
    menu: save.hasRules,
  });
  if (look === null) return null;
  const { saves, menu, ...chip } = look;
  return (
    <div className={styles.status}>
      {menu === true && busy === null ? (
        <DropdownMenu
          trigger={<Chip {...chip} className={styles.chip} />}
          items={[{ kind: 'item', id: 'remove', label: REMOVE_FROM_LIBRARY, icon: 'delete_forever', onSelect: () => openSaveDialog('forget') }]}
          align="end"
          {...(returnFocus !== undefined ? { returnFocus } : {})}
        />
      ) : (
        <Chip {...chip} className={styles.chip} onClick={saves ? () => quietly(save.requestSave()) : undefined} />
      )}
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

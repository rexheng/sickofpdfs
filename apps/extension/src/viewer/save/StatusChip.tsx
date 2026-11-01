// The library status chip in the header (Task 30): it always shows the save decision, and clicking it saves (as
// Ctrl+Alt+S does). After a first mark saved the PDF, "Undo" stands next to it for 10 s.
import type { SaveState } from '@sop/core';
import { Chip, type ChipProps, TextButton } from '@sop/ui';
import { useCallback, useSyncExternalStore } from 'react';
import type { SaveControllerImpl } from './save-controller';
import styles from './StatusChip.module.css';

/** The chip's tooltip on a PDF that was already in the library when it opened. */
export const ALREADY_SAVED = 'Already in your library';
/** The tooltip of a "Not saved" chip, which saves when clicked. */
const SAVE_HINT = 'Save it to your library (Ctrl+Alt+S)';

type ChipLook = Pick<ChipProps, 'label' | 'icon' | 'tone' | 'tooltip' | 'disabled'> & { saves: boolean };

/** What the chip shows for a state; null for none (while the PDF is being checked). */
export function chipFor(state: SaveState, busy: SaveControllerImpl['busy'], savedReasons: readonly string[] | null): ChipLook | null {
  if (busy === 'save' && state.kind !== 'saved') return { label: 'Saving…', icon: 'library_add', tone: 'attention', saves: false };
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
export function useSaveView(save: SaveControllerImpl | null): { state: SaveState | null; busy: SaveControllerImpl['busy'] } {
  const subscribe = useCallback((cb: () => void) => save?.subscribe(cb) ?? (() => {}), [save]);
  const state = useSyncExternalStore(subscribe, () => save?.state ?? null);
  const busy = useSyncExternalStore(subscribe, () => save?.busy ?? null);
  return { state, busy };
}

export interface StatusChipProps {
  save: SaveControllerImpl;
}

/** A failed save or Undo is told by the App's note (SaveControllerImpl.onFailure); here it only must not go unhandled. */
const quietly = (p: Promise<void>): void => void p.catch(() => {});

export function StatusChip({ save }: StatusChipProps) {
  const { state, busy } = useSaveView(save);
  if (state === null) return null;
  const look = chipFor(state, busy, save.savedReasons);
  if (look === null) return null;
  const { saves, ...chip } = look;
  return (
    <div className={styles.status}>
      <Chip {...chip} className={styles.chip} onClick={saves ? () => quietly(save.requestSave()) : undefined} />
      {state.kind === 'saved' && state.undoable && (
        <TextButton label="Undo" disabled={busy === 'forget'} onClick={() => quietly(save.undo())} />
      )}
    </div>
  );
}

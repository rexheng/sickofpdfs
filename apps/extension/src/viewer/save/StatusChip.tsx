// The library status chip in the header (Task 30, worded for Phase 3's real filter by S11 and ruling R73): it always shows
// the save decision. On a saved PDF it opens a small menu with "Move to Trash" and "Forget this PDF…", the library's own
// words (TB5). After a first mark saved the PDF, "Undo" stands next to it for 10 s.
// - R95: on a "not sure" PDF it opens a menu with the banner's choices: Save to library, Never for this file, Always save from
//   <place>.
// - R96: a click on a "Not saved: …" chip asks first ("This looks like a bank statement. Save it to your library anyway?"),
//   with Cancel as the default, so a stray click never saves a private PDF. Ctrl+Alt+S still saves at once.
//
// Wording (R73: plain, for an owner who reads best in short sentences):
//   not sure      "Not sure: Save to library"                     hover: "This PDF isn't in your library yet. Save it to keep your notes."
//   a scan        "Not sure: scanned pages · Save to library"     hover: "It's a scan, but its title looks like a course reading." (R94)
//   not learning  "Not saved: looks like an invoice or receipt"   hover: one plain sentence, "Not saved because it looks like an invoice
//                                                                 or receipt: it has many money amounts and paperwork words in its
//                                                                 name." (TB5); a click asks before it saves (R96)
//   saved         "Saved to library"                              hover: one plain sentence, "Saved because it looks like a paper: it
//                                                                 has an arXiv number and a References section."
//   saved, D9     "Saved · text not searchable"                   a PDF with card, bank or ID numbers saved by the owner's choice
// "No filter yet" never shows.
import { CHOICES_UNREAD, FILTER_FAILED, FORGOTTEN_REASON, NEVER_SAVE_REASON } from '../filter/async-filter';
import { HARD_BLOCK_REASON, SCAN_TITLE_REASON, STAND_IN_REASONS, type SaveState } from '@sop/core';
import { Chip, type ChipProps, Dialog, DropdownMenu, TextButton } from '@sop/ui';
import { aboutPanel } from '../about/about-panel-state';
import { useCallback, useState, useSyncExternalStore } from 'react';
import type { ViewerUi } from '../commands';
import cards from '../ui/cards.module.css';
import { FAILED_NOTE, notSureChoices } from './NotSureBanner';
import { SAVED_BY_FIRST_MARK, SAVED_BY_FIRST_NOTE, SAVED_BY_OWNER, type SaveControllerImpl } from './save-controller';
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
/** After the chip's Move to Trash (TB5). The chip then says "In Trash" and offers Restore. */
const MOVED_TO_TRASH_NOTE = 'Moved to Trash. You can restore it for 30 days.';
/** The memory-only chip's tooltip. */
const SAVE_HINT = 'Save it to your library (Ctrl+Alt+S)';
/** The saved chip's menu (TB5): the library's own words for its two ways out. "Forget this PDF…" opens the Forget flow (R75). */
export const MOVE_TO_TRASH = 'Move to Trash';
export const FORGET_THIS_PDF = 'Forget this PDF…';

type ChipLook = Pick<ChipProps, 'label' | 'icon' | 'tone' | 'tooltip' | 'disabled'> & {
  saves: boolean;
  menu?: boolean;
  /** R95: the "not sure" chip opens the banner's choices. */
  choices?: boolean;
  /** R96: a click asks "Save it to your library anyway?" first. */
  asks?: boolean;
};

/** D9: the saved chip of a PDF whose text is kept out of search (card, bank or ID numbers), on the chip itself. */
export const SAVED_NOT_SEARCHABLE = 'Saved · text not searchable';
const NOT_SEARCHABLE_HINT = 'It has card, bank or ID numbers, so its text is not searchable.';

/** The chip after a save failed (R67 a): the notes are still kept in this tab and on this computer. */
export const SAVE_FAILED = 'Couldn’t save. Try again';
const SAVE_FAILED_HINT = 'Your notes are kept on this computer. Click to try again.';

/** The Incognito chip's tooltip. */
export const INCOGNITO_HINT = 'Incognito window: nothing is saved, so marks and notes are off.';

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
  /** D9: the saved PDF's text is not searchable (`SaveControllerImpl.notSearchable`). */
  notSearchable?: boolean;
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
  const { failed = false, trashed = false, resuming = false, warning = null, privateNumbers = false, menu = false, notSearchable = false } = flags;
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
      if (notSearchable || warning !== null) {
        return { label: SAVED_NOT_SEARCHABLE, icon: 'warning', tone: 'saved', tooltip: warning ?? NOT_SEARCHABLE_HINT, saves: false, menu };
      }
      return {
        label: 'Saved to library',
        icon: 'library_add_check',
        tone: 'saved',
        tooltip: savedSentence(savedReasons ?? []) ?? ALREADY_SAVED,
        saves: false,
        menu,
      };
    case 'unsure': {
      // R94: a scan with no text whose title looks like a reading. The hover is the reason, in one plain sentence.
      if (state.reasons.includes(SCAN_TITLE_REASON)) {
        return { label: 'Not sure: scanned pages · Save to library', icon: 'library_add', tone: 'attention', tooltip: `${SCAN_TITLE_REASON} ${NOT_IN_LIBRARY}`, saves: true, choices: menu };
      }
      const why = reasonsLine(state.reasons.filter((r) => !QUIET_REASONS.has(r)).slice(0, 2));
      return {
        // The plan's "Not sure: Save?" with R73's plain "Save to library": the filter really is not sure now, and says so.
        label: 'Not sure: Save to library',
        icon: 'library_add',
        tone: 'attention',
        tooltip: why === undefined ? NOT_IN_LIBRARY : `${NOT_IN_LIBRARY} Not sure it’s for learning: ${why}.`,
        saves: true,
        choices: menu, // R95: the banner's choices, where the owner's rules can be kept
      };
    }
    case 'not-learning':
      // TB5: an icon, as the other chips have, and the hover as one plain sentence, as the saved chip's.
      return {
        label: `Not saved: ${state.reasons[0] ?? 'not a learning PDF'}`,
        icon: 'do_not_disturb_on',
        tone: 'neutral',
        tooltip: notSavedSentence(state.reasons, privateNumbers),
        saves: true,
        asks: true,
      };
    case 'asking':
      return { label: 'Not saved', tone: 'neutral', saves: false };
    case 'memory-only':
      return { label: 'Not saved: notes stay until you close this tab', tone: 'neutral', tooltip: SAVE_HINT, saves: true, asks: true };
    case 'incognito':
      // A status, not a broken control (TB2 visual 4): full contrast, an icon, and a tooltip that says why.
      return { label: 'Incognito: view only', icon: 'visibility', tone: 'neutral', tooltip: INCOGNITO_HINT, saves: false };
  }
}

/** What else a "not saved" PDF has, in the words of "it has …" (TB5): the filter's signal labels, lower case and plain. */
const NOT_SAVED_HAS: Readonly<Record<string, string>> = {
  'Many money amounts': 'many money amounts',
  'Paperwork words in the link, file name or title': 'paperwork words in its name',
  'Order, account or customer numbers': 'order or account numbers',
  'VAT or sales tax': 'VAT or sales tax',
  'Invoice or receipt wording': 'invoice or receipt wording',
};

/**
 * The "Not saved" chip's hover (TB5): one plain sentence, as the saved chip's. "Not saved because it looks like an invoice
 * or receipt: it has many money amounts and paperwork words in its name." "Made by invoice software" is said as a fact
 * of its own. Without anything else to say: what a click does.
 */
export function notSavedSentence(reasons: readonly string[], privateNumbers = false): string {
  if (privateNumbers) return `Not saved because it has card, bank or ID numbers. ${SAVE_ANYWAY} ${SAVE_ANYWAY_PRIVATE}`;
  const [first, ...rest] = reasons;
  const madeBy = rest.includes('Made by invoice or report software');
  const has = rest
    .filter((r) => r !== 'Made by invoice or report software')
    .slice(0, 2)
    .map((r) => NOT_SAVED_HAS[r] ?? r.charAt(0).toLowerCase() + r.slice(1));
  const parts = [...(has.length > 0 ? [`it has ${andList(has)}`] : []), ...(madeBy ? ['it was made by invoice software'] : [])];
  const why = first === undefined ? 'Not saved' : first.startsWith('looks like ') ? `Not saved because it ${first}` : `Not saved: ${first}`;
  return parts.length === 0 ? `${why}. ${SAVE_ANYWAY}` : `${why}: ${parts.join(', and ')}.`;
}

/** The tooltip shows this many reasons at most, strongest first, so it stays short. */
const TOOLTIP_REASONS = 4;

/** "References section, DOI, 40 pages"; undefined for none. */
function reasonsLine(reasons: readonly string[]): string | undefined {
  return reasons.length > 0 ? reasons.slice(0, TOOLTIP_REASONS).join(', ') : undefined;
}

/** "a, b and c". */
function andList(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`;
}

/** What the filter saw, in the words of "it has …": each signal label, with the ones that say the same thing merged. */
const HAS: Readonly<Record<string, readonly string[]>> = {
  'arXiv number and References section': ['an arXiv number', 'a References section'],
  'DOI, Abstract and References section': ['a DOI', 'an abstract', 'a References section'],
  'arXiv number': ['an arXiv number'],
  'arXiv number in the file name': ['an arXiv number'],
  DOI: ['a DOI'],
  Abstract: ['an abstract'],
  'References section': ['a References section'],
  'Many citations': ['many citations'],
  Citations: ['citations'],
  'Thesis wording': ['thesis wording'],
  'Chapter, lecture or contents headings': ['chapter or lecture headings'],
  ISBN: ['an ISBN'],
  'Maths symbols': ['maths'],
  'Academic wording': ['academic wording'],
  'Slide-deck page shape': ['slide-shaped pages'],
  'Course words in the link, file name or title': ['course words in its name'],
};
/** Where it came from, in the words of "it comes from …". */
const FROM: Readonly<Record<string, string>> = {
  'Scholarly website': 'a journal website',
  'Course website': 'a course website',
  'University website': 'a university website',
};
/** Signals that mean nothing to the owner on their own (TB4 critics): left out of the sentence. */
const NOT_SAID = new Set(['Made with LaTeX']);
/** Saves the owner made, in their own words. */
const BY_OWNER: Readonly<Record<string, string>> = {
  [SAVED_BY_OWNER]: 'You saved it to your library.',
  [SAVED_BY_FIRST_MARK]: 'Your first mark saved it to your library.',
  [SAVED_BY_FIRST_NOTE]: 'Your first note saved it to your library.',
  'matches your allow list': 'Saved because you chose to always save PDFs from this place.',
  'you chose to save this file': 'Saved because you chose to save this file.',
};

/**
 * The saved chip's hover (TB4 critics): one plain sentence, such as "Saved because it looks like a paper: it has an arXiv
 * number and a References section." Repeats are merged, the labels are lower case, and labels that say nothing to the owner
 * ("Made with LaTeX") are left out. Undefined when there is nothing to say.
 */
export function savedSentence(reasons: readonly string[]): string | undefined {
  for (const r of reasons) if (BY_OWNER[r] !== undefined) return BY_OWNER[r];
  const has: string[] = [];
  const from: string[] = [];
  let pages: string | null = null;
  for (const r of reasons) {
    if (NOT_SAID.has(r)) continue;
    const place = FROM[r];
    if (place !== undefined) {
      if (!from.includes(place)) from.push(place);
      continue;
    }
    if (/^\d+ pages$/.test(r)) {
      pages = r;
      continue;
    }
    for (const h of HAS[r] ?? [r.charAt(0).toLowerCase() + r.slice(1)]) if (!has.includes(h)) has.push(h);
  }
  if (pages !== null) has.push(pages);
  // Academic wording only when there is little else to say.
  const said = has.length > 2 ? has.filter((h) => h !== 'academic wording') : has;
  const paperish = said.some((h) => /arXiv|DOI|abstract|References|citations/.test(h));
  const bookish = said.some((h) => /ISBN|chapter/.test(h));
  const kind = paperish ? 'a paper' : bookish ? 'a book' : said.includes('slide-shaped pages') ? 'slides' : said.includes('thesis wording') ? 'a thesis' : null;
  const parts: string[] = [];
  if (said.length > 0) parts.push(`it has ${andList(said.slice(0, 3))}`);
  if (from.length > 0) parts.push(`it comes from ${andList(from)}`);
  if (parts.length === 0) return undefined;
  const lead = kind === null ? 'Saved because' : `Saved because it looks like ${kind}:`;
  return `${lead} ${parts.join(', and ')}.`;
}

/** R96: the first line of "Save it to your library anyway?", from the reason the PDF is not saved. */
export function saveAnywayLine(reason: string | null, privateNumbers: boolean): string {
  if (privateNumbers || reason === HARD_BLOCK_REASON) return 'This has card, bank or ID numbers. If you save it, its text won’t be searchable.';
  if (reason === NEVER_SAVE_REASON) return 'You chose never to save this file. Saving it now changes that.';
  if (reason === FORGOTTEN_REASON) return 'You removed this PDF from your library.';
  if (reason === CHOICES_UNREAD || reason === FILTER_FAILED) return 'This PDF couldn’t be checked, so it isn’t in your library.';
  if (reason !== null && reason.startsWith('looks like ')) return `This ${reason}.`;
  return 'This doesn’t look like a learning PDF.';
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
  /** Its `showNote`: what a choice in the "not sure" menu did (R95). */
  ui?: Pick<ViewerUi, 'showNote'>;
}

/** A failed save or Undo is told by the App's note (SaveControllerImpl.onFailure); here it only must not go unhandled. */
const quietly = (p: Promise<void>): void => void p.catch(() => {});

export function StatusChip({ save, returnFocus, ui }: StatusChipProps) {
  const { state, busy, failed, trashed, resuming } = useSaveView(save);
  const subscribe = useCallback((cb: () => void) => save.subscribe(cb), [save]);
  const warning = useSyncExternalStore(subscribe, () => save.saveWarning);
  const notSearchable = useSyncExternalStore(subscribe, () => save.notSearchable);
  const [restoring, setRestoring] = useState(false);
  const [asking, setAsking] = useState(false);
  if (state === null) return null;
  const privateNumbers = save.decision?.ownerSave !== undefined;
  const look = chipFor(state, busy, save.savedReasons, {
    failed,
    trashed,
    resuming,
    warning,
    privateNumbers,
    menu: save.hasRules,
    notSearchable,
  });
  if (look === null) return null;
  const { saves, menu, choices, asks, ...chip } = look;
  const focusProps = returnFocus !== undefined ? { returnFocus } : {};
  let control;
  if (menu === true && busy === null) {
    control = (
      <DropdownMenu
        trigger={<Chip {...chip} className={styles.chip} />}
        items={[
          { kind: 'item', id: 'about', label: 'Tags and details…', icon: 'sell', onSelect: () => aboutPanel.open() }, // S18 (R92)
          { kind: 'separator' },
          // TB5: the library's words. Trash keeps it 30 days; Forget removes it for good, after asking (R75).
          { kind: 'item', id: 'trash', label: MOVE_TO_TRASH, icon: 'delete', onSelect: () => void save.moveToTrash().then(() => ui?.showNote(MOVED_TO_TRASH_NOTE), () => ui?.showNote(FAILED_NOTE)) },
          { kind: 'item', id: 'remove', label: FORGET_THIS_PDF, icon: 'delete_forever', onSelect: () => openSaveDialog('forget') },
        ]}
        align="end"
        {...focusProps}
      />
    );
  } else if (choices === true && busy === null) {
    // R95: the banner's choices, here too.
    control = (
      <DropdownMenu
        trigger={<Chip {...chip} className={styles.chip} />}
        items={notSureChoices(save).map((c) => ({
          kind: 'item' as const,
          id: c.id,
          label: c.id === 'save' ? 'Save to library' : c.label,
          icon: c.id === 'save' ? ('library_add' as const) : c.id === 'never' ? ('block' as const) : ('done_all' as const),
          onSelect: () =>
            c.run().then(
              () => ui?.showNote(c.done),
              () => ui?.showNote(FAILED_NOTE),
            ),
        }))}
        align="end"
        {...focusProps}
      />
    );
  } else {
    control = <Chip {...chip} className={styles.chip} onClick={saves ? () => (asks === true ? setAsking(true) : quietly(save.requestSave())) : undefined} />;
  }
  return (
    <div className={styles.status}>
      {control}
      {/* R96: a stray click on "Not saved" never saves a private PDF: it asks, and Cancel is the default. */}
      <Dialog
        open={asking && asks === true}
        title="Save it to your library anyway?"
        actions={[
          { label: 'Cancel', onClick: () => setAsking(false) },
          {
            label: 'Save',
            primary: true,
            onClick: () => {
              setAsking(false);
              quietly(save.requestSave());
            },
          },
        ]}
        onOpenChange={(open) => !open && setAsking(false)}
      >
        <p className={cards.body}>{saveAnywayLine(save.whyNotSaved, privateNumbers)}</p>
      </Dialog>
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

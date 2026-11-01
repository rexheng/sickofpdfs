// The comment commands: Ctrl+Alt+M comments on the selection (or makes a note at the pointer, or for the page), and
// Ctrl+Alt+Shift+M makes a note on the whole document (spec "Shortcuts").
//
// The keys follow the keyboard layout (spec: letters are matched by the character they type). Ctrl+Alt is AltGr on some
// layouts: on a German keyboard Ctrl+Alt+M types "µ". The key's base letter on this layout (navigator.keyboard's
// layout map) is matched too, so the shortcut still works there, and it never fires while you type in a box.
import { isTypingTarget } from '../shortcuts';

/** The command ids (plan section 7) and their keys, as the shortcut sheet shows them. */
export const NOTE_COMMANDS = {
  'marks.comment': { label: 'Comment', icon: 'add_comment', keys: ['Ctrl+Alt+M'] },
  'marks.documentNote': { label: 'Note on the whole document', icon: 'comment', keys: ['Ctrl+Alt+Shift+M'] },
} as const;

export type NoteCommandId = keyof typeof NOTE_COMMANDS;

/** What a command does in this tab, in the shape of commands.ts's ViewerCommand behaviour. */
export interface NoteCommandBehaviour {
  run(): void;
  enabled(): boolean;
}

/** The keyboard's layout map (physical key → the character it types without modifiers), once it is known. */
let layoutMap: ReadonlyMap<string, string> | null = null;
let layoutAsked = false;

function askLayout(): void {
  if (layoutAsked) return;
  layoutAsked = true;
  const kb = (navigator as Navigator & { keyboard?: { getLayoutMap?: () => Promise<ReadonlyMap<string, string>> } }).keyboard;
  kb?.getLayoutMap?.().then(
    (m) => {
      layoutMap = m;
    },
    () => undefined,
  );
}

const isMac = () => /mac/i.test(navigator.platform);

/** Whether `e` is Ctrl+Alt+M (Cmd+Option+M on a Mac), with Shift when `shift`. */
export function isNoteKey(e: KeyboardEvent, shift: boolean): boolean {
  const ctrl = isMac() ? e.metaKey : e.ctrlKey;
  const other = isMac() ? e.ctrlKey : e.metaKey;
  if (!ctrl || !e.altKey || other || e.shiftKey !== shift) return false;
  if (e.key.toLowerCase() === 'm') return true;
  const base = layoutMap?.get(e.code);
  if (base !== undefined) return base.toLowerCase() === 'm';
  // No layout map: an AltGr character (not a plain Latin letter) on the M key.
  return e.code === 'KeyM' && /^\p{L}$/u.test(e.key) && !/^[a-z]$/iu.test(e.key);
}

/**
 * Listens for the two keys on `target` (capture phase, so nothing in the page can swallow them) and runs the
 * behaviours. Returns the function that removes the listener.
 */
export function installNoteKeys(cmds: Record<NoteCommandId, NoteCommandBehaviour>, target: Window = window): () => void {
  askLayout();
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing || e.repeat) return;
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    if (isTypingTarget(path[0] ?? e.target)) return; // Ctrl+Alt is AltGr while you type: it types a character
    const id: NoteCommandId | null = isNoteKey(e, false) ? 'marks.comment' : isNoteKey(e, true) ? 'marks.documentNote' : null;
    if (id === null || !cmds[id].enabled()) return;
    e.preventDefault();
    e.stopPropagation();
    cmds[id].run();
  };
  target.addEventListener('keydown', onKeyDown, { capture: true });
  return () => target.removeEventListener('keydown', onKeyDown, { capture: true });
}

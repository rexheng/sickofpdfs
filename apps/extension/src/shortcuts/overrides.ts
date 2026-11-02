// The owner's own keys for the viewer's commands (spec "Shortcuts": "All are rebindable in Settings"; plan S14).
//
// Where they live:
// - The synced setting `shortcuts.overrides` (contracts §5) is the record: a JSON object from a command id to its keys, such
//   as { "marks.highlight": ["Shift+H"] }. An empty list means "no key". Backup and sync carry it like any other setting.
// - The viewer builds its commands synchronously when a PDF opens, before the library store has connected, so Settings also
//   keeps a copy in the extension's localStorage (`OVERRIDES_MIRROR_KEY`). The viewer reads that copy (`keysFor`): a new key
//   works in every PDF opened after the change. Settings refreshes the copy from the setting each time it opens, so keys
//   that arrive by restore or sync reach the viewer too.
//
// Everything here is checked again when it is read: a key that came by sync and cannot be read is dropped, never passed to
// installShortcuts (which throws on a combo it cannot parse).
import { formatCombo } from '../viewer/chrome/menus';
import type { KeyCombo } from '../viewer/shortcuts';

/** The synced setting (contracts §5). */
export const SHORTCUT_OVERRIDES_KEY = 'shortcuts.overrides';
/** The copy in the extension's localStorage that the viewer reads when it builds its commands. */
export const OVERRIDES_MIRROR_KEY = 'sop-shortcut-overrides';

/** A command id to its keys. A command that is not named keeps its own keys; an empty list means it has none. */
export type ShortcutOverrides = Readonly<Record<string, readonly KeyCombo[]>>;

/** The most keys one command can have, and the longest combo text: a runaway value is not a set of keys. */
const MAX_KEYS = 4;
const MAX_COMBO = 40;
const MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const;
/** The key names installShortcuts understands (shortcuts.ts), besides F1 to F24, physical key codes and single characters. */
const NAMED_KEYS = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Space', 'Enter', 'Escape',
  'Tab', 'Backspace', 'Delete', 'Insert', 'ContextMenu',
]);
const CODE = /^(Digit\d|Key[A-Z]|Numpad\w+)$/;
const FKEY = /^F([1-9]|1\d|2[0-4])$/;

/** The parts of a combo, as shortcuts.ts reads it ("Ctrl++" is Ctrl and "+"); null when it is not one. */
function partsOf(combo: string): { mods: string[]; key: string } | null {
  if (combo.length === 0 || combo.length > MAX_COMBO) return null;
  const plusKey = combo === '+' || combo.endsWith('++');
  const head = plusKey ? combo.slice(0, -1).replace(/\+$/, '') : combo;
  const parts = head === '' ? [] : head.split('+');
  const key = plusKey ? '+' : (parts.pop() ?? '');
  if (key === '') return null;
  const seen = new Set<string>();
  for (const m of parts) {
    if (!(MODIFIERS as readonly string[]).includes(m) || seen.has(m)) return null;
    seen.add(m);
  }
  return { mods: parts, key };
}

/** True for a combo the viewer can listen for: known modifiers, each once, and one key. */
export function isValidCombo(combo: unknown): combo is KeyCombo {
  if (typeof combo !== 'string') return false;
  const p = partsOf(combo);
  if (p === null) return false;
  const { key } = p;
  return NAMED_KEYS.has(key) || FKEY.test(key) || CODE.test(key) || [...key].length === 1;
}

/** The overrides in a stored value, with anything that cannot be read left out. `known`: the command ids that exist. */
export function cleanOverrides(value: unknown, known?: ReadonlySet<string>): Record<string, KeyCombo[]> {
  const out: Record<string, KeyCombo[]> = {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return out;
  for (const [id, keys] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[a-z]+\.[a-zA-Z]+$/.test(id) || (known !== undefined && !known.has(id))) continue;
    if (!Array.isArray(keys) || keys.length > MAX_KEYS || !keys.every(isValidCombo)) continue;
    out[id] = [...new Set(keys)];
  }
  return out;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** The overrides the viewer uses now (the localStorage copy). Never throws: no copy, or one that cannot be read, is none. */
export function readOverrides(): Record<string, KeyCombo[]> {
  try {
    const text = storage()?.getItem(OVERRIDES_MIRROR_KEY) ?? null;
    return text === null ? {} : cleanOverrides(JSON.parse(text));
  } catch {
    return {};
  }
}

/** Keeps the viewer's copy in step with the setting. An empty set removes the copy. */
export function writeOverridesMirror(o: ShortcutOverrides): void {
  try {
    const clean = cleanOverrides(o);
    if (Object.keys(clean).length === 0) storage()?.removeItem(OVERRIDES_MIRROR_KEY);
    else storage()?.setItem(OVERRIDES_MIRROR_KEY, JSON.stringify(clean));
  } catch {
    // storage refused: the viewer keeps its own keys until the copy can be written
  }
}

/** A command's keys: the owner's, when they chose some, else its own (commands.ts builds every command with this). */
export function keysFor(id: string, defaults: readonly KeyCombo[], overrides: ShortcutOverrides = readOverrides()): KeyCombo[] {
  const own = overrides[id];
  return own === undefined ? [...defaults] : [...own];
}

// ---- recording a key press ---------------------------------------------------------------------------------------------

/** What `comboFromEvent` reads from a key press. A KeyboardEvent fits. */
export interface KeyPress {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

const MODIFIER_KEYS = new Set(['Control', 'Alt', 'AltGraph', 'Shift', 'Meta', 'OS', 'CapsLock', 'NumLock', 'ScrollLock', 'Fn', 'Hyper', 'Super']);

/**
 * The combo a key press makes, written the way commands.ts writes its keys, or null while only modifiers are down (or the
 * key cannot be named). As the viewer matches them (global constraints): letters by the character they type, the number
 * row by its position when Shift or Alt is down (Alt+Shift+5), and a symbol by itself, since Shift is part of typing it ("?").
 * Ctrl is the Command key on a Mac.
 */
export function comboFromEvent(e: KeyPress, mac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)): KeyCombo | null {
  if (MODIFIER_KEYS.has(e.key) || e.key === 'Dead' || e.key === 'Unidentified' || e.key === 'Process' || e.key === '') return null;
  const ctrl = mac ? e.metaKey : e.ctrlKey;
  const meta = mac ? e.ctrlKey : e.metaKey;
  let key: string;
  let shift = e.shiftKey;
  if (/^Digit\d$/.test(e.code) && (e.shiftKey || e.altKey)) key = e.code;
  else if (e.key === ' ') key = 'Space';
  else if (NAMED_KEYS.has(e.key) || FKEY.test(e.key)) key = e.key;
  else if ([...e.key].length !== 1) return null;
  else if (/^\p{L}$/u.test(e.key)) key = e.key.toUpperCase();
  else {
    key = e.key;
    shift = false; // "?" is Shift+/ on one keyboard and a key of its own on another
  }
  const mods = [ctrl && 'Ctrl', e.altKey && 'Alt', shift && 'Shift', meta && 'Meta'].filter((m): m is string => m !== false);
  return [...mods, key].join('+');
}

// ---- checking a key before it is used -------------------------------------------------------------------------------------

/** One way of writing a combo for comparing two: "Ctrl+=" and "Ctrl++" are the same key, and so are "Ctrl+5" and "Ctrl+Digit5". */
export function comboId(combo: KeyCombo): string {
  return formatCombo(combo).toLowerCase();
}

const KEY_WORDS: Readonly<Record<string, string>> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  PageUp: 'Page Up',
  PageDown: 'Page Down',
  Escape: 'Esc',
};

/** A combo as the owner reads it: the shortcut sheet's words ("Ctrl+Plus"), with arrows and Page Up written out. */
export function shownCombo(combo: KeyCombo): string {
  const parts = formatCombo(combo).split('+');
  const key = parts.pop() ?? '';
  return [...parts, KEY_WORDS[key] ?? key].join('+');
}

export const sameCombo = (a: KeyCombo, b: KeyCombo): boolean => comboId(a) === comboId(b);

/** Keys Chrome keeps for itself: a page never hears them. */
const CHROME_KEYS = [
  'Ctrl+N', 'Ctrl+Shift+N', 'Ctrl+T', 'Ctrl+Shift+T', 'Ctrl+W', 'Ctrl+Shift+W', 'Ctrl+Tab', 'Ctrl+Shift+Tab', 'Ctrl+PageUp',
  'Ctrl+PageDown', 'Ctrl+Shift+PageUp', 'Ctrl+Shift+PageDown', 'Ctrl+F4', 'Alt+F4', 'F11', 'Ctrl+Shift+Q', 'Ctrl+Shift+J', 'Ctrl+Shift+I',
  'F12', 'Ctrl+1', 'Ctrl+2', 'Ctrl+3', 'Ctrl+4', 'Ctrl+5', 'Ctrl+6', 'Ctrl+7', 'Ctrl+8', 'Ctrl+9',
];

/** Keys the viewer keeps for reading, typing and moving round a page (they are not commands, so nothing else can have them). */
const READING_KEYS = [
  'Space', 'Shift+Space', 'PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Shift+ArrowUp',
  'Shift+ArrowDown', 'Shift+ArrowLeft', 'Shift+ArrowRight', 'Ctrl+ArrowLeft', 'Ctrl+ArrowRight', 'Ctrl+Shift+ArrowLeft',
  'Ctrl+Shift+ArrowRight', 'Ctrl+Home', 'Ctrl+End', 'Shift+Home', 'Shift+End', 'Escape', 'Tab', 'Shift+Tab', 'Enter',
  'Shift+Enter', 'Backspace', 'Delete', '1', '2', '3', '4', '5',
];

/** Keys every text box needs: copy, cut, paste and select all. */
const TEXT_KEYS = ['Ctrl+C', 'Ctrl+X', 'Ctrl+V', 'Ctrl+A'];

/** Keys of features that are not viewer commands. */
const FEATURE_KEYS: readonly { combo: KeyCombo; what: string }[] = [{ combo: 'Ctrl+K', what: 'search' }];

/** What is wrong with a key, in plain words; or what to be careful of. */
export type ComboCheck =
  | { kind: 'ok' }
  | { kind: 'refused'; message: string }
  | { kind: 'taken'; by: string; message: string }
  | { kind: 'careful'; message: string };

/** The commands as the check needs them: an id, a name, and the keys they have now. */
export interface CommandKeys {
  id: string;
  label: string;
  keys: readonly KeyCombo[];
}

/**
 * Whether `combo` can be the key of command `id`: never a key Chrome keeps, one the viewer reads with, or one another
 * command has now (the conflict check). A Ctrl+Alt letter is allowed with a warning, because on AltGr keyboards (Polish,
 * German) Ctrl+Alt types letters.
 */
export function checkCombo(combo: KeyCombo, id: string, commands: readonly CommandKeys[]): ComboCheck {
  const shown = shownCombo(combo);
  const p = partsOf(combo);
  if (p === null || !isValidCombo(combo)) return { kind: 'refused', message: 'That key can’t be used. Try another.' };
  if (CHROME_KEYS.some((c) => sameCombo(c, combo))) return { kind: 'refused', message: `Chrome keeps ${shown} for itself, so the viewer never hears it. Choose another key.` };
  if (READING_KEYS.some((c) => sameCombo(c, combo))) return { kind: 'refused', message: `The viewer uses ${shown} for reading and moving round the page. Choose another key.` };
  if (TEXT_KEYS.some((c) => sameCombo(c, combo)) && !commands.some((c) => c.id === id && c.keys.some((k) => sameCombo(k, combo)))) {
    const owner = commands.find((c) => c.id !== id && c.keys.some((k) => sameCombo(k, combo)));
    if (owner !== undefined) return { kind: 'taken', by: owner.id, message: `${shown} is already the key for ${owner.label}. Choose another key, or change ${owner.label} first.` };
    return { kind: 'refused', message: `${shown} copies, cuts, pastes or selects text. Choose another key.` };
  }
  const feature = FEATURE_KEYS.find((f) => sameCombo(f.combo, combo));
  if (feature !== undefined) return { kind: 'refused', message: `${shown} opens ${feature.what} everywhere in sickofpdfs. Choose another key.` };
  if (sameCombo(combo, 'Ctrl+U') && id !== 'marks.underline') {
    return { kind: 'refused', message: 'The viewer keeps Ctrl+U, so Chrome never shows the page’s code. Choose another key.' };
  }
  const owner = commands.find((c) => c.id !== id && c.keys.some((k) => sameCombo(k, combo)));
  if (owner !== undefined) return { kind: 'taken', by: owner.id, message: `${shown} is already the key for ${owner.label}. Choose another key, or change ${owner.label} first.` };
  if (p.mods.includes('Ctrl') && p.mods.includes('Alt') && /^\p{L}$/u.test(p.key)) {
    return {
      kind: 'careful',
      message: `On some keyboards, such as Polish or German, Ctrl+Alt works like AltGr and types a letter, so ${shown} may type a letter there instead.`,
    };
  }
  return { kind: 'ok' };
}

/** The overrides with command `id` set to `keys`; back to its own keys when `keys` equals `defaults`. */
export function withOverride(o: ShortcutOverrides, id: string, keys: readonly KeyCombo[] | null, defaults: readonly KeyCombo[]): Record<string, KeyCombo[]> {
  const next: Record<string, KeyCombo[]> = Object.fromEntries(Object.entries(o).map(([k, v]) => [k, [...v]]));
  const same = keys !== null && keys.length === defaults.length && keys.every((k, i) => sameCombo(k, defaults[i] ?? ''));
  if (keys === null || same) delete next[id];
  else next[id] = [...keys];
  return next;
}

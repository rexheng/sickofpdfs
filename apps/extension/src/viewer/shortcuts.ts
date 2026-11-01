// Keyboard shortcuts for the viewer page.
//
// Global constraints: "Single-key and Ctrl+Alt shortcuts never fire while you are typing." Letters are matched by the
// character they type (so Polish AltGr+S, which types "ś" with Ctrl and Alt down, is not Ctrl+Alt+S); only the number
// row is matched by position (`Alt+Shift+Digit5`).

/**
 * `Ctrl+=`, `Ctrl+Alt+S`, `Alt+Shift+Digit5`, `F4`, `Shift+F4`, `?`. Modifiers are Ctrl, Alt, Shift and Meta (Ctrl is
 * the Command key on a Mac). The key is a character, a key name (`ArrowDown`, `PageUp`, `Space`, `F4`, …) or a
 * physical key code (`Digit5`, `KeyS`, `Numpad0`).
 */
export type KeyCombo = string;

export interface ShortcutDef {
  id: string;
  keys: KeyCombo[];
  run(e: KeyboardEvent): void;
  /** When it returns false the shortcut is ignored and the key does what it would do anyway. */
  enabled?(): boolean;
}

interface Parsed {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  key: string;
  kind: 'code' | 'named' | 'letter' | 'symbol';
}

const MODIFIERS = new Set(['Ctrl', 'Alt', 'Shift', 'Meta']);
const NAMED_KEYS = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Space', 'Enter', 'Escape',
  'Tab', 'Backspace', 'Delete', 'Insert',
]);
const CODE = /^(Digit\d|Key[A-Z]|Numpad\w+)$/;
const NON_TEXT_INPUTS = new Set(['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit']);
const TEXT_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);

const isMac = () => typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);

const parsedCache = new Map<KeyCombo, Parsed>();

function parse(combo: KeyCombo): Parsed {
  const cached = parsedCache.get(combo);
  if (cached) return cached;
  // The key itself may be "+": "Ctrl++" is Ctrl and "+".
  const plusKey = combo === '+' || combo.endsWith('++');
  const head = plusKey ? combo.slice(0, -1).replace(/\+$/, '') : combo;
  const parts = head === '' ? [] : head.split('+');
  const key = plusKey ? '+' : (parts.pop() ?? '');
  const mods = new Set(parts);
  for (const m of mods) if (!MODIFIERS.has(m)) throw new Error(`shortcut "${combo}": unknown modifier "${m}"`);
  const kind: Parsed['kind'] = CODE.test(key)
    ? 'code'
    : NAMED_KEYS.has(key) || /^F\d{1,2}$/.test(key)
      ? 'named'
      : /^\p{L}$/u.test(key)
        ? 'letter'
        : 'symbol';
  const parsed = { ctrl: mods.has('Ctrl'), alt: mods.has('Alt'), shift: mods.has('Shift'), meta: mods.has('Meta'), key, kind };
  parsedCache.set(combo, parsed);
  return parsed;
}

/**
 * Whether `e` is `combo`. Ctrl, Alt and Meta must match exactly. Shift must match exactly for letters, key names and
 * key codes; for a symbol it is part of typing the character ("Ctrl++" is Ctrl+Shift+= on a US keyboard), so it only
 * has to be down when the combo names it.
 */
export function matchesCombo(e: KeyboardEvent, combo: KeyCombo): boolean {
  const p = parse(combo);
  const mac = isMac();
  const ctrl = Boolean(mac ? e.metaKey : e.ctrlKey);
  const meta = Boolean(mac ? e.ctrlKey : e.metaKey);
  if (ctrl !== p.ctrl || Boolean(e.altKey) !== p.alt || meta !== p.meta) return false;
  switch (p.kind) {
    case 'code':
      return e.code === p.key && Boolean(e.shiftKey) === p.shift;
    case 'named':
      return Boolean(e.shiftKey) === p.shift && (p.key === 'Space' ? e.key === ' ' : e.key === p.key);
    case 'letter':
      return Boolean(e.shiftKey) === p.shift && typeof e.key === 'string' && e.key.toLowerCase() === p.key.toLowerCase();
    case 'symbol':
      return (!p.shift || Boolean(e.shiftKey)) && e.key === p.key;
  }
}

/** A text field, text area, select, content-editable element or ARIA text control: keys there are typing. */
export function isTypingTarget(t: EventTarget | null): boolean {
  if (t === null || typeof t !== 'object') return false;
  const el = t as { tagName?: unknown; type?: unknown; isContentEditable?: unknown; getAttribute?: (name: string) => string | null };
  if (el.isContentEditable === true) return true;
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return !NON_TEXT_INPUTS.has(typeof el.type === 'string' ? el.type.toLowerCase() : 'text');
  const role = typeof el.getAttribute === 'function' ? el.getAttribute('role') : null;
  return role !== null && TEXT_ROLES.has(role);
}

/** Single keys (no Ctrl or Meta) and Ctrl+Alt combos (AltGr types characters) step aside while typing. */
function yieldsToTyping(combo: KeyCombo): boolean {
  const p = parse(combo);
  return !(p.ctrl || p.meta) || (p.ctrl && p.alt);
}

/**
 * Listens for keydown in the capture phase on `target` (default: window). The first enabled shortcut with a matching
 * combo runs, and the key's default action is prevented (so Ctrl+= zooms the pages, not the browser). Returns the
 * function that removes the listener.
 */
export function installShortcuts(defs: ShortcutDef[], target: Window = window): () => void {
  for (const def of defs) for (const combo of def.keys) parse(combo); // a typo throws now, not on the first key press
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing) return;
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    const typing = isTypingTarget(path[0] ?? e.target);
    for (const def of defs) {
      for (const combo of def.keys) {
        if (!matchesCombo(e, combo)) continue;
        if (typing && yieldsToTyping(combo)) continue;
        if (def.enabled && !def.enabled()) continue;
        e.preventDefault();
        def.run(e);
        return;
      }
    }
  };
  target.addEventListener('keydown', onKeyDown, { capture: true });
  return () => target.removeEventListener('keydown', onKeyDown, { capture: true });
}

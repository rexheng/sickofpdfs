// Spec-blind tests for the keyboard-shortcut matcher (Task 21), in a real browser because they need real KeyboardEvents.
// Spec, Shortcuts: "Single-key and Ctrl+Alt shortcuts never fire while you are typing, because on some keyboards Ctrl+Alt is AltGr.
// Letters and symbols are matched by the character they type, so shortcuts follow your keyboard layout; only the number row
// (Alt+Shift+5, 1 to 5) is matched by position. Ctrl+= and Ctrl++ both zoom in."
// Interface file: KeyCombo = 'Ctrl+=', 'Ctrl+Alt+S', 'Alt+Shift+Digit5', 'F4', 'Shift+F4', '?'; matchesCombo(e, combo);
// isTypingTarget(target); installShortcuts(defs, target = window): capture phase, preventDefault on match, returns an uninstall function;
// ShortcutDef { id, keys, run(e), enabled?() }; Task 21 registers view.zoomIn = Ctrl+=, Ctrl++; view.zoomOut = Ctrl+-; view.fitWidth = Ctrl+0.
import { afterEach, describe, expect, it } from 'vitest';
import { installShortcuts, isTypingTarget, matchesCombo, type ShortcutDef } from './shortcuts';

const key = (init: KeyboardEventInit): KeyboardEvent => new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });

describe('matchesCombo: characters by what they type, the number row by position', () => {
  // [combo, event, matches]
  const CASES: [string, KeyboardEventInit, boolean][] = [
    // zoom keys: Ctrl+= and Ctrl++ both zoom in
    ['Ctrl+=', { key: '=', code: 'Equal', ctrlKey: true }, true],
    ['Ctrl++', { key: '+', code: 'Equal', ctrlKey: true, shiftKey: true }, true],
    ['Ctrl++', { key: '+', code: 'NumpadAdd', ctrlKey: true }, true],
    ['Ctrl+=', { key: '=', code: 'Equal' }, false], // no Ctrl
    ['Ctrl+=', { key: '=', code: 'Equal', ctrlKey: true, altKey: true }, false], // an extra modifier is a different combo
    ['Ctrl+-', { key: '-', code: 'Minus', ctrlKey: true }, true],
    ['Ctrl+0', { key: '0', code: 'Digit0', ctrlKey: true }, true],
    ['Ctrl+0', { key: '0', code: 'Numpad0', ctrlKey: true }, true],
    // letters: by the character, whatever its case; modifiers must match exactly
    ['Ctrl+Alt+S', { key: 's', code: 'KeyS', ctrlKey: true, altKey: true }, true],
    ['Ctrl+Alt+S', { key: 'S', code: 'KeyS', ctrlKey: true, altKey: true }, true], // caps lock
    ['Ctrl+Alt+M', { key: 'm', code: 'KeyM', ctrlKey: true, altKey: true, shiftKey: true }, false], // that is Ctrl+Alt+Shift+M
    ['Ctrl+Alt+Shift+M', { key: 'M', code: 'KeyM', ctrlKey: true, altKey: true, shiftKey: true }, true],
    // a Dvorak or AZERTY user: the character wins, not the key's position
    ['Ctrl+Alt+S', { key: 'o', code: 'KeyS', ctrlKey: true, altKey: true }, false],
    ['Ctrl+Alt+S', { key: 's', code: 'Semicolon', ctrlKey: true, altKey: true }, true],
    // AltGr: Ctrl+Alt types a different character, so the shortcut does not fire
    ['Ctrl+Alt+M', { key: 'µ', code: 'KeyM', ctrlKey: true, altKey: true }, false],
    // the number row is matched by position, whatever it types (Alt+Shift+5 types "%" on a US keyboard, "(" on AZERTY)
    ['Alt+Shift+Digit5', { key: '%', code: 'Digit5', altKey: true, shiftKey: true }, true],
    ['Alt+Shift+Digit5', { key: '(', code: 'Digit5', altKey: true, shiftKey: true }, true],
    ['Alt+Shift+Digit5', { key: '5', code: 'Numpad5', altKey: true, shiftKey: true }, false],
    ['Alt+Shift+Digit5', { key: '%', code: 'Digit5', altKey: true }, false],
    // named keys and symbols
    ['F4', { key: 'F4', code: 'F4' }, true],
    ['F4', { key: 'F4', code: 'F4', shiftKey: true }, false],
    ['Shift+F4', { key: 'F4', code: 'F4', shiftKey: true }, true],
    ['?', { key: '?', code: 'Slash', shiftKey: true }, true], // the Shift is how "?" is typed, not a modifier of the combo
    ['?', { key: '?', code: 'Slash', ctrlKey: true, shiftKey: true }, false],
    ['H', { key: 'h', code: 'KeyH' }, true],
    ['H', { key: 'h', code: 'KeyH', ctrlKey: true }, false],
  ];

  it.each(CASES)('%s vs %j -> %s', (combo, init, expected) => {
    expect(matchesCombo(key(init), combo)).toBe(expected);
  });
});

describe('isTypingTarget', () => {
  const made: HTMLElement[] = [];
  const add = <T extends HTMLElement>(el: T): T => {
    document.body.appendChild(el);
    made.push(el);
    return el;
  };
  afterEach(() => {
    while (made.length > 0) made.pop()!.remove();
  });

  it('is true where text is typed and false elsewhere', () => {
    const text = add(document.createElement('input'));
    const area = add(document.createElement('textarea'));
    const editable = add(document.createElement('div'));
    editable.contentEditable = 'true';
    editable.tabIndex = 0;
    const button = add(document.createElement('button'));
    const plain = add(document.createElement('div'));
    expect(isTypingTarget(text)).toBe(true);
    expect(isTypingTarget(area)).toBe(true);
    expect(isTypingTarget(editable)).toBe(true);
    expect(isTypingTarget(button)).toBe(false);
    expect(isTypingTarget(plain)).toBe(false);
    expect(isTypingTarget(document.body)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(window)).toBe(false);
  });
});

describe('installShortcuts', () => {
  const uninstallers: (() => void)[] = [];
  afterEach(() => {
    while (uninstallers.length > 0) uninstallers.pop()!();
  });
  const install = (defs: ShortcutDef[]) => {
    const off = installShortcuts(defs);
    uninstallers.push(off);
    return off;
  };

  it('runs the matching shortcut in the capture phase, before the page sees the key, and stops the browser\'s own zoom', () => {
    const seen: string[] = [];
    install([{ id: 'view.zoomIn', keys: ['Ctrl+=', 'Ctrl++'], run: () => seen.push('zoomIn') }]);
    const child = document.createElement('div');
    document.body.appendChild(child);
    for (const init of [{ key: '=', code: 'Equal', ctrlKey: true }, { key: '+', code: 'Equal', ctrlKey: true, shiftKey: true }]) {
      const e = key(init);
      child.dispatchEvent(e);
      expect(e.defaultPrevented, `${init.key} is handled, so Chrome's page zoom must not also run`).toBe(true);
    }
    expect(seen).toEqual(['zoomIn', 'zoomIn']);
    child.remove();
  });

  it('leaves keys that match nothing alone', () => {
    const seen: string[] = [];
    install([{ id: 'view.zoomOut', keys: ['Ctrl+-'], run: () => seen.push('out') }]);
    const e = key({ key: 'a', code: 'KeyA' });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(seen).toEqual([]);
  });

  it('a shortcut that is not enabled does not run and does not swallow the key', () => {
    let on = false;
    const seen: string[] = [];
    install([{ id: 'x', keys: ['Ctrl+0'], run: () => seen.push('x'), enabled: () => on }]);
    const off = key({ key: '0', code: 'Digit0', ctrlKey: true });
    window.dispatchEvent(off);
    expect(off.defaultPrevented).toBe(false);
    on = true;
    const yes = key({ key: '0', code: 'Digit0', ctrlKey: true });
    window.dispatchEvent(yes);
    expect(yes.defaultPrevented).toBe(true);
    expect(seen).toEqual(['x']);
  });

  it('single-key and Ctrl+Alt shortcuts do not fire while a person is typing in a field', () => {
    const seen: string[] = [];
    install([
      { id: 'mark.highlight', keys: ['H'], run: () => seen.push('H') },
      { id: 'comment.new', keys: ['Ctrl+Alt+M'], run: () => seen.push('comment') },
    ]);
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    const h = key({ key: 'h', code: 'KeyH' });
    input.dispatchEvent(h);
    const m = key({ key: 'm', code: 'KeyM', ctrlKey: true, altKey: true });
    input.dispatchEvent(m);
    expect(seen, 'typing an "h", or an AltGr combination, in a box is typing').toEqual([]);
    expect(h.defaultPrevented).toBe(false);
    expect(m.defaultPrevented).toBe(false);
    // the same keys with the reading area focused do fire
    document.body.focus();
    window.dispatchEvent(key({ key: 'h', code: 'KeyH' }));
    expect(seen).toEqual(['H']);
    input.remove();
  });

  it('the uninstall function removes every handler', () => {
    const seen: string[] = [];
    const off = install([{ id: 'x', keys: ['Ctrl+0'], run: () => seen.push('x') }]);
    off();
    const e = key({ key: '0', code: 'Digit0', ctrlKey: true });
    window.dispatchEvent(e);
    expect(seen).toEqual([]);
    expect(e.defaultPrevented).toBe(false);
  });
});

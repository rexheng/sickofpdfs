// Spec-blind unit tests for the collapsed jump history (Task 24). Written from the spec and the interface file only.
// Spec: "Jumps inside a document (links, search results, next note) are kept in the page's history state and collapsed, so Back returns to
// where you were without needing many presses to leave."
// Interface file: createJumpHistory(win, restore, go) -> JumpHistory { jumpTo(target, from), dispose() }. "before the first jump,
// replaceState({ sopBase: from }), then pushState({ sopJump: true }); later jumps call replaceState({ sopJump: true }); popstate to a
// sopBase state calls restore."
//
// The window is a small fake with a real history stack (entries, a current index, Back that fires popstate), so what the tests check is
// where the entries and states end up, not which calls were made in which order.
import { describe, expect, it } from 'vitest';
import type { LinkTarget } from '../backend/types';
import type { ViewPosition } from '../contracts';
import { createJumpHistory } from './jump-history';

type PageTarget = LinkTarget & { kind: 'page' };

interface PopEvent {
  state: unknown;
}

/** A window with a history stack. `back()` moves one entry back and fires popstate with that entry's state, as a browser does. */
function fakeWindow() {
  const entries: unknown[] = [null];
  let at = 0;
  const listeners = new Set<(e: PopEvent) => void>();
  const history = {
    get state() {
      return entries[at];
    },
    get length() {
      return entries.length;
    },
    replaceState(state: unknown) {
      entries[at] = state;
    },
    pushState(state: unknown) {
      entries.splice(at + 1); // a new entry drops the entries ahead
      entries.push(state);
      at++;
    },
  };
  const win = {
    history,
    addEventListener(type: string, fn: (e: PopEvent) => void) {
      if (type === 'popstate') listeners.add(fn);
    },
    removeEventListener(type: string, fn: (e: PopEvent) => void) {
      if (type === 'popstate') listeners.delete(fn);
    },
  };
  const fire = (state: unknown) => {
    for (const fn of [...listeners]) fn({ state });
  };
  return {
    win: win as unknown as Pick<Window, 'history' | 'addEventListener' | 'removeEventListener'>,
    entries,
    at: () => at,
    listeners: () => listeners.size,
    back() {
      if (at === 0) throw new Error('nothing to go back to');
      at--;
      fire(entries[at]);
    },
    /** A popstate for a state the jump history did not write (the page's own address updates, another library). */
    fire,
  };
}

function setup() {
  const w = fakeWindow();
  const restored: ViewPosition[] = [];
  const went: PageTarget[] = [];
  const jumps = createJumpHistory(
    w.win,
    (p) => restored.push(p),
    (t) => went.push(t),
  );
  return { ...w, jumps, restored, went };
}

const at = (pageIndex: number, offset: number, scale = 1): ViewPosition => ({ pageIndex, offset, scale });
const to = (pageIndex: number, top: number | null = null): PageTarget => ({ kind: 'page', pageIndex, top, left: null });

describe('the first jump', () => {
  it('records where the reader was on the current entry, adds exactly one entry for the jump, and goes to the target', () => {
    const s = setup();
    const from = at(0, 0.4, 1.25);
    s.jumps.jumpTo(to(6, 500), from);
    expect(s.entries, 'the entry the reader left holds the place; the new entry is marked as a jump').toEqual([{ sopBase: from }, { sopJump: true }]);
    expect(s.at(), 'the reader is on the new entry').toBe(1);
    expect(s.went, 'the viewer is told to go to the target').toEqual([to(6, 500)]);
    expect(s.restored, 'nothing is restored by jumping').toEqual([]);
  });
});

describe('a chain of jumps', () => {
  it('shares the one entry: later jumps change its marker, never add entries, and the recorded place stays the very first one', () => {
    const s = setup();
    const first = at(0, 0.4, 1.25);
    s.jumps.jumpTo(to(3, 300), first);
    s.jumps.jumpTo(to(6, 100), at(3, 0.2, 1.25));
    s.jumps.jumpTo(to(1, 50), at(6, 0.9, 1.5));
    expect(s.entries.length, 'three jumps, two entries').toBe(2);
    expect(s.entries[0], 'the base is still where the reader was before the FIRST jump').toEqual({ sopBase: first });
    expect(s.entries[1]).toEqual({ sopJump: true });
    expect(s.went.map((t) => t.pageIndex)).toEqual([3, 6, 1]);
  });

  it('one Back after any number of jumps restores the place before the first one, once', () => {
    const s = setup();
    const first = at(2, 0.55, 0.9);
    s.jumps.jumpTo(to(3), first);
    s.jumps.jumpTo(to(6), at(3, 0.1, 0.9));
    s.jumps.jumpTo(to(1), at(6, 0.7, 0.9));
    s.back();
    expect(s.restored, 'restore is called once with the place before the first jump').toEqual([first]);
    expect(s.at(), 'and the reader is on the base entry').toBe(0);
  });
});

describe('Back, then jumping again', () => {
  it('starts a new chain: the base entry is kept as it is (not overwritten by the jump marker) and Back works a second time', () => {
    const s = setup();
    const first = at(0, 0.4, 1);
    s.jumps.jumpTo(to(3), first);
    s.back();
    expect(s.restored).toEqual([first]);

    const again = at(0, 0.4, 1); // the reader is where Back put them
    s.jumps.jumpTo(to(6), again);
    expect(s.entries, 'a base entry and one jump entry again; the base has not been turned into a jump entry').toEqual([{ sopBase: again }, { sopJump: true }]);
    s.back();
    expect(s.restored, 'the second Back restores too').toEqual([first, again]);
  });
});

describe('popstate for anything else', () => {
  it.each([
    ['no state at all (an entry the viewer never touched)', null],
    ['a state of some other writer', { somethingElse: 1 }],
    ['the jump entry itself (going Forward again)', { sopJump: true }],
  ])('%s restores nothing', (_name, state) => {
    const s = setup();
    s.jumps.jumpTo(to(3), at(0, 0.1));
    s.fire(state);
    expect(s.restored).toEqual([]);
  });
});

describe('dispose', () => {
  it('stops listening: a Back afterwards restores nothing and no listener is left on the window', () => {
    const s = setup();
    s.jumps.jumpTo(to(3), at(0, 0.1));
    expect(s.listeners(), 'it listens for popstate once there is something to come back to').toBeGreaterThan(0);
    s.jumps.dispose();
    expect(s.listeners(), 'no listener left behind').toBe(0);
    s.back();
    expect(s.restored).toEqual([]);
  });
});

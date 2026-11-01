// Spec-blind tests for the draft keeper's page events (slice S8), in a real browser page.
//
// Sources:
//   plan Phase 2, S8 and contracts section 3: "A draft is saved within 300 ms of the last keystroke, and at once on blur,
//     Esc, `visibilitychange` (hidden) and `pagehide`."
//   plan Phase 2, done-when 5: "Closing the tab mid-draft gives the same result" (the draft is back on reopen).
// Blur and Esc are the note box's events; it calls DraftKeeper.flush() (tested in drafts.spec-blind.test.ts). The two page
// events cannot be waited for by a page that is closing, so the keeper has to listen for them itself.
// No timer is advanced anywhere in this file: if the text is in the store, it was written by the event.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { T_A, draftRow, textAnchor, threadRow } from '../../store/rows.spec-blind';
import { createDraftKeeper, type DraftKeeper } from './drafts';
import { FakeStore, PresenceHub } from './fakes.spec-blind';

let store: FakeStore;
let keeper: DraftKeeper;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  store = new FakeStore();
  keeper = createDraftKeeper({ store: store as never, presence: new PresenceHub().join(T_A), memoryOnly: () => false });
  keeper.change(draftRow({ id: 'd1', threadId: 'dt1', body: 'typed a moment ago', draftOfTab: T_A }), threadRow({ id: 'dt1', draftOfTab: T_A, anchor: textAnchor(0, 4, 30) }));
});
afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(document, 'visibilityState');
});
const hidden = () => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
};
const microtasks = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('the page is going away', () => {
  it('pagehide saves the draft now, not 300 ms later', async () => {
    expect(store.count('saveDraft')).toBe(0);
    window.dispatchEvent(new Event('pagehide'));
    await microtasks();
    expect(store.comments.get('d1')?.body).toBe('typed a moment ago');
    expect(store.draftThread('dt1' as never)?.draftOfTab).toBe(T_A);
  });

  it('the tab going to the background (visibilitychange to hidden) saves the draft now', async () => {
    hidden();
    await microtasks();
    expect(store.comments.get('d1')?.body).toBe('typed a moment ago');
  });

  it('coming back to the tab does not lose or change the text', async () => {
    hidden();
    await microtasks();
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.comments.get('d1')?.body).toBe('typed a moment ago');
  });
});

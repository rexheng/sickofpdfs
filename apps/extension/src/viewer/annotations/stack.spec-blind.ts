// Test support only: one viewer tab on the REAL store (SQLite in memory), the real draft keeper and the real session. The only
// fakes are the clock, the tab roll call (PresenceHub answers at once, so timers can be fake) and the save decision.
// Needs fake timers and stubbed page globals: call `Stack.install()` in beforeEach and `Stack.uninstall()` in afterEach.
import { vi } from 'vitest';
import type { TabId } from '../../../../../packages/core/src/ids';
import type { StoreEnv } from '../../store/env.spec-blind';
import { createDraftKeeper } from './drafts';
import { DOC, FakeSave, PresenceHub, anchorContext, makeTextAnchor, type SaveStateLike } from './fakes.spec-blind';
import type { StoreChange } from './boundary';
import { createAnnotationSession } from './session';

/** A change bus like BroadcastChannel: every listener gets every event, a moment later. */
export class Bus {
  private listeners = new Set<(c: StoreChange) => void>();
  emit = (c: StoreChange) => void Promise.resolve().then(() => this.listeners.forEach((cb) => cb(c)));
  on = (cb: (c: StoreChange) => void) => (this.listeners.add(cb), () => this.listeners.delete(cb));
}

export function connect(env: StoreEnv, bus: Bus) {
  env.publish.mockImplementation(bus.emit);
  return new Proxy(env.api, {
    get(target, key) {
      if (key === 'onChange') return bus.on;
      if (key === 'close') return () => undefined;
      const v = Reflect.get(target, key) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

/** Moves fake time forward in a few steps and lets every promise and event run. */
export const pump = async (ms = 0): Promise<void> => {
  for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(ms / 3);
  await vi.advanceTimersByTimeAsync(0);
};

export class Stack {
  readonly hub = new PresenceHub();
  readonly bus = new Bus();
  readonly clock = { t: 1_700_000_000_000 };

  static install(): Stack {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    // The keeper listens for page events when it is made; Node has no page. These do nothing (real ones: the browser test).
    const target = new EventTarget();
    vi.stubGlobal('window', target);
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
    vi.stubGlobal('addEventListener', target.addEventListener.bind(target));
    vi.stubGlobal('removeEventListener', target.removeEventListener.bind(target));
    return new Stack();
  }
  static uninstall(): void {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }

  /** One viewer tab on `env`. */
  openTab(env: StoreEnv, tab: TabId, saveState: SaveStateLike = { kind: 'saved', documentId: DOC, undoable: false }) {
    const store = connect(env, this.bus);
    const presence = this.hub.join(tab);
    const save = new FakeSave(saveState);
    const keeper = createDraftKeeper({ store: store, presence, memoryOnly: () => save.state.kind !== 'saved' });
    const session = createAnnotationSession({
      store: store as never, save: save, anchors: anchorContext(), drafts: keeper, presence,
      makeTextAnchor, documentId: () => save.documentId(), incognito: false, now: () => ++this.clock.t,
    });
    return { tab, session, keeper, save, presence };
  }
}
export type Tab = ReturnType<Stack['openTab']>;

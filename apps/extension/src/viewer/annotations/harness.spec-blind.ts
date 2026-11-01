// Test support only (spec-blind tests for the annotation session, slice S9): one tab wired to the fakes in fakes.spec-blind.ts.
import type { TabId } from '../../../../../packages/core/src/ids';
import { DOC, FakeKeeper, FakeSave, FakeStore, PresenceHub, T_A, anchorContext, slowTextAnchor, type SaveStateLike } from './fakes.spec-blind';
import { createAnnotationSession, type AnnotationSession } from './session';

export * from './fakes.spec-blind';

/** Everything one tab needs, wired to fakes. Pass `shared` to put a second tab on the same store. */
export interface Rig {
  session: AnnotationSession;
  store: FakeStore;
  save: FakeSave;
  keeper: FakeKeeper;
  presence: ReturnType<PresenceHub['join']>;
  hub: PresenceHub;
  tab: TabId;
  clock: { t: number };
  reads: Reads;
}
/** How often this tab read the store's notes (a tab's own echo must not make it read again). */
export interface Reads {
  listAnnotations: number;
}
export function rig(o: { save?: SaveStateLike; incognito?: boolean; noStore?: boolean; tab?: TabId; shared?: Pick<Rig, 'store' | 'hub' | 'clock'>; saveNull?: boolean } = {}): Rig {
  const store = o.shared?.store ?? new FakeStore();
  const hub = o.shared?.hub ?? new PresenceHub();
  const clock = o.shared?.clock ?? { t: 1_700_000_000_000 };
  const tab = o.tab ?? T_A;
  const presence = hub.join(tab);
  const save = new FakeSave(o.save ?? { kind: 'saved', documentId: DOC, undoable: false });
  save.onForget = () => store.forgetAll();
  const keeper = new FakeKeeper(o.noStore || o.incognito ? null : store, presence);
  const reads: Reads = { listAnnotations: 0 };
  // This tab's own view of the shared store: the same data, but it counts this tab's reads.
  const view = new Proxy(store, {
    get(target, key) {
      const v = Reflect.get(target, key) as unknown;
      if (key === 'listAnnotations') return (...a: Parameters<FakeStore['listAnnotations']>) => (reads.listAnnotations++, target.listAnnotations(...a));
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  const session = createAnnotationSession({
    store: o.noStore || o.incognito ? null : (view),
    save: o.saveNull ? null : (save),
    anchors: anchorContext(),
    drafts: keeper,
    presence,
    makeTextAnchor: slowTextAnchor,
    documentId: () => save.documentId(),
    incognito: o.incognito ?? false,
    now: () => ++clock.t,
  });
  // The keeper must follow the save decision the way the real one follows memoryOnly().
  // (Drafts of a paper that is not saved yet, or whose save question is open, stay in memory too: there is no document row to hang them on.)
  keeper.memoryOnly = save.state.kind !== 'saved';
  save.subscribe((s) => (keeper.memoryOnly = s.kind !== 'saved'));
  return { session, store, save, keeper, presence, hub, tab, clock, reads };
}


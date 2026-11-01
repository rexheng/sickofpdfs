// Spec-blind tests for tab presence (slice S8): the roll call between viewer tabs on BroadcastChannel 'sop-tabs'.
//
// Sources:
//   plan Phase 2, S8: "Live tabs answer a roll call on `sop-tabs` within 200 ms. A tab adopts the drafts of tabs that are gone."
//   contracts section 3: "A tab adopts drafts whose owner tab is gone. Live tabs answer a roll call on BroadcastChannel
//     `sop-tabs` within 200 ms."; TabId is "random per viewer page load; owns drafts".
//   plan Phase 2 contract additions: TABS_CHANNEL = 'sop-tabs'; TabPresence { tabId; liveTabs(timeoutMs = 200): Promise<TabId[]>; close() };
//     createTabPresence(). "P4 uses it to mark interrupted replies."
// The wire format of the roll call is not specified, so these tests only use real instances of createTabPresence talking
// to each other over the real BroadcastChannel (Node has one), and one raw listener to pin the channel name.
// Whether liveTabs() lists the asking tab itself is left open: the tests ignore the asker's own id.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TABS_CHANNEL, createTabPresence, type TabPresence } from './tab-presence';

const open: TabPresence[] = [];
const tab = () => {
  const p = createTabPresence();
  open.push(p);
  return p;
};
afterEach(() => {
  for (const p of open.splice(0)) p.close();
});
const others = (ids: string[], me: TabPresence) => ids.filter((id) => id !== me.tabId).sort();
const timed = async <T>(p: Promise<T>): Promise<{ value: T; ms: number }> => {
  const t0 = performance.now();
  const value = await p;
  return { value, ms: performance.now() - t0 };
};

describe('tab presence', () => {
  it('uses the channel the contract names', () => {
    expect(TABS_CHANNEL).toBe('sop-tabs');
  });

  it('gives every tab its own random id, per page load', () => {
    const ids = [tab(), tab(), tab()].map((p) => p.tabId);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id).toMatch(/\S/);
  });

  it('a roll call lists every other live tab, within the 200 ms the contract allows', async () => {
    const [a, b, c] = [tab(), tab(), tab()];
    await a.liveTabs(60); // the first call in a Node process can spend up to 200 ms starting its channel machinery; warm it up, then measure
    const { value, ms } = await timed(a.liveTabs());
    expect(others(value, a)).toEqual([b.tabId, c.tabId].sort());
    expect(ms).toBeLessThan(400); // 200 ms by contract, plus slack for a loaded machine
  });

  it('a tab that closed is not live any more, and the others stay listed', async () => {
    const [a, b, c] = [tab(), tab(), tab()];
    await a.liveTabs(60); // warm up the channel first
    expect(others(await a.liveTabs(), a)).toEqual([b.tabId, c.tabId].sort());
    b.close();
    expect(others(await a.liveTabs(), a)).toEqual([c.tabId]);
    expect(others(await c.liveTabs(), c)).toEqual([a.tabId]);
  });

  it('with nobody else open the call still ends on time, with nobody else in it', async () => {
    const a = tab();
    const { value, ms } = await timed(a.liveTabs());
    expect(others(value, a)).toEqual([]);
    expect(ms).toBeLessThan(500);
  });

  it('takes the wait from its argument', async () => {
    const a = tab();
    tab();
    const { ms } = await timed(a.liveTabs(30));
    expect(ms).toBeLessThan(150);
  });

  it('a tab that opens later is found by the next roll call', async () => {
    const a = tab();
    expect(others(await a.liveTabs(60), a)).toEqual([]);
    const late = tab();
    expect(others(await a.liveTabs(60), a)).toEqual([late.tabId]);
  });

  it('runs the roll call on the sop-tabs channel', async () => {
    const a = tab();
    tab();
    const heard: unknown[] = [];
    const raw = new BroadcastChannel(TABS_CHANNEL);
    raw.onmessage = (e) => heard.push(e.data);
    await a.liveTabs(60);
    raw.close();
    expect(heard.length).toBeGreaterThan(0);
  });

  it('a tab that was killed (it never said goodbye) is not live: it can no longer answer', async () => {
    // A killed renderer cannot answer or send anything. This simulates it by making that tab's channels mute.
    const channels: (BroadcastChannel & { mute?: boolean })[] = [];
    const Real = globalThis.BroadcastChannel;
    class Killable extends Real {
      mute = false;
      constructor(name: string) {
        super(name);
        channels.push(this);
      }
      override postMessage(m: unknown): void {
        if (!this.mute) super.postMessage(m);
      }
    }
    vi.stubGlobal('BroadcastChannel', Killable);
    let victim: TabPresence;
    let mine: ReturnType<typeof channels.slice>;
    try {
      victim = tab();
      mine = channels.slice();
    } finally {
      vi.stubGlobal('BroadcastChannel', Real);
    }
    const survivor = tab();
    expect(others(await survivor.liveTabs(), survivor)).toContain(victim.tabId);

    for (const c of mine) c.mute = true;
    expect(others(await survivor.liveTabs(), survivor)).not.toContain(victim.tabId);
  });
});

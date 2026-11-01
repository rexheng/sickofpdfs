// Spec-blind table tests for CL2's clampHlc(stamp, now, maxSkewMs = 300000).
//
// Sources: contracts §7 ("Hlc.receive runs on every pulled stamp. The server clamps stamps more than 5 minutes ahead");
// research 05 §3.4 ("The server clamps HLCs more than 5 min in the future to server time"); spec "Sync rules" (a hybrid
// clock, not the computer's wall clock, which can be wrong); the interface file (the default is 300,000 ms).
//
// What "clamped" means here: the result is a well-formed stamp, it is not ahead of server time by more than the allowed
// skew and not behind server time, it keeps the writer's device, and clamping it again changes nothing. A stamp that is
// not more than the skew ahead comes back unchanged, character for character.
import { describe, expect, it } from 'vitest';
import { MIN, NOW, SKEW_DEFAULT, STAMP_RE, clampHlc, deviceOf, msOf, stamp } from '../../test/spec-blind/sync-kit';

const DAY = 86_400_000;

describe('clampHlc', () => {
  it.each([
    { name: 'an hour in the past', ms: NOW - 60 * MIN, skew: undefined, clamped: false },
    { name: 'exactly server time', ms: NOW, skew: undefined, clamped: false },
    { name: '4 min 59 s ahead', ms: NOW + 299_000, skew: undefined, clamped: false },
    { name: 'exactly 5 minutes ahead', ms: NOW + SKEW_DEFAULT, skew: undefined, clamped: false },
    { name: '1 ms more than 5 minutes ahead', ms: NOW + SKEW_DEFAULT + 1, skew: undefined, clamped: true },
    { name: 'an hour ahead', ms: NOW + 60 * MIN, skew: undefined, clamped: true },
    { name: 'a year ahead (a dead clock battery)', ms: NOW + 365 * DAY, skew: undefined, clamped: true },
    { name: '1 s ahead with a 1 s skew', ms: NOW + 1_000, skew: 1_000, clamped: false },
    { name: '1,001 ms ahead with a 1 s skew', ms: NOW + 1_001, skew: 1_000, clamped: true },
    { name: '1 ms ahead with no skew allowed', ms: NOW + 1, skew: 0, clamped: true },
  ])('a stamp $name', ({ ms, skew, clamped }) => {
    const s = stamp(ms, 0x002a, 'devLaptop');
    const out = skew === undefined ? clampHlc(s, NOW) : clampHlc(s, NOW, skew);
    if (!clamped) {
      expect(out).toBe(s);
      return;
    }
    const allowed = skew ?? SKEW_DEFAULT;
    expect(out).toMatch(STAMP_RE);
    expect(msOf(out)).toBeGreaterThanOrEqual(NOW);
    expect(msOf(out)).toBeLessThanOrEqual(NOW + allowed);
    expect(deviceOf(out)).toBe('devLaptop');
    expect(skew === undefined ? clampHlc(out, NOW) : clampHlc(out, NOW, skew)).toBe(out);
  });
});

// Hybrid-clock stamps as the server sees them: parsed defensively, compared totally, and pulled back to server time when a
// device's clock runs far ahead. A stamp is `${ms padded to 13}-${counter in hex padded to 4}-${deviceId}` (Phase 1, Task 28).
// A stamp that does not parse is untrusted input: nothing here throws on it.

import type { HlcStamp } from '../hlc';
import { MAX_HLC_SKEW_MS } from './protocol';

export interface ParsedHlc {
  ms: number;
  counter: number;
  device: string;
}

const STAMP = /^(\d{13})-([0-9a-f]{4})-(.{1,128})$/;

export function parseHlc(stamp: unknown): ParsedHlc | null {
  if (typeof stamp !== 'string') return null;
  const m = STAMP.exec(stamp);
  if (!m) return null;
  return { ms: Number(m[1]), counter: parseInt(m[2] ?? '0', 16), device: m[3] ?? '' };
}

export function formatHlc(p: ParsedHlc): HlcStamp {
  const ms = Math.min(Math.max(0, Math.floor(p.ms)), 9_999_999_999_999);
  const counter = Math.min(Math.max(0, Math.floor(p.counter)), 0xffff);
  return `${ms.toString().padStart(13, '0')}-${counter.toString(16).padStart(4, '0')}-${p.device}`;
}

/**
 * A total order on stamps: time, then counter, then device id. A stamp that does not parse sorts below every stamp that
 * does (two of them compare as plain strings), so garbage can never win a conflict.
 */
export function compareStamps(a: string, b: string): -1 | 0 | 1 {
  const pa = parseHlc(a);
  const pb = parseHlc(b);
  if (!pa || !pb) {
    if (pa) return 1;
    if (pb) return -1;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (pa.ms !== pb.ms) return pa.ms < pb.ms ? -1 : 1;
  if (pa.counter !== pb.counter) return pa.counter < pb.counter ? -1 : 1;
  return pa.device < pb.device ? -1 : pa.device > pb.device ? 1 : 0;
}

/** The later of two stamps (the first when they are equal). */
export function maxStamp(a: string, b: string): string {
  return compareStamps(b, a) > 0 ? b : a;
}

/**
 * The server clamps a stamp that is more than `maxSkewMs` (5 minutes) ahead of its own clock to the server time. The counter
 * and device id stay, so two stamps from one device keep their order whenever their times differ by less than the skew; a
 * device whose clock is further ahead than that loses ordering among its own far-future stamps, which only matters for
 * concurrent edits. Without this a device with a wrong clock would win every conflict for ever, and every other device
 * would copy its far-future time through `Hlc.receive`.
 *
 * A stamp that does not parse is replaced by one at server time with the device `unknown`.
 */
export function clampHlc(stamp: HlcStamp, now: number, maxSkewMs: number = MAX_HLC_SKEW_MS): HlcStamp {
  const p = parseHlc(stamp);
  if (!p) return formatHlc({ ms: now, counter: 0, device: 'unknown' });
  if (p.ms - now > maxSkewMs) return formatHlc({ ...p, ms: now });
  return stamp;
}

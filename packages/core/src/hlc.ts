/**
 * A hybrid logical clock stamp: `${ms padded to 13}-${counter in lower-case hex padded to 4}-${deviceId}`.
 * Stamps from one clock only ever go up, even when the wall clock stops or steps back, so "last writer wins" in sync
 * can trust them. Order them with `compareHlc`.
 */
export type HlcStamp = string;

/** The largest counter the 4 hex digits hold. Past it, the clock moves on by one millisecond. */
const MAX_COUNTER = 0xffff;

const STAMP = /^(\d{13,})-([0-9a-f]{4,})-(.*)$/s;

interface Parts {
  ms: number;
  counter: number;
  device: string;
}

function parse(stamp: HlcStamp): Parts | null {
  const m = STAMP.exec(stamp);
  if (!m) return null;
  const ms = Number(m[1]);
  const counter = parseInt(m[2], 16);
  if (!Number.isSafeInteger(ms) || !Number.isSafeInteger(counter)) return null;
  return { ms, counter, device: m[3] };
}

function format(ms: number, counter: number, device: string): HlcStamp {
  return `${ms.toString().padStart(13, '0')}-${counter.toString(16).padStart(4, '0')}-${device}`;
}

/** One device's clock. Make one per store, and stamp every synced write with `tick()`. */
export class Hlc {
  private last = 0;
  private counter = 0;
  private readonly deviceId: string;
  private readonly now: () => number;

  constructor(deviceId: string, now: () => number = Date.now) {
    if (typeof deviceId !== 'string' || deviceId.length === 0) throw new Error('Hlc: a device id is needed');
    this.deviceId = deviceId;
    this.now = now;
  }

  /** A new stamp, later than every stamp this clock has made or received. */
  tick(): HlcStamp {
    const wall = Math.floor(this.now());
    if (wall > this.last) {
      this.last = wall;
      this.counter = 0;
    } else {
      this.bump();
    }
    return format(this.last, this.counter, this.deviceId);
  }

  /**
   * Takes in a stamp made elsewhere (another device, or this one before a restart) and returns a new stamp later than
   * both it and everything this clock made. A stamp that cannot be read is ignored, and a plain `tick()` is returned.
   */
  receive(remote: HlcStamp): HlcStamp {
    const r = parse(remote);
    if (!r) return this.tick();
    const wall = Math.floor(this.now());
    const top = Math.max(wall, this.last, r.ms);
    if (top === this.last && top === r.ms) {
      this.counter = Math.max(this.counter, r.counter);
      this.bump();
    } else if (top === this.last) {
      this.bump();
    } else if (top === r.ms) {
      this.last = r.ms;
      this.counter = r.counter;
      this.bump();
    } else {
      this.last = wall;
      this.counter = 0;
    }
    return format(this.last, this.counter, this.deviceId);
  }

  private bump(): void {
    if (this.counter < MAX_COUNTER) {
      this.counter += 1;
    } else {
      // The counter is full: borrow the next millisecond, so stamps keep going up and keep their width.
      this.last += 1;
      this.counter = 0;
    }
  }
}

/**
 * Orders two stamps: by time, then counter, then device id. Returns -1, 0 or 1.
 *
 * This is the order the cloud sync merge uses (Phase 5). For well-formed stamps (13 digits, `-`, 4 lower-case hex digits,
 * `-`, device id) it is exactly a plain string comparison of the three parts in that order, because both numbers are
 * padded to a fixed width and `Hlc` writes the counter in lower case. A stamp that cannot be read (an upper-case counter
 * included) sorts before every stamp that can, and two unreadable stamps compare as plain strings.
 */
export function compareHlc(a: HlcStamp, b: HlcStamp): number {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) {
    if (pa) return 1;
    if (pb) return -1;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (pa.ms !== pb.ms) return pa.ms < pb.ms ? -1 : 1;
  if (pa.counter !== pb.counter) return pa.counter < pb.counter ? -1 : 1;
  return pa.device < pb.device ? -1 : pa.device > pb.device ? 1 : 0;
}

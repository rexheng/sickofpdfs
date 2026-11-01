// Spec-blind tests for dHash64, hammingHex and DHASH_MATCH_MAX (Phase 2, S3).
//
// Sources: plan section 7 (`dHash64(grey9x8: Uint8Array): string`, `hammingHex(a, b): number`, DHASH_MATCH_MAX = 10) and
// research 06 section 5 ("a 64-bit perceptual hash of the region rendered at 9x8 grey"; "dHash within Hamming distance 10").
// A 9x8 grey image is 72 bytes, 9 across and 8 down; the 64 bits are the 8 left-to-right comparisons in each of 8 rows.
//
// The spec does not say which way a bit points (left > right or right > left) or in which order the bits are written, so
// no test pins a hash value of a real picture. The tests state what holds for either choice: hashes are 16 hex chars,
// a brightening or a contrast stretch does not change them, noise below the steps between pixels does not change them,
// and reversing the picture flips every bit.
import { describe, expect, it } from 'vitest';
import { DHASH_MATCH_MAX, dHash64, hammingHex } from './dhash';

/** A repeatable 72-byte picture whose neighbouring pixels always differ by at least 12. */
function picture(seed: number): Uint8Array {
  const px = new Uint8Array(72);
  let s = seed;
  let prev = -100;
  for (let i = 0; i < 72; i++) {
    do {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      px[i] = 30 + (s % 180);
    } while (Math.abs(px[i] - prev) < 12);
    prev = px[i];
  }
  return px;
}
const map = (px: Uint8Array, f: (v: number, i: number) => number) => Uint8Array.from(px, f);
const ramp = (dir: 1 | -1) => Uint8Array.from({ length: 72 }, (_, i) => (dir === 1 ? 3 * i : 255 - 3 * i));

describe('hammingHex', () => {
  it.each([
    ['0000000000000000', '0000000000000000', 0],
    ['0000000000000000', '0000000000000001', 1],
    ['8000000000000000', '0000000000000000', 1],
    ['0000000000000000', 'ffffffffffffffff', 64],
    ['a5a5a5a5a5a5a5a5', '5a5a5a5a5a5a5a5a', 64],
    ['ffc0000000000000', '0000000000000000', 10],
    ['f0f0f0f0f0f0f0f0', 'f0f0f0f0f0f0f0f1', 1],
    ['0123456789abcdef', '0123456789abcdef', 0],
    ['0123456789abcdef', 'fedcba9876543210', 64],
  ] as const)('%s vs %s is %i bits', (a, b, bits) => {
    expect(hammingHex(a, b)).toBe(bits);
    expect(hammingHex(b, a)).toBe(bits);
  });
});

describe('dHash64', () => {
  it('DHASH_MATCH_MAX is 10', () => {
    expect(DHASH_MATCH_MAX).toBe(10);
  });

  it.each([1, 2, 3, 99])('gives 16 lower-case hex chars (seed %i)', (seed) => {
    expect(dHash64(picture(seed))).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic and tells different pictures apart', () => {
    expect(dHash64(picture(1))).toBe(dHash64(picture(1)));
    expect(dHash64(picture(1))).not.toBe(dHash64(picture(2)));
    // two unrelated pictures differ in about half the bits
    const d = hammingHex(dHash64(picture(1)), dHash64(picture(2)));
    expect(d).toBeGreaterThan(10);
    expect(d).toBeLessThan(54);
  });

  it('ignores brightness and contrast: only the order of neighbouring pixels counts', () => {
    const p = picture(7);
    expect(dHash64(map(p, (v) => v + 20))).toBe(dHash64(p));
    expect(dHash64(map(p, (v) => Math.round((v - 30) * 1.2 + 30)))).toBe(dHash64(p));
  });

  it('ignores noise smaller than the steps between pixels (a re-render, JPEG)', () => {
    const p = picture(11);
    const noisy = map(p, (v, i) => v + ((i * 7) % 5) - 2); // -2..+2, steps are at least 12
    expect(hammingHex(dHash64(noisy), dHash64(p))).toBeLessThanOrEqual(DHASH_MATCH_MAX);
    expect(dHash64(noisy)).toBe(dHash64(p));
  });

  it('a flat picture is the same hash at any grey; a rising ramp and a falling ramp are opposite', () => {
    expect(dHash64(new Uint8Array(72).fill(0))).toBe(dHash64(new Uint8Array(72).fill(255)));
    expect(hammingHex(dHash64(ramp(1)), dHash64(ramp(-1)))).toBe(64);
  });

  it('inverting a picture flips every bit', () => {
    const p = picture(5);
    expect(hammingHex(dHash64(p), dHash64(map(p, (v) => 255 - v)))).toBe(64);
  });
});

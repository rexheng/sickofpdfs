// A 64-bit difference hash (dHash) of a region rendered at 9 × 8 grey, for telling whether a figure or an area looks
// the same in two copies of a PDF (research 06 §5). Two regions match when their hashes differ in at most
// DHASH_MATCH_MAX of the 64 bits.

/** Hamming distance up to which two hashes count as the same picture. */
export const DHASH_MATCH_MAX = 10;

const COLS = 9;
const ROWS = 8;

/**
 * The dHash of a 9 × 8 greyscale image, row by row (72 bytes, 0–255). Each row gives 8 bits: bit x is 1 when pixel
 * x + 1 is brighter than pixel x. The first bit is the most significant; the result is 16 lower-case hex digits.
 * It ignores overall brightness and contrast, so a lighter copy of the same picture hashes the same.
 */
export function dHash64(grey9x8: Uint8Array): string {
  if (grey9x8.length !== COLS * ROWS) throw new RangeError(`dHash64 needs ${COLS * ROWS} grey values (9 × 8), got ${grey9x8.length}`);
  let hex = '';
  for (let y = 0; y < ROWS; y++) {
    // Two nibbles per row: the row's 8 bits, most significant first.
    let bits = 0;
    for (let x = 0; x < COLS - 1; x++) bits = (bits << 1) | (grey9x8[y * COLS + x + 1] > grey9x8[y * COLS + x] ? 1 : 0);
    hex += bits.toString(16).padStart(2, '0');
  }
  return hex;
}

const POPCOUNT = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

/**
 * How many bits differ between two hashes written as hex. Hashes of different lengths, or with a char that is not a hex
 * digit, never match: every bit that cannot be compared counts as different.
 */
export function hammingHex(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  const common = Math.min(x.length, y.length);
  let distance = 4 * Math.abs(x.length - y.length);
  for (let i = 0; i < common; i++) {
    const dx = parseInt(x[i], 16);
    const dy = parseInt(y[i], 16);
    distance += Number.isNaN(dx) || Number.isNaN(dy) ? 4 : POPCOUNT[dx ^ dy];
  }
  return distance;
}

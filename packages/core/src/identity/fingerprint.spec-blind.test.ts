// Spec-blind tests for the fingerprint (Task 18). Written from the spec's "Library and knowledge base" section:
//   rule 1: "A document is its fingerprint: the SHA-256 of the file's bytes, computed while it streams in."
//   rule 5: "Ids never duplicate across devices. A document's id is its fingerprint."
// and from the interface: Sha256 is 64 lowercase hex; createSha256() streams; sha256Hex() takes bytes or a string.
// The oracle is Web Crypto (built into Node), never the code under test.
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { createSha256, sha256Hex } from '../index';

const HEX64 = /^[0-9a-f]{64}$/;

async function oracle(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Deterministic pseudo-random bytes (xorshift32), so a failure reproduces. */
function pseudoRandomBytes(length: number, seed = 0x9e3779b9): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed >>> 0;
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

async function streamed(bytes: Uint8Array, chunkSizes: number[]): Promise<string> {
  const hasher = await createSha256();
  let offset = 0;
  for (const size of chunkSizes) {
    hasher.update(bytes.subarray(offset, offset + size));
    offset += size;
  }
  if (offset < bytes.length) hasher.update(bytes.subarray(offset));
  return hasher.digest();
}

describe('sha256Hex: known answers (spec rule 1, SHA-256 of the bytes)', () => {
  // [name, input, expected hex]. Expected values come from sha256sum / Python hashlib, not from this repo.
  const vectors: Array<[string, string, string]> = [
    ['empty string', '', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['"abc" (FIPS 180-2 example)', 'abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['"hello world"', 'hello world', 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9'],
    [
      '448-bit message (FIPS 180-2 example, spans a padding boundary)',
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    ],
    ['non-ASCII is hashed as UTF-8 (cafe with an acute e)', 'café', '850f7dc43910ff890f8879c0ed26fe697c93a067ad93a7d50f466a7028a9bf4e'],
    [
      'CJK plus an astral emoji is hashed as UTF-8',
      '日本語 \u{1F4C4}',
      '9f097b268a3f2cf43722a9df6855d89a1cfbe59759f056486cd71942dda6daac',
    ],
    ['a digest that starts with zeros keeps its leading zeros', 'fingerprint-1224', '000aac9b257fb0111d1c71f4e8a7d4f30fa95a1f1bc9817cf2aa61fe9f7dfbf7'],
    ['another digest with three leading zero nibbles', 'fingerprint-2154', '000376ad03c3864bd2f0ec33b7a5d8d36d73fa6197bbcdcf21509d28a6409d63'],
  ];

  it.each(vectors)('%s', async (_name, input, expected) => {
    expect(await sha256Hex(input)).toBe(expected);
    // the same text as bytes must give the same fingerprint as the text itself
    expect(await sha256Hex(new TextEncoder().encode(input))).toBe(expected);
  });

  it('every byte value 0..255 survives (no text decoding of binary input)', async () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(await sha256Hex(all)).toBe('40aff2e9d2d8922e47afd4648e6967497158785fbd1da870e7110266bf944880');
  });

  it('one million "a" bytes in a single call (FIPS 180-2 long example)', async () => {
    const million = new Uint8Array(1_000_000).fill(0x61);
    expect(await sha256Hex(million)).toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
  });
});

describe('sha256Hex: stable for the same bytes, different for different bytes', () => {
  it('returns 64 lowercase hex characters for inputs of every awkward size', async () => {
    for (const size of [0, 1, 2, 55, 56, 63, 64, 65, 1000, 65536]) {
      const out = await sha256Hex(pseudoRandomBytes(size));
      expect(out, `size ${size}`).toMatch(HEX64);
    }
    expect(await sha256Hex('')).toMatch(HEX64);
  });

  it('is stable: the same bytes from two separate buffers, and from repeated calls, give one fingerprint', async () => {
    const original = pseudoRandomBytes(300_000);
    const copyElsewhere = new Uint8Array(original); // a re-download of the same file lands in a new buffer
    const first = await sha256Hex(original);
    expect(await sha256Hex(copyElsewhere)).toBe(first);
    expect(await sha256Hex(original)).toBe(first);
    expect(first).toBe(await oracle(original));
  });

  it('hashes only the visible window of a view, never the whole backing buffer', async () => {
    // pdf.js and fetch hand out views into larger buffers; hashing view.buffer would fingerprint the wrong bytes
    const backing = pseudoRandomBytes(10_000);
    const view = backing.subarray(1234, 5678);
    const standalone = backing.slice(1234, 5678);
    expect(await sha256Hex(view)).toBe(await sha256Hex(standalone));
    expect(await sha256Hex(view)).toBe(await oracle(standalone));
    expect(await sha256Hex(view)).not.toBe(await sha256Hex(backing));
  });

  it('changes when any single bit changes: first byte, middle byte, last byte', async () => {
    const base = pseudoRandomBytes(100_000);
    const baseline = await sha256Hex(base);
    const seen = new Set([baseline]);
    for (const index of [0, 50_000, 99_999]) {
      const flipped = new Uint8Array(base);
      flipped[index] = flipped[index] ^ 0x01;
      const fp = await sha256Hex(flipped);
      expect(fp, `bit flip at ${index}`).not.toBe(baseline);
      seen.add(fp);
    }
    expect(seen.size).toBe(4);
  });

  it('tells apart inputs that only differ in length or order', async () => {
    const fps = await Promise.all([
      sha256Hex(new Uint8Array(1)), // one zero byte
      sha256Hex(new Uint8Array(2)), // two zero bytes
      sha256Hex(new Uint8Array(0)),
      sha256Hex(Uint8Array.of(1, 2, 3)),
      sha256Hex(Uint8Array.of(3, 2, 1)),
      sha256Hex('%PDF-1.7'),
      sha256Hex('%PDF-1.7\n'), // a trailing newline is a different file
    ]);
    expect(new Set(fps).size).toBe(fps.length);
  });
});

describe('createSha256: streaming while the file arrives (spec rule 1, "computed while it streams in")', () => {
  const data = pseudoRandomBytes(1_000_003); // deliberately not a multiple of anything

  // Chunk plans that straddle SHA-256's 64-byte block and padding boundaries, plus network-sized chunks.
  const plans: Array<[string, number[]]> = [
    ['one big chunk', [data.length]],
    ['single bytes at the start, then the rest', [1, 1, 1, 1, 1, 1, 1, 1]],
    ['chunks of 63, 64 and 65 bytes (block boundary)', [63, 64, 65, 63, 64, 65]],
    ['55 then 56 then 57 bytes (padding boundary)', [55, 56, 57]],
    ['zero-length chunks between real ones', [0, 100, 0, 0, 900, 0]],
    ['64 KiB network chunks', Array.from({ length: 15 }, () => 65_536)],
    ['irregular sizes', [1, 4095, 3, 100_000, 7, 65_535, 250_000, 17]],
  ];

  it.each(plans)('%s gives the one-shot fingerprint', async (_name, sizes) => {
    const expected = await oracle(data);
    expect(await streamed(data, sizes)).toBe(expected);
    expect(await sha256Hex(data)).toBe(expected);
  });

  it('with no update at all, the digest is the fingerprint of the empty file', async () => {
    const hasher = await createSha256();
    expect(hasher.digest()).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('one million "a" bytes in 1000-byte chunks matches the FIPS long example', async () => {
    const hasher = await createSha256();
    const chunk = new Uint8Array(1000).fill(0x61);
    for (let i = 0; i < 1000; i++) hasher.update(chunk);
    expect(hasher.digest()).toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
  });

  it('digest() is a plain 64-char lowercase hex string, returned synchronously', async () => {
    const hasher = await createSha256();
    hasher.update(new TextEncoder().encode('%PDF-1.7 fake'));
    const digest = hasher.digest();
    expect(typeof digest).toBe('string');
    expect(digest).toMatch(HEX64);
  });

  it('two downloads in flight do not share state, even when their chunks interleave', async () => {
    // Two tabs open two PDFs at the same time.
    const a = pseudoRandomBytes(200_000, 1);
    const b = pseudoRandomBytes(200_000, 2);
    const ha = await createSha256();
    const hb = await createSha256();
    for (let offset = 0; offset < a.length; offset += 40_000) {
      ha.update(a.subarray(offset, offset + 40_000));
      hb.update(b.subarray(offset, offset + 40_000));
    }
    expect(hb.digest()).toBe(await oracle(b));
    expect(ha.digest()).toBe(await oracle(a));
  });

  it('lets the caller reuse one read buffer: bytes are consumed when update() returns', async () => {
    // A stream reader loop often refills the same buffer. The fingerprint must be of what was passed at each call.
    const total = pseudoRandomBytes(4096 * 6, 77);
    const reused = new Uint8Array(4096);
    const hasher = await createSha256();
    for (let i = 0; i < 6; i++) {
      reused.set(total.subarray(i * 4096, (i + 1) * 4096));
      hasher.update(reused);
    }
    expect(hasher.digest()).toBe(await oracle(total));
  });

  it('chunks that are views into one larger buffer hash only their own window', async () => {
    const hasher = await createSha256();
    hasher.update(data.subarray(0, 700_001));
    hasher.update(data.subarray(700_001));
    expect(hasher.digest()).toBe(await oracle(data));
  });
});

describe('fingerprints of real PDF bytes (spec walkthrough 9: move, rename, re-download)', () => {
  async function makePdf(modified: Date): Promise<Uint8Array> {
    const pdf = await PDFDocument.create();
    pdf.setTitle('Parallel trends in difference-in-differences');
    pdf.setCreationDate(new Date('2024-09-30T09:00:00Z'));
    pdf.setModificationDate(modified);
    for (let page = 1; page <= 3; page++) {
      pdf.addPage([595, 842]).drawText(`Page ${page}: the same words on every download.`, { x: 50, y: 780 });
    }
    return pdf.save();
  }

  it('a moved or renamed file (identical bytes) keeps its fingerprint; streaming it gives the same id', async () => {
    const bytes = await makePdf(new Date('2024-10-01T10:00:00Z'));
    expect(bytes.length).toBeGreaterThan(1000);
    const moved = new Uint8Array(bytes); // same bytes, read from another folder
    const fromDisk = await sha256Hex(bytes);
    expect(await sha256Hex(moved)).toBe(fromDisk);
    expect(await streamed(moved, [7, 333, 1024, 5])).toBe(fromDisk);
    expect(fromDisk).toBe(await oracle(bytes));
  });

  it('the same text with a new download stamp is NEW bytes, so it gets a new fingerprint (text matching is a separate layer)', async () => {
    const first = await makePdf(new Date('2024-10-01T10:00:00Z'));
    const second = await makePdf(new Date('2024-10-02T11:30:00Z'));
    expect(await sha256Hex(first)).not.toBe(await sha256Hex(second));
  });
});

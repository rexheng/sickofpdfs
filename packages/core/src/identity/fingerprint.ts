import { createSHA256, sha256 } from 'hash-wasm';
import type { Sha256 } from '../ids';

/** Hashes a file as it streams in. Feed it chunks with `update`, then call `digest` once at the end. */
export interface Sha256Hasher {
  update(chunk: Uint8Array): void;
  /** Ends the hash. Calling it again returns the same value; `update` after it throws. */
  digest(): Sha256;
}

/** Loads the hashing engine (WebAssembly) and returns a fresh hasher. */
export async function createSha256(): Promise<Sha256Hasher> {
  const engine = await createSHA256();
  let done: Sha256 | undefined;
  return {
    update(chunk) {
      if (done !== undefined) throw new Error('Sha256Hasher: update() after digest()');
      engine.update(chunk);
    },
    digest() {
      done ??= engine.digest('hex') as Sha256;
      return done;
    },
  };
}

/** The SHA-256 of some bytes, or of a string's UTF-8 bytes. */
export async function sha256Hex(data: Uint8Array | string): Promise<Sha256> {
  return (await sha256(data)) as Sha256;
}

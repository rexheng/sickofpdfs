// Node only. The extension itself reads its id from chrome.runtime.id.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** The file holding the base64 SPKI DER of the extension's public key (the manifest `key` value). */
export const PUBLIC_KEY_FILE = new URL('../extension-key.pub.txt', import.meta.url);

/**
 * Chrome's extension id for a public key: the first 16 bytes of sha256(DER) as hex, with each hex digit
 * 0-f written as a-p.
 * @param {string} base64Der base64 of the DER-encoded SubjectPublicKeyInfo
 * @returns {string} 32 characters, a-p
 */
export function extensionIdFromKey(base64Der) {
  const hex = createHash('sha256').update(Buffer.from(base64Der, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode('a'.charCodeAt(0) + parseInt(c, 16))).join('');
}

/** The base64 public key from the committed file. */
export function readPublicKey() {
  return readFileSync(PUBLIC_KEY_FILE, 'utf8').trim();
}

/** The stable extension id, derived from the committed public key. */
export const EXTENSION_ID = extensionIdFromKey(readPublicKey());

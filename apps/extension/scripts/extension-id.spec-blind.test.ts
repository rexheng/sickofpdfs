// Spec-blind tests for the stable extension id (spec: "a fixed extension key we generate ourselves ... so the
// extension's identity and data survive updates and folder moves"). Interface: extension-id.mjs.
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXTENSION_ID, extensionIdFromKey } from './extension-id.mjs';

const extensionRoot = fileURLToPath(new URL('../', import.meta.url));

/** Chrome's rule: sha256 of the DER public key, first 16 bytes as hex, each hex digit 0-f shown as a-p. */
function referenceId(der: Buffer): string {
  const hex = createHash('sha256').update(der).digest('hex').slice(0, 32);
  return [...hex].map((c) => 'abcdefghijklmnop'[parseInt(c, 16)]).join('');
}

// Each pair was confirmed by loading the key as "key" in a manifest and reading the id Chromium gave the extension.
const CHROME_CONFIRMED: { name: string; key: string; id: string }[] = [
  {
    name: 'RSA 2048',
    key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAp/yt/YMaAJuPFMKks67NYJhehe+MyIL/jcanQl2jqFTul8MKep/b3nmF8nnCpdHLxeLPX/ztVu10Z3Hii2Eki9j04w3rIIM66Mxg4naJZUbZxfXWwDj7T9CDwqqIOetfkVkmZgivPJ7Avyv4AFw1tiIg9i5PlDFedWPf+nTnG5ROw+s2LTp63T9vIhRaARFXVNr0ReLzHNxItMEq+O/N9ZO9Oh3zZ5aeGism6AOa0ghWwTEw+6nDW6yvKvaLmnTOHdwWVOxP3txzPJAN0fo//EprjtWJaycGSYDdPdhPG1hiaACR/xbgWEglXZYLmIIqbU8sDO4UVLTKEF3HK5lcWQIDAQAB',
    id: 'nfmemddnlcfkmecdmmmbochaompejpio',
  },
  {
    name: 'RSA 3072',
    key: 'MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEApnlQKdffvFwcSuAEr0qsdjy79/HhRIlB2AsnoVx7v6hJHrV6FhF8sAKD2sqfyUcztjsh03msmL8BMfZuzuSW51rI7+7qmpsD7zuOGqRLSIkYzs/UenWkLrH/ydhF1wsjFr8T1BfA6ijkb9RoJzEl1Iq6pesPM4pVtCFV8DQMj0EjgixgQ74nLHYJHc1IEsuDfZ8mBN/NrswmQeyC12lG1f9JhiPAuU+uXaq6wO5ejHYdFE5e1H3rMZTrVECrIslTKr1rBWqUD5P4s0NAKiUrsnGeWdMkOCs9N8ZI73WCcfdZ39ccNwF+fHYWt8gA9D6g2oZP3LkVcWlcq2yLA23i16oo7azEM614HEgA0lQzwdLxCkzXDJsh8LVz4xqA6M2zsPDltYl1B/5m/93c73Zyxlu+48QrX32TdVJ7iSlXho50vFIZdHEUMYmVV+o/GrOBn8b8pVAqF7rywJKwmUe2Pq8efdw1AnFKujzmr3EOkWDslTBu/HGFaON20+mJyM/jAgMBAAE=',
    id: 'diikpihhkmlfhaepccfpeepoffcmclnn',
  },
];

describe('extensionIdFromKey', () => {
  it.each(CHROME_CONFIRMED)('gives the id Chromium gives: $name', ({ key, id }) => {
    expect(extensionIdFromKey(key)).toBe(id);
  });

  it('follows the rule for fresh keys: 32 letters a-p, different for different keys', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const der = publicKey.export({ type: 'spki', format: 'der' });
      const id = extensionIdFromKey(der.toString('base64'));
      expect(id).toMatch(/^[a-p]{32}$/);
      expect(id).toBe(referenceId(der));
      ids.add(id);
    }
    expect(ids.size).toBe(3);
  });
});

describe('the committed key', () => {
  const keyFile = readFileSync(join(extensionRoot, 'extension-key.pub.txt'), 'utf8');
  const keyBase64 = keyFile.replace(/\s+/g, '');

  it('is a bare base64 public key (it goes straight into the manifest "key") and is a real RSA key', () => {
    expect(keyFile).not.toMatch(/-----|PRIVATE/);
    expect(keyBase64).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    const publicKey = createPublicKey({ key: Buffer.from(keyBase64, 'base64'), format: 'der', type: 'spki' });
    expect(publicKey.asymmetricKeyType).toBe('rsa');
    expect(publicKey.asymmetricKeyDetails?.modulusLength).toBeGreaterThanOrEqual(2048);
  });

  it('is what EXTENSION_ID comes from', () => {
    expect(EXTENSION_ID).toMatch(/^[a-p]{32}$/);
    expect(EXTENSION_ID).toBe(referenceId(Buffer.from(keyBase64, 'base64')));
  });

  it('is the only half of the pair in the extension folder: no private key is committed or left lying about', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (['node_modules', '.output', '.wxt'].includes(name)) continue;
        const path = join(dir, name);
        const info = statSync(path);
        if (info.isDirectory()) walk(path);
        else if (/\.(pem|key|p8|der)$/i.test(name)) offenders.push(`${path} (file name)`);
        else if (info.size < 1_000_000 && /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(readFileSync(path, 'latin1'))) offenders.push(`${path} (contains a private key)`);
      }
    };
    walk(extensionRoot);
    expect(offenders).toEqual([]);
  });
});

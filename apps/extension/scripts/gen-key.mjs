// One-off: creates the extension's fixed signing key, which gives it the same id on every machine and build.
//
//   node apps/extension/scripts/gen-key.mjs
//
// - The PRIVATE key (PEM) goes to ~/.config/sickofpdfs/extension-key.pem with mode 600. It never goes in the repo
//   (*.pem is gitignored as well). Loading the unpacked extension needs only the public key, so you can lose the
//   private one unless you want to pack a .crx with this id later.
// - The PUBLIC key (base64 SPKI DER, the manifest `key` value) goes to apps/extension/extension-key.pub.txt,
//   which is committed.
//
// It refuses to run when either file exists: a new key means a new extension id, and the data stored under the old
// id is then unreachable. Pass --force to replace them on purpose.
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const privateKeyFile = join(homedir(), '.config', 'sickofpdfs', 'extension-key.pem');
const publicKeyFile = fileURLToPath(new URL('../extension-key.pub.txt', import.meta.url));
const force = process.argv.includes('--force');

if (!force && (existsSync(privateKeyFile) || existsSync(publicKeyFile))) {
  console.error(`Not overwriting the existing key (${existsSync(privateKeyFile) ? privateKeyFile : publicKeyFile}).`);
  console.error('A new key changes the extension id. Pass --force if you really want that.');
  process.exit(1);
}

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicDer = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

mkdirSync(dirname(privateKeyFile), { recursive: true, mode: 0o700 });
writeFileSync(privateKeyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
chmodSync(privateKeyFile, 0o600); // writeFileSync's mode only applies when it creates the file
writeFileSync(publicKeyFile, `${publicDer}\n`);

console.log(`private key: ${privateKeyFile} (mode 600, keep it out of the repo)`);
console.log(`public key:  ${publicKeyFile} (commit this)`);
// extension-id.mjs reads the public key file when it loads, so it can only be imported once that file exists
const { extensionIdFromKey } = await import('./extension-id.mjs');
console.log(`extension id: ${extensionIdFromKey(publicDer)}`);

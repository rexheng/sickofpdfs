// The end of `build` and `build:e2e`: `node scripts/check-no-cdn.mjs <built folder>` fails when any file of the built
// extension names a CDN. Every engine file, font and script ships inside the extension, and nothing may leave except
// what the owner turns on; a CDN address in the bundle is dead code that a review will flag, or a request waiting for
// one upstream change to happen. (EmbedPDF's default font list was one: patches/@embedpdf__engines@2.15.1.patch.)
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const CDN = /jsdelivr|unpkg|googleapis/gi;

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node scripts/check-no-cdn.mjs <built extension folder>');
  process.exit(2);
}
const root = resolve(dir);

const found = [];
for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const path = join(entry.parentPath, entry.name);
  const text = (await readFile(path)).toString('latin1'); // binary files too: a wasm or font could carry an address
  for (const match of text.matchAll(CDN)) {
    const at = match.index ?? 0;
    found.push(`${relative(root, path)}: …${text.slice(Math.max(0, at - 40), at + 60).replace(/\s+/g, ' ')}…`);
  }
}

if (found.length > 0) {
  console.error(`check-no-cdn: ${found.length} CDN address(es) in ${dir}:`);
  for (const line of found) console.error(`  ${line}`);
  process.exit(1);
}
console.log(`check-no-cdn: no CDN address in ${dir}`);

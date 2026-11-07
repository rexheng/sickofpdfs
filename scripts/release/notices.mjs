// `node scripts/release/notices.mjs` writes THIRD_PARTY_NOTICES.md at the repo root: the short list (name, version, licence)
// of everything inside the extension. The full licence texts are in the zip (THIRD_PARTY_NOTICES.txt) and in the extension
// (Help → About → Open-source licences). Both come from the same generator, apps/extension/scripts/third-party-notices.mjs.
//   node scripts/release/notices.mjs            rewrites the .md
//   node scripts/release/notices.mjs --check    exits 1 when the .md is not what the generator gives now (the workflow runs this)
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const file = join(root, 'THIRD_PARTY_NOTICES.md');
const generated = join(root, 'apps/extension/public/THIRD_PARTY_NOTICES.txt');

const made = spawnSync('node', ['apps/extension/scripts/third-party-notices.mjs'], { cwd: root, stdio: 'inherit' });
if (made.status !== 0 || !existsSync(generated)) process.exit(1);

const full = readFileSync(generated, 'utf8');
const list = /^CONTENTS \((\d+) items\)\n((?:\s+\d+\..*\n)+)/m.exec(full);
if (!list) {
  console.error('notices: cannot find the CONTENTS list in the generated notices');
  process.exit(1);
}
const rows = list[2]
  .trimEnd()
  .split('\n')
  .map((line) => /^\s*\d+\.\s+(.*?)\s{2}\[(.*)\]$/.exec(line))
  .map((m, i) => {
    if (!m) throw new Error(`notices: cannot read CONTENTS line ${i + 1}`);
    return `| ${m[1].replaceAll('|', '\\|')} | ${m[2].replaceAll('|', '\\|')} |`;
  });

const md = `# Third-party notices

sickofpdfs is built on other people's open-source work. This is the short list: ${list[1]} items, each with its licence.

The full licence text of every item is inside the extension. Open the library, then Help → About → Open-source licences.
The release zip also holds it as \`THIRD_PARTY_NOTICES.txt\`. Nothing here is sent anywhere.

This file is written by \`node scripts/release/notices.mjs\` from the same generator as the full file. Do not edit it by hand.

| Name and version | Licence |
| --- | --- |
${rows.join('\n')}
`;

if (process.argv.includes('--check')) {
  if (!existsSync(file) || readFileSync(file, 'utf8') !== md) {
    console.error('notices: THIRD_PARTY_NOTICES.md is out of date. Run `node scripts/release/notices.mjs` and commit it.');
    process.exit(1);
  }
  console.log('notices: THIRD_PARTY_NOTICES.md is current');
} else {
  writeFileSync(file, md);
  console.log(`notices: wrote THIRD_PARTY_NOTICES.md (${rows.length} items)`);
}

// Fills the shared fixture cache test-assets/classifier/<path> (repo-relative, gitignored) from
// docs/research/classifier-fixtures/manifest.json, checks every file's sha256, then copies the
// files into fixtures/out/classifier/<path>.
//
// A missing cache file is copied from $SOP_FIXTURE_SRC/<path> when that optional override is set
// and holds the file; otherwise it is downloaded from the manifest `url`. The PDFs are untrusted
// data: they are only hashed and copied, never opened here.
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const spikeRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = join(spikeRoot, '..', '..');
const manifestPath = join(repoRoot, 'docs/research/classifier-fixtures/manifest.json');
const cacheRoot = join(repoRoot, 'test-assets/classifier');
const outRoot = join(spikeRoot, 'fixtures/out/classifier');
const override = process.env.SOP_FIXTURE_SRC || null;

const sha256 = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');

async function fill(item, cached) {
  const local = override && join(override, item.path);
  if (local && existsSync(local)) {
    await copyFile(local, cached);
    return 'copied';
  }
  const res = await fetch(item.url, { redirect: 'follow', headers: { 'user-agent': 'sickofpdfs-fixtures/0' } });
  if (!res.ok) throw new Error(`${item.path}: HTTP ${res.status} from ${item.url}`);
  await writeFile(cached, new Uint8Array(await res.arrayBuffer()));
  return 'downloaded';
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const counts = { cached: 0, copied: 0, downloaded: 0 };
const failures = [];
for (const item of manifest.items) {
  const cached = join(cacheRoot, item.path);
  await mkdir(dirname(cached), { recursive: true });
  try {
    let how = 'cached';
    if (!existsSync(cached) || (await sha256(cached)) !== item.sha256) how = await fill(item, cached);
    const actual = await sha256(cached);
    if (actual !== item.sha256) {
      await rm(cached, { force: true });
      throw new Error(`${item.path}: sha256 ${actual} does not match the manifest's ${item.sha256}`);
    }
    counts[how]++;
    const out = join(outRoot, item.path);
    await mkdir(dirname(out), { recursive: true });
    await copyFile(cached, out);
  } catch (err) {
    failures.push(err instanceof Error ? err.message : String(err));
  }
}
console.log(
  `classifier fixtures: ${manifest.items.length - failures.length}/${manifest.items.length} ready ` +
    `(${counts.cached} cached, ${counts.copied} copied from SOP_FIXTURE_SRC, ${counts.downloaded} downloaded)`,
);
if (failures.length) {
  for (const f of failures) console.error(`  FAILED ${f}`);
  process.exit(1);
}

// `node scripts/fetch-minilm.mjs` (the start of `build` and `build:e2e`): puts the learning filter's tie-breaker model in
// apps/extension/public/models/minilm/ (gitignored), which WXT copies into the build as models/minilm/. The viewer reaches it with
// chrome.runtime.getURL('models/minilm/…'); nothing is downloaded when the extension runs.
//
// The model is all-MiniLM-L6-v2, the int8 ONNX export by Xenova (Apache-2.0), at one pinned commit of its Hugging Face
// repository. Only this script goes to the network, only at build time, only to huggingface.co (its downloads are sent on
// to a Hugging Face CDN), and every file is checked against the sha256 written below before it is kept: a file that does not
// match is deleted and the script exits 1. A file already in place with the right hash is left alone, so a build without a
// connection works after the first one.
//
// Offline copy: `SOP_MINILM_SRC=<folder>` takes the files from that folder when it holds them (it is checked the same way).
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const repo = 'Xenova/all-MiniLM-L6-v2';
const commit = '751bff37182d3f1213fa05d7196b954e230abad9';
// Read by third-party-notices.mjs, which names the model and its revision in THIRD_PARTY_NOTICES.txt. When the commit
// changes, check the model card's licence again and that file's notes about the model.
export const MINILM_REPO = repo;
export const MINILM_COMMIT = commit;

/** The files the tie-breaker reads. `bytes` and `sha256` are of the file at `commit`. */
export const MINILM_FILES = [
  { path: 'onnx/model_quantized.onnx', name: 'model_quantized.onnx', bytes: 22972370, sha256: 'afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1' },
  { path: 'vocab.txt', name: 'vocab.txt', bytes: 231508, sha256: '07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3' },
];

const out = fileURLToPath(new URL('../public/models/minilm/', import.meta.url));
const RETRIES = 3;

const NOTICE = `all-MiniLM-L6-v2, int8 ONNX export
Model by the Sentence-Transformers project (sentence-transformers/all-MiniLM-L6-v2); ONNX export by Xenova.
Licence: Apache-2.0 (https://www.apache.org/licenses/LICENSE-2.0).
Source: https://huggingface.co/${repo}/tree/${commit}
Files: ${MINILM_FILES.map((f) => `${f.name} (sha256 ${f.sha256})`).join('; ')}
Used for: the learning filter's tie-breaker. It runs on this computer only; nothing is sent anywhere.
`;

async function sha256Of(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function matches(file, path) {
  try {
    return (await stat(path)).size === file.bytes && (await sha256Of(path)) === file.sha256;
  } catch {
    return false;
  }
}

async function download(file, to) {
  const url = `https://huggingface.co/${repo}/resolve/${commit}/${file.path}`;
  const part = `${to}.part`;
  try {
    const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'sickofpdfs-build/0' } });
    if (!res.ok || res.body === null) throw new Error(`HTTP ${res.status} from ${url}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(part));
    if (!(await matches(file, part))) throw new Error(`${file.name}: the download does not match the pinned size and sha256`);
    await rename(part, to);
  } finally {
    await rm(part, { force: true });
  }
}

/** Fills apps/extension/public/models/minilm/. Rejects when a file cannot be fetched or does not match its sha256. */
export default async function fetchMinilm() {
  await mkdir(out, { recursive: true });
  const local = process.env.SOP_MINILM_SRC || null;
  const how = { kept: 0, copied: 0, downloaded: 0 };
  for (const file of MINILM_FILES) {
    const to = join(out, file.name);
    if (await matches(file, to)) {
      how.kept++;
      continue;
    }
    const from = local && join(local, file.name);
    if (from && existsSync(from) && (await matches(file, from))) {
      await copyFile(from, to);
      how.copied++;
      continue;
    }
    let lastError = null;
    for (let attempt = 1; attempt <= RETRIES; attempt++) {
      try {
        await download(file, to);
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        if (attempt < RETRIES) await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
    if (lastError) throw new Error(`cannot fetch ${file.name}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
    how.downloaded++;
  }
  await writeFile(join(out, 'NOTICE.txt'), NOTICE);
  const bytes = MINILM_FILES.reduce((n, f) => n + f.bytes, 0);
  console.log(`minilm: ${MINILM_FILES.length} files, ${(bytes / 2 ** 20).toFixed(1)} MiB in apps/extension/public/models/minilm/ (${how.kept} kept, ${how.copied} copied, ${how.downloaded} downloaded)`);
}

// Run as a script (`node scripts/fetch-minilm.mjs`), not when imported.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await fetchMinilm();
  } catch (err) {
    console.error(`fetch-minilm: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

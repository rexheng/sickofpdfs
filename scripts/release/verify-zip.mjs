// `node scripts/release/verify-zip.mjs <release zip> [--store]` (also the last step of `pnpm release:zip` and of the release workflow).
// With --store it checks the Chrome Web Store zip instead: no `key` in the manifest (the store refuses one) and no
// HOW-TO-UPDATE.txt; everything else is the same.
// Opens the zip the way Chrome would, and fails (exit 1) with one plain line per problem when:
//  1. the extension id is not the one the committed public key gives (apps/extension/extension-key.pub.txt), or the version is wrong;
//  2. a test hook is inside (the __sopTest hooks, the test Claude base URL);
//  3. anything loads a script, font or model from the internet (HTML tags, CSS, importScripts, import(), Worker, a CDN or model host);
//  4. any text is shaped like a model id (the word before the first dash, then dash-separated letters and digits);
//  5. the engine, a font or the model is missing (the model is also checked for size and sha256);
//  6. the licence notices are missing or incomplete;
//  7. chrome.scripting is named outside the toolbar menu's chunks (scripts/check-scripting.mjs, the same check the build runs).
// It also runs the build's no-CDN check on the unzipped files. Nothing here uses the network.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const ext = join(root, 'apps/extension');
const { extensionIdFromKey, readPublicKey } = await import(new URL('../../apps/extension/scripts/extension-id.mjs', import.meta.url));
const { MINILM_FILES } = await import(new URL('../../apps/extension/scripts/fetch-minilm.mjs', import.meta.url));

const cli = process.argv.slice(2).filter((a) => a !== '--');
const store = cli.includes('--store');
const zipArg = cli.find((a) => !a.startsWith('--'));
const zipPath = zipArg ? resolve(zipArg) : undefined;
if (!zipPath || !existsSync(zipPath)) {
  console.error('usage: node scripts/release/verify-zip.mjs <release zip> [--store]');
  process.exit(2);
}

const problems = [];
const fail = (text) => problems.push(text);
const near = (text, at, len = 50) => text.slice(Math.max(0, at - len), at + len + 30).replace(/\s+/g, ' ');

// Open the zip into a folder of its own.
const dir = mkdtempSync(join(tmpdir(), 'sop-verify-'));
try {
  const listed = spawnSync('unzip', ['-Z1', zipPath], { encoding: 'utf8', maxBuffer: 64 * 2 ** 20 });
  if (listed.status !== 0) {
    console.error('verify-zip: cannot read the zip (is `unzip` installed?)');
    process.exit(2);
  }
  if (!listed.stdout.split('\n').includes('manifest.json')) fail('manifest.json is not at the top of the zip (Load unpacked needs it there)');
  if (spawnSync('unzip', ['-q', zipPath, '-d', dir]).status !== 0) {
    console.error('verify-zip: cannot unzip');
    process.exit(2);
  }

  const files = new Map(); // path inside the zip -> Buffer
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files.set(relative(dir, path).split('\\').join('/'), await readFile(path));
  }
  const text = (p) => files.get(p).toString('latin1');
  const textFiles = [...files.keys()].filter((p) => /\.(?:m?js|html|css|json|txt)$/i.test(p));

  // 1. The id and the version.
  const manifest = files.has('manifest.json') ? JSON.parse(text('manifest.json')) : {};
  const wantKey = readPublicKey();
  const wantId = extensionIdFromKey(wantKey);
  if (store) {
    if (manifest.key !== undefined) fail('the manifest has a "key": the Chrome Web Store refuses it (make the zip with `pnpm release:zip --store`)');
  } else if (manifest.key !== wantKey) fail(`the extension id would be ${manifest.key ? extensionIdFromKey(manifest.key) : '(random: no key)'}, not ${wantId} from the committed key`);
  const version = JSON.parse(readFileSync(join(ext, 'package.json'), 'utf8')).version;
  if (manifest.version !== version) fail(`manifest version is ${manifest.version}, apps/extension/package.json says ${version}`);
  if (manifest.version_name !== 'Release 1') fail(`manifest version_name is "${manifest.version_name}", not "Release 1" (is this a test build?)`);

  // 2. Test hooks.
  const HOOKS = ['__sopTest', '__sopClaude', 'sop.test.', 'claudeBaseUrl', 'claude-replay', 'test-hooks'];
  for (const p of textFiles) for (const h of HOOKS) if (text(p).includes(h)) fail(`test hook "${h}" in ${p}`);

  // 3. Remote scripts, fonts and models. Links to pages in comments and docs are fine; things that LOAD are not.
  const EXT = '(?:m?js|wasm|onnx|woff2?|ttf|otf|bin|safetensors|gguf|css)';
  const REMOTE = [
    [/<script\b[^>]*\bsrc\s*=\s*["']?(?:https?:)?\/\//gi, 'a <script> from the internet'],
    [/<link\b[^>]*\bhref\s*=\s*["']?(?:https?:)?\/\//gi, 'a <link> to the internet'],
    [/@import\s+(?:url\()?["']?(?:https?:)?\/\//gi, 'a CSS @import from the internet'],
    [/url\(\s*["']?https?:\/\//gi, 'a CSS url() from the internet'],
    [/importScripts\(\s*[^)]*https?:\/\//g, 'importScripts from the internet'],
    [/\bimport\(\s*["'`]https?:\/\//g, 'import() from the internet'],
    [/new\s+(?:Shared)?Worker\(\s*["'`]https?:\/\//g, 'a Worker from the internet'],
    [new RegExp(`https?://[^\\s"'\`)<>]+\\.${EXT}(?![a-z0-9])`, 'gi'), 'a script, font or model address'],
    [/https?:\/\/[^\s"'`)<>/]*(?:huggingface|hf\.co|jsdelivr|unpkg|cdnjs|googleapis|gstatic|cloudfront|fastly)[^\s"'`)<>]*/gi, 'a CDN or model host'],
  ];
  for (const p of textFiles) {
    if (p.endsWith('.txt')) continue; // prose (the notices, the update steps, the model's NOTICE.txt): it names sources
    for (const [re, what] of REMOTE) for (const m of text(p).matchAll(re)) {
      if (/^https?:\/\/(?:www\.)?github\.com\//i.test(m[0])) continue; // a link to a source page in a comment, not a file that loads
      fail(`${what} in ${p}: …${near(text(p), m.index ?? 0)}…`);
    }
  }
  const csp = JSON.stringify(manifest.content_security_policy ?? {});
  if (/https?:/.test(csp)) fail(`the content security policy allows the internet: ${csp}`);

  // 4. Model ids. The pattern is built from pieces so this file never spells one out.
  const modelId = new RegExp(`${['cla', 'ude'].join('')}-(?:[a-z]+-)*[a-z]*[0-9][a-z0-9.-]*`, 'gi');
  // Seven strings sit inside @anthropic-ai/sdk itself (its deprecation, token-limit and beta-header tables); they are not ours and
  // cannot be removed from the bundle. They are listed by the start of their sha256, so this file spells none of them. A new SDK
  // version that brings another one fails here, and someone must look at it before it is added.
  const SDK_OWN = new Set(['e4c82cf6951f1c1f', '1f55eb13e1f5da01', '83d80ddd7437ae0e', '0b03295f7750439e', 'f2b3b47fd9a71add', 'efcf30858a13f54d', '7e1184d5dd523cee']);
  for (const p of textFiles) {
    for (const m of text(p).matchAll(modelId)) {
      if (!SDK_OWN.has(createHash('sha256').update(m[0]).digest('hex').slice(0, 16))) fail(`a model id ("${m[0]}") in ${p}`);
    }
  }

  // 5. The big pieces. Names with a hash are matched by their start.
  const need = (re, what) => {
    if (![...files.keys()].some((p) => re.test(p))) fail(`missing ${what}`);
  };
  need(/^pdf\/pdfium\.wasm$/, 'the PDF engine (pdf/pdfium.wasm)');
  need(/^assets\/engine\.worker-.+\.js$/, 'the engine worker (assets/engine.worker-*.js)');
  need(/^assets\/store-worker-.+\.js$/, 'the store worker (assets/store-worker-*.js)');
  need(/^assets\/sqlite3-.+\.wasm$/, 'SQLite (assets/sqlite3-*.wasm)');
  need(/^ort\/ort-wasm-simd-threaded\.wasm$/, 'ONNX Runtime (ort/ort-wasm-simd-threaded.wasm)');
  for (const f of ['NotoSans-Regular.ttf', 'NotoSans-Bold.ttf', 'NotoSans-Italic.ttf', 'NotoSans-BoldItalic.ttf', 'NotoSansMono-Regular.ttf', 'NotoSansHans-Regular.otf']) {
    if (!files.has(`pdf/${f}`)) fail(`missing the fallback font pdf/${f}`);
  }
  need(/^assets\/google-sans-flex-latin-full-normal-.+\.woff2$/, 'the interface font (Google Sans Flex)');
  need(/^assets\/material-symbols-outlined-.+\.woff2$/, 'the icon font (Material Symbols)');
  for (const m of MINILM_FILES) {
    const p = `models/minilm/${m.name}`;
    const buf = files.get(p);
    if (!buf) fail(`missing the learning-filter model file ${p}`);
    else if (buf.length !== m.bytes || createHash('sha256').update(buf).digest('hex') !== m.sha256) fail(`${p} is not the pinned file (size or sha256 differs)`);
  }
  for (const page of ['library.html', 'viewer.html', 'popup.html', 'offscreen.html', 'licences.html', 'save-page.html']) if (!files.has(page)) fail(`missing ${page}`);
  if (store && files.has('HOW-TO-UPDATE.txt')) fail('HOW-TO-UPDATE.txt is in the store zip (store installs update by themselves)');
  if (!store && !files.has('HOW-TO-UPDATE.txt')) fail('missing HOW-TO-UPDATE.txt');
  if (files.has('key.pem')) fail('key.pem is in the zip: the private key must never be in a made zip (add it by hand, only for the first store upload)');

  // 6. Licence notices: the file, every listed item has its text, and the big pieces are named.
  if (!files.has('THIRD_PARTY_NOTICES.txt')) fail('missing THIRD_PARTY_NOTICES.txt');
  else {
    const notices = text('THIRD_PARTY_NOTICES.txt');
    const count = Number(/^CONTENTS \((\d+) items\)$/m.exec(notices)?.[1] ?? 0);
    const sections = (notices.match(/^={78}$/gm) ?? []).length;
    if (count < 50) fail(`THIRD_PARTY_NOTICES.txt lists only ${count} items`);
    if (sections < count) fail(`THIRD_PARTY_NOTICES.txt lists ${count} items but has ${sections} licence sections`);
    for (const name of ['@embedpdf/pdfium', 'ONNX Runtime', 'all-MiniLM-L6-v2', 'Noto Sans', 'google-sans', 'SQLite', 'react ', 'Apache License']) {
      if (!notices.toLowerCase().includes(name.toLowerCase())) fail(`THIRD_PARTY_NOTICES.txt does not mention ${name}`);
    }
  }

  // 7 and the build's own checks, run again on the unzipped files.
  const sub = (script, args) => spawnSync('node', [join(ext, 'scripts', script), ...args], { encoding: 'utf8' });
  for (const [script, args] of [['check-scripting.mjs', [dir]], ['check-no-cdn.mjs', [dir]]]) {
    const r = sub(script, args);
    if (r.status !== 0) fail(`${script} failed:\n    ${(r.stderr || r.stdout).trim().split('\n').join('\n    ')}`);
  }

  const size = statSync(zipPath).size;
  if (problems.length > 0) {
    console.error(`verify-zip: ${problems.length} problem(s) in ${zipPath}`);
    for (const p of problems.slice(0, 40)) console.error(`  - ${p}`);
    if (problems.length > 40) console.error(`  … and ${problems.length - 40} more`);
    process.exit(1);
  }
  console.log(`verify-zip: OK ${zipPath} (${(size / 2 ** 20).toFixed(1)} MiB, ${files.size} files, version ${manifest.version} "${manifest.version_name}", ${store ? 'id from the store (the same as the fixed one when key.pem went with the first upload)' : `id ${wantId}`})`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

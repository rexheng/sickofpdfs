// Spec R103: only the toolbar menu's click path may use `chrome.scripting`. The popup (the menu, which puts the page reader in the
// tab) and the save-page tab (which reads the article's pictures through it) are that path; nothing else may reach it.
//
// `node scripts/check-scripting.mjs <built extension folder>` fails when any built script that another page, the service worker or
// a content script can load names the scripting API. The lint rule (eslint.config.mjs) stops the usual spellings in the source, but
// lint can be got round: `chrome['scripting']`, `const { scripting } = chrome`, or a dynamic import of webclip/make-pdf.ts from
// another page. The bundle shows them all: the minifier writes `chrome['scripting']` as `chrome.scripting`, keeps the name in a
// destructuring, and puts make-pdf.ts in a chunk that the importing page loads.
//
// How it decides:
// 1. The roots are every HTML page in the build, the service worker and the content scripts (from the manifest).
// 2. A file reaches another when its text names that file (an import, a dynamic import, a modulepreload, a worker's address).
//    Any JavaScript file that no root reaches counts as a root of its own, so it can never pass unseen.
// 3. A script that names the scripting API passes only when it is reached from popup.html or save-page.html, and from nothing else.
import { readdir, readFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';

/** The pages of the toolbar menu's click path (R103). */
const CLICK_PATH = new Set(['popup.html', 'save-page.html']);
/** The scripting API's names: the namespace, and each of its calls that runs code or styles in a page. */
const SCRIPTING = /\b(?:scripting|executeScript|insertCSS|removeCSS|registerContentScripts|updateContentScripts|getRegisteredContentScripts|unregisterContentScripts)\b/g;

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node scripts/check-scripting.mjs <built extension folder>');
  process.exit(2);
}
const root = resolve(dir);

/** Every script and page of the build, by its path inside the build. */
const files = new Map();
for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !/\.(?:m?js|html)$/i.test(entry.name)) continue;
  const path = join(entry.parentPath, entry.name);
  files.set(relative(root, path).split('\\').join('/'), (await readFile(path)).toString('latin1'));
}
const scripts = [...files.keys()].filter((p) => /\.m?js$/i.test(p));

// 1. The roots.
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
const roots = new Set([...files.keys()].filter((p) => p.endsWith('.html')));
const strip = (p) => String(p).replace(/^\/+/, '');
if (manifest.background?.service_worker) roots.add(strip(manifest.background.service_worker));
for (const cs of manifest.content_scripts ?? []) for (const js of cs.js ?? []) roots.add(strip(js));

// 2. Who reaches whom. A file's name (hashed by the bundler, so it is unique) in another file's text is a way to load it.
const named = new Map(scripts.map((p) => [p, basename(p)]));
const edges = new Map();
for (const [from, text] of files) {
  const to = [];
  for (const [p, name] of named) if (p !== from && text.includes(name)) to.push(p);
  edges.set(from, to);
}
const reachedBy = new Map(scripts.map((p) => [p, new Set()]));
const walk = (start) => {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    const at = queue.shift();
    reachedBy.get(at)?.add(start);
    for (const next of edges.get(at) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
};
for (const r of roots) walk(r);
for (const p of scripts) if (reachedBy.get(p).size === 0) walk(p); // loaded some other way: it is its own root

// 3. The scripts that name the scripting API, and who can load them.
const found = [];
let allowed = 0;
for (const p of scripts) {
  const text = files.get(p);
  const hits = [...text.matchAll(SCRIPTING)];
  if (hits.length === 0) continue;
  const by = [...reachedBy.get(p)];
  if (by.length > 0 && by.every((r) => CLICK_PATH.has(r))) {
    allowed++;
    continue;
  }
  const at = hits[0].index ?? 0;
  found.push(`${p} (loaded by ${by.join(', ')}): …${text.slice(Math.max(0, at - 50), at + 50).replace(/\s+/g, ' ')}…`);
}

if (found.length > 0) {
  console.error(`check-scripting: ${found.length} script(s) outside the toolbar menu's click path name chrome.scripting (spec R103):`);
  for (const line of found) console.error(`  ${line}`);
  process.exit(1);
}
if (allowed === 0) {
  // The menu needs the API. A build where nothing names it means this check is reading the wrong folder or the wrong names.
  console.error(`check-scripting: no script in ${dir} names chrome.scripting, not even the toolbar menu's: is this the built extension?`);
  process.exit(1);
}
console.log(`check-scripting: only the toolbar menu's click path (${[...CLICK_PATH].join(', ')}) names chrome.scripting in ${dir} (${allowed} script(s))`);

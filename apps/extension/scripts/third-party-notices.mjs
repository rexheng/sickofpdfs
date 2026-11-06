// `node scripts/third-party-notices.mjs` (part of `pnpm assets`, so the start of `build` and `build:e2e`): writes
// apps/extension/public/THIRD_PARTY_NOTICES.txt (gitignored), which WXT copies into the build as THIRD_PARTY_NOTICES.txt.
// Help → About sickofpdfs → "Open-source licences" shows it as a page (src/licences, licences.html). The file lists every
// piece of third-party code, model and font in the extension: its name, version, licence and the full licence text.
//
//   node scripts/third-party-notices.mjs                      writes the file
//   node scripts/third-party-notices.mjs --check <folder>     (the end of `build`) fails when <folder>/THIRD_PARTY_NOTICES.txt
//                                                             is missing, or is not what the generator writes now
//
// No network: this script reads node_modules, the files in apps/extension/third-party/ and a few licence files in this
// repository, and nothing else. It never fetches anything.
//
// Where the entries come from
//  - npm packages are found from the dependency tree: the `dependencies` of apps/extension and, through every `workspace:`
//    link, of packages/core, ui and viewer, followed to the bottom. A new dependency shows up here by itself. The licence
//    text is the package's own LICENSE / COPYING / NOTICE file(s). If a package ships none, the text comes from
//    FALLBACK_TEXTS (the project's repository, saved in third-party/); if there is none of those either, the script stops,
//    so a package can never be listed without its licence.
//  - Rules for the tree (all below, each with its reason): BUILD_ONLY, SHIPPED_DEPENDENCIES and the font packages.
//  - Everything that is not an npm package is listed by hand in manualEntries(): the model, ONNX Runtime's own third-party
//    code (Eigen and others), the libraries inside pdfium.wasm, the emscripten runtime, the SQLite dedication, the icon
//    and the code copied into this project.
//
// Files in apps/extension/third-party/ are verbatim copies of upstream licence files, saved once on 2026-11-01:
//   onnxruntime-LICENSE, onnxruntime-ThirdPartyNotices.txt   https://github.com/microsoft/onnxruntime/tree/v1.31.1
//   eigen-COPYING.MPL2                                       https://github.com/eigen-mirror/eigen/tree/1d8b82b0740839c0de7f1242a3585e3390ff5f33
//   apache-2.0.txt                                           https://www.apache.org/licenses/LICENSE-2.0.txt
//   microsoft-unilm-LICENSE                                  https://github.com/microsoft/unilm (the licence of Microsoft's MiniLM)
//   wxt-LICENSE                                              https://github.com/wxt-dev/wxt
//   sqlite-wasm-LICENSE.md                                   https://github.com/sqlite/sqlite-wasm
//   react-remove-scroll-bar-LICENSE                          https://github.com/theKashey/react-remove-scroll-bar
//   mdi-LICENSE                                              https://github.com/Templarian/MaterialDesign
//   freetype-FTL.TXT                                         https://github.com/freetype/freetype (docs/FTL.TXT)
//   libpng-LICENSE                                           https://github.com/pnggroup/libpng
//   zlib-LICENSE                                             https://github.com/madler/zlib
//   libjpeg-turbo-LICENSE.md, libjpeg-turbo-README.ijg       https://github.com/libjpeg-turbo/libjpeg-turbo
//   openjpeg-LICENSE, lcms-LICENSE, agg-copying, bigint-LICENSE
//                                                            https://github.com/chromium/pdfium (third_party/…, PDFium's own copies)
//   emscripten-LICENSE                                       https://github.com/emscripten-core/emscripten
//   musl-COPYRIGHT                                           https://github.com/emscripten-core/emscripten (system/lib/libc/musl/COPYRIGHT)
//   libcxx-LICENSE.TXT                                       https://github.com/llvm/llvm-project (libcxx/LICENSE.TXT)
//   fontkit-LICENSE                                          https://github.com/foliojs/fontkit (saved 2026-11-06; @pdf-lib/fontkit is
//                                                            Hopding/fontkit, a fork of it that ships no licence file and whose README says MIT)
//   fontkit-bundled-LICENSES.txt                             the LICENSE files of the npm packages built into @pdf-lib/fontkit's
//                                                            dist/fontkit.es.js (buffer, base64-js, ieee754, clone, deep-equal,
//                                                            @pdf-lib/unicode-properties, tiny-inflate), from their npm tarballs
// When ONNX Runtime or the model changes version, the guards in manualEntries() stop the build until these are refreshed.
import { existsSync, realpathSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MINILM_COMMIT, MINILM_FILES, MINILM_REPO } from './fetch-minilm.mjs';

const extensionDir = fileURLToPath(new URL('..', import.meta.url));
const repoDir = join(extensionDir, '../..');
const thirdPartyDir = join(extensionDir, 'third-party');
const NOTICES_NAME = 'THIRD_PARTY_NOTICES.txt';
const outFile = join(extensionDir, 'public', NOTICES_NAME);

// ───────────────────────────────── rules for the dependency tree ─────────────────────────────────

/** Build-time tools that are listed as dependencies but whose code is not in the extension. */
const BUILD_ONLY = new Set(['@wxt-dev/module-react']);

/**
 * Packages of which only the named dependencies are shipped; the rest of their dependencies are not walked.
 *  - wxt is the build tool. Its small runtime helpers are bundled into the extension, and they use these two.
 *  - onnxruntime-web: ort/ort.wasm.min.mjs is a prebuilt file with onnxruntime-common already inside it. The package's
 *    other dependencies (protobufjs, flatbuffers, long, platform, guid-typescript) are not in that file and not shipped.
 *  - katex (Phase 4, maths in Claude's replies): the viewer bundles dist/katex.mjs and its CSS and fonts. Its one
 *    dependency, commander, is for the katex command line only and is not shipped.
 */
const SHIPPED_DEPENDENCIES = {
  wxt: ['@wxt-dev/storage', '@wxt-dev/browser'],
  'onnxruntime-web': ['onnxruntime-common'],
  katex: [],
};

/** What a few packages are for, in plain words. Any other package is listed without this line. */
const WHAT = {
  react: 'Draws the interface.',
  'react-dom': 'Draws the interface.',
  'radix-ui': 'Accessible menus, dialogs and tooltips.',
  '@embedpdf/engines': 'The PDF engine layer: it talks to PDFium in a background worker.',
  '@embedpdf/models': 'Types and helpers shared by the PDF engine layer.',
  '@embedpdf/pdfium': 'PDFium, Google\'s PDF engine, built to WebAssembly (pdf/pdfium.wasm). It reads and draws PDF pages.',
  '@embedpdf/fonts-latin': 'Noto Sans fonts for PDFs that do not carry their own fonts (pdf/NotoSans-*.ttf).',
  '@embedpdf/fonts-sc': 'Noto Sans font for Simplified Chinese text in such PDFs (pdf/NotoSansHans-Regular.otf).',
  '@fontsource-variable/google-sans': 'Google Sans font, for the interface.',
  '@fontsource-variable/google-sans-flex': 'Google Sans Flex font, for the interface.',
  'material-symbols': 'The Material Symbols icon font, for the interface. Its menu_book icon is also drawn into the extension icon.',
  '@sqlite.org/sqlite-wasm': 'SQLite as WebAssembly: keeps your notes and library on this computer.',
  'onnxruntime-web': 'ONNX Runtime for the web: runs the learning filter\'s model on this computer (the files in ort/).',
  'onnxruntime-common': 'Part of ONNX Runtime for the web; it is built into ort/ort.wasm.min.mjs.',
  'hash-wasm': 'Computes the fingerprint of a PDF file.',
  'diff-match-patch': 'Compares text, so a note finds its place again when the text around it changes.',
  wxt: 'The extension build toolkit. A few of its small helpers are inside the extension.',
  '@mozilla/readability': 'Finds the article on a web page when you save the page to your library (it runs in that page, on this computer).',
  'pdf-lib': 'Makes the PDF of a web page you save to your library, on this computer.',
  '@pdf-lib/fontkit': 'Reads the bundled Noto fonts so the PDF of a saved web page has real, selectable text.',
  '@pdf-lib/standard-fonts': 'Part of pdf-lib.',
  '@pdf-lib/upng': 'Part of pdf-lib: reads PNG pictures for the PDF of a saved web page.',
  '@expo-google-fonts/noto-sans-mono':
    'Noto Sans Mono (the Noto Project, SIL Open Font License), for code in the PDF of a saved web page (pdf/NotoSansMono-Regular.ttf). Only that one font file of the package is in the extension.',
  pako: 'Compresses and uncompresses data (for pdf-lib and fontkit).',
  tslib: 'Small helpers that pdf-lib\'s compiled code uses.',
  '@wxt-dev/storage': 'Part of the extension build toolkit (WXT). Small helpers inside the extension.',
  '@wxt-dev/browser': 'Part of the extension build toolkit (WXT). Small helpers inside the extension.',
};

/** The licence line of a package whose package.json says less than its files do. */
const LICENCE_LINE = {
  '@embedpdf/pdfium': 'MIT (the wrapper), Apache-2.0 (PDFium itself)',
};

/** Licence texts for packages that ship no licence file, from the project's own repository (saved in third-party/). */
const FALLBACK_TEXTS = {
  wxt: ['wxt-LICENSE'],
  '@wxt-dev/storage': ['wxt-LICENSE'],
  '@wxt-dev/browser': ['wxt-LICENSE'],
  '@sqlite.org/sqlite-wasm': ['sqlite-wasm-LICENSE.md'],
  'react-remove-scroll-bar': ['react-remove-scroll-bar-LICENSE'],
  'onnxruntime-web': ['onnxruntime-LICENSE'],
  'onnxruntime-common': ['onnxruntime-LICENSE'],
  '@pdf-lib/fontkit': ['fontkit-LICENSE'],
};

// ───────────────────────────────── reading packages ─────────────────────────────────

/** The folder of the installed package `name`, found the way Node finds it from `from`. Null when it is not installed. */
function findPackage(name, from) {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    if (dirname(dir) === dir) return null;
  }
}

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
/** A text file with LF line ends and no blank lines around it. */
const tidy = (text) => text.replace(/\r\n?/g, '\n').replace(/^\s*\n/, '').trimEnd();
const thirdParty = async (file) => tidy(await readFile(join(thirdPartyDir, file), 'utf8'));
const repoFile = async (path) => tidy(await readFile(join(repoDir, path), 'utf8'));

const NOT_A_LICENCE_FILE = /\.(?:[cm]?js|ts|json|map|css|html|png|svg)$/i;
const LICENCE_FILE = /^(?:licen[sc]e|licen[sc]ing|copying|unlicense|notice)(?:[-_.].*)?$/i;

/** The licence files at the top of a package folder, as { label, body }. */
async function licenceFilesOf(dir) {
  const names = (await readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isFile() && LICENCE_FILE.test(e.name) && !NOT_A_LICENCE_FILE.test(e.name))
    .map((e) => e.name)
    .sort();
  return Promise.all(names.map(async (label) => ({ label, body: tidy(await readFile(join(dir, label), 'utf8')) })));
}

/** The licence of a package.json as one string. */
function licenceOf(pkg) {
  const one = (l) => (typeof l === 'string' ? l : l?.type);
  if (pkg.license !== undefined) return one(pkg.license) ?? 'not stated';
  if (Array.isArray(pkg.licenses) && pkg.licenses.length > 0) return pkg.licenses.map(one).join(' OR ');
  return 'not stated';
}

/** A web address for the package: its homepage, else its repository, else its npm page. */
function sourceOf(pkg) {
  if (typeof pkg.homepage === 'string') return pkg.homepage;
  const repository = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  if (typeof repository === 'string') {
    const url = repository.replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/\.git$/, '');
    if (/^https?:\/\//.test(url)) return url;
  }
  return `https://www.npmjs.com/package/${pkg.name}/v/${pkg.version}`;
}

/** The font packages the engine copies into pdf/ (engine-files.json); the other @embedpdf/fonts-* packages are not shipped. */
async function shippedFontPackages() {
  const list = await readJson(join(repoDir, 'packages/viewer/src/backend/embedpdf/engine-files.json'));
  return new Set(list.fonts.map((f) => f.package));
}

/** Every npm package that ships, as entries. Stops when a package has no licence text at all. */
async function npmEntries() {
  const fonts = await shippedFontPackages();
  const seen = new Map(); // "name@version" -> entry
  const missing = [];

  async function visit(name, from) {
    if (BUILD_ONLY.has(name) || name.startsWith('@types/')) return;
    if (name.startsWith('@embedpdf/fonts-') && !fonts.has(name)) return;
    const dir = findPackage(name, from);
    if (dir === null) throw new Error(`third-party-notices: the dependency ${name} (of ${from}) is not installed; run pnpm install`);
    const pkg = await readJson(join(dir, 'package.json'));
    const workspace = pkg.private === true && pkg.name.startsWith('@sop/');
    const key = `${pkg.name}@${pkg.version}`;
    if (seen.has(key)) return;
    seen.set(key, null); // reserved: stops a cycle
    if (!workspace) {
      let texts = await licenceFilesOf(dir);
      if (texts.length === 0) {
        const fallback = FALLBACK_TEXTS[pkg.name] ?? [];
        texts = await Promise.all(fallback.map(async (file) => ({ label: `${file} (from the project's repository)`, body: await thirdParty(file) })));
      }
      if (texts.length === 0) missing.push(key);
      seen.set(key, {
        name: pkg.name,
        version: pkg.version,
        licence: LICENCE_LINE[pkg.name] ?? licenceOf(pkg),
        ...(WHAT[pkg.name] !== undefined ? { what: WHAT[pkg.name] } : {}),
        source: sourceOf(pkg),
        texts,
      });
    }
    for (const dep of SHIPPED_DEPENDENCIES[pkg.name] ?? Object.keys(pkg.dependencies ?? {})) await visit(dep, dir);
  }

  const root = await readJson(join(extensionDir, 'package.json'));
  for (const dep of Object.keys(root.dependencies ?? {})) await visit(dep, extensionDir);
  if (missing.length > 0) {
    throw new Error(`third-party-notices: no licence text for ${missing.join(', ')}. Add the project's licence file to apps/extension/third-party/ and list it in FALLBACK_TEXTS.`);
  }
  return [...seen.values()].filter((e) => e !== null);
}

// ───────────────────────────────── the entries that are not npm packages ─────────────────────────────────

/** The two comment blocks at the top of the SQLite WebAssembly bundle: its licence and the SQLite version. */
async function sqliteHeader() {
  const dir = findPackage('@sqlite.org/sqlite-wasm', extensionDir);
  if (dir === null) throw new Error('third-party-notices: @sqlite.org/sqlite-wasm is not installed');
  const source = await readFile(join(dir, 'dist/index.mjs'), 'utf8');
  const blocks = source.match(/\/\* @preserve[\s\S]*?\*\//g)?.slice(0, 2) ?? [];
  const body = tidy(blocks.join('\n'));
  if (!body.includes('May you do good and not evil')) throw new Error('third-party-notices: the SQLite licence header is no longer at the top of sqlite-wasm/dist/index.mjs');
  return { body, version: /SQLITE_VERSION "([^"]+)"/.exec(body)?.[1] ?? 'unknown' };
}

/** The version of an installed package. */
async function versionOf(name, from) {
  const dir = findPackage(name, from);
  return dir === null ? 'unknown' : (await readJson(join(dir, 'package.json'))).version;
}

const ORT_NOTICES_FOR = '1.31.1';

async function manualEntries() {
  const ort = await versionOf('onnxruntime-web', extensionDir);
  if (ort !== ORT_NOTICES_FOR) {
    throw new Error(
      `third-party-notices: onnxruntime-web is ${ort}, but third-party/onnxruntime-* and the Eigen text are for ${ORT_NOTICES_FOR}. ` +
        'Save LICENSE and ThirdPartyNotices.txt of the new tag, the Eigen commit named in its cmake/deps.txt (COPYING.MPL2), and update ORT_NOTICES_FOR and the Eigen commit here.',
    );
  }
  const sqlite = await sqliteHeader();
  const mdi = await versionOf('@iconify-json/mdi', join(repoDir, 'packages/ui'));
  const apache = await thirdParty('apache-2.0.txt');
  const vocab = MINILM_FILES.find((f) => f.name === 'vocab.txt');
  const model = MINILM_FILES.find((f) => f.name === 'model_quantized.onnx');

  const EIGEN = '1d8b82b0740839c0de7f1242a3585e3390ff5f33';
  const inPdfium = 'Found inside pdf/pdfium.wasm. EmbedPDF does not publish the list or the versions of the libraries in its PDFium build, so the version is not known; the licence text is the library\'s current upstream text.';

  return [
    // ── ONNX Runtime
    {
      name: 'ONNX Runtime, third-party components',
      version: ort,
      licence: 'various, see the text',
      what: 'The other open-source code that ONNX Runtime is built from, as Microsoft lists it for the release (MIT, BSD, Apache-2.0, MPL-2.0 and others). Microsoft publishes one list for all builds of ONNX Runtime; the WebAssembly build in ort/ contains part of it (Eigen, protobuf, abseil, RE2, XNNPACK and others).',
      source: `https://github.com/microsoft/onnxruntime/blob/v${ort}/ThirdPartyNotices.txt`,
      texts: [{ label: 'ThirdPartyNotices.txt', body: await thirdParty('onnxruntime-ThirdPartyNotices.txt') }],
    },
    {
      name: 'Eigen',
      version: `3.4 (commit ${EIGEN.slice(0, 7)})`,
      licence: 'MPL-2.0',
      what: 'Linear algebra code compiled into ONNX Runtime (ort/ort-wasm-simd-threaded.wasm).',
      source: `https://github.com/eigen-mirror/eigen/tree/${EIGEN}`,
      notes: [
        `This is the Eigen commit that ONNX Runtime ${ort} is built with: ${EIGEN}.`,
        'Eigen is licensed under the Mozilla Public License 2.0. Its source code is available at the address above.',
      ],
      texts: [{ label: 'COPYING.MPL2', body: await thirdParty('eigen-COPYING.MPL2') }],
    },
    // ── The model
    {
      name: 'all-MiniLM-L6-v2 (int8 ONNX model)',
      version: `revision ${MINILM_COMMIT.slice(0, 7)}`,
      licence: 'Apache-2.0',
      what: 'The small language model the learning filter uses to break ties (models/minilm/). It runs on this computer only.',
      source: `https://huggingface.co/${MINILM_REPO}/tree/${MINILM_COMMIT}`,
      notes: [
        `Repository: ${MINILM_REPO}, revision ${MINILM_COMMIT}.`,
        'Model by the Sentence-Transformers project (sentence-transformers/all-MiniLM-L6-v2); int8 ONNX export by Xenova. The model cards of both state Apache-2.0.',
        `Files: ${MINILM_FILES.map((f) => `${f.name} (sha256 ${f.sha256})`).join('; ')}.`,
        `${vocab?.name ?? 'vocab.txt'} is the same word list as google-bert/bert-base-uncased (Google, Apache-2.0).`,
        `all-MiniLM-L6-v2 was trained from the MiniLM base model listed next; ${model?.name ?? 'model_quantized.onnx'} is its int8 ONNX export.`,
      ],
      texts: [{ label: 'Apache License 2.0', body: apache }],
    },
    {
      name: 'MiniLM-L6-H384-uncased (the base of all-MiniLM-L6-v2)',
      version: 'unknown',
      licence: 'MIT',
      what: 'The pre-trained model that all-MiniLM-L6-v2 was trained from. It is a 6-layer version of Microsoft\'s MiniLM.',
      source: 'https://huggingface.co/nreimers/MiniLM-L6-H384-uncased',
      notes: [
        'This is nreimers/MiniLM-L6-H384-uncased, made from microsoft/MiniLM-L12-H384-uncased by keeping every second layer.',
        'Both model cards state the MIT licence. The text is the licence of Microsoft\'s repository the model comes from.',
      ],
      texts: [{ label: 'microsoft/unilm LICENSE', body: await thirdParty('microsoft-unilm-LICENSE') }],
    },
    // ── SQLite
    {
      name: 'SQLite',
      version: sqlite.version,
      licence: 'Public domain',
      what: 'The database engine inside sqlite3.wasm. The authors have dedicated it to the public domain.',
      source: 'https://www.sqlite.org/copyright.html',
      notes: ['The text is the notice at the top of the SQLite WebAssembly bundle that ships in the extension.'],
      texts: [{ label: 'notice in @sqlite.org/sqlite-wasm', body: sqlite.body }],
    },
    // ── What PDFium is built from
    {
      name: 'FreeType',
      version: 'unknown',
      licence: 'FTL',
      what: 'Reads font files and draws their letters, inside PDFium.',
      source: 'https://freetype.org/',
      notes: [
        inPdfium,
        'FreeType can be used under the FreeType Project License (FTL) or the GPLv2. PDFium\'s source lists it under the FTL, and so does this notice.',
        'Portions of this software are copyright (c) The FreeType Project (www.freetype.org). All rights reserved.',
      ],
      texts: [{ label: 'docs/FTL.TXT', body: await thirdParty('freetype-FTL.TXT') }],
    },
    {
      name: 'libjpeg-turbo',
      version: 'unknown',
      licence: 'IJG, BSD-3-Clause, Zlib',
      what: 'Reads JPEG pictures inside PDFs, inside PDFium.',
      source: 'https://libjpeg-turbo.org/',
      notes: [inPdfium],
      texts: [
        { label: 'LICENSE.md', body: await thirdParty('libjpeg-turbo-LICENSE.md') },
        { label: 'README.ijg', body: await thirdParty('libjpeg-turbo-README.ijg') },
      ],
    },
    {
      name: 'libpng',
      version: 'unknown',
      licence: 'libpng-2.0',
      what: 'Reads and writes PNG pictures, inside PDFium.',
      source: 'https://libpng.org/',
      notes: [inPdfium],
      texts: [{ label: 'LICENSE', body: await thirdParty('libpng-LICENSE') }],
    },
    {
      name: 'zlib',
      version: 'unknown',
      licence: 'Zlib',
      what: 'Unpacks compressed data in PDFs, inside PDFium.',
      source: 'https://zlib.net/',
      notes: [inPdfium],
      texts: [{ label: 'LICENSE', body: await thirdParty('zlib-LICENSE') }],
    },
    {
      name: 'OpenJPEG',
      version: 'unknown',
      licence: 'BSD-2-Clause',
      what: 'Reads JPEG 2000 pictures inside PDFs, inside PDFium.',
      source: 'https://www.openjpeg.org/',
      notes: [inPdfium],
      texts: [{ label: 'LICENSE (PDFium\'s copy)', body: await thirdParty('openjpeg-LICENSE') }],
    },
    {
      name: 'Little CMS (lcms2)',
      version: 'unknown',
      licence: 'MIT',
      what: 'Colour management for ICC colour profiles, inside PDFium.',
      source: 'https://www.littlecms.com/',
      notes: [inPdfium],
      texts: [{ label: 'LICENSE (PDFium\'s copy)', body: await thirdParty('lcms-LICENSE') }],
    },
    {
      name: 'Anti-Grain Geometry (AGG)',
      version: '2.3',
      licence: 'AGG 2.3 licence',
      what: 'Draws the shapes of a PDF page, inside PDFium.',
      source: 'https://sourceforge.net/projects/agg/',
      notes: ['A permissive licence (PDFium\'s README.pdfium for it says MIT). Listed because PDFium\'s own build includes it; it has no readable text inside pdfium.wasm to confirm it.'],
      texts: [{ label: 'third_party/agg23/copying (PDFium\'s copy)', body: await thirdParty('agg-copying') }],
    },
    {
      name: 'BigInteger library (Matt McCutchen)',
      version: 'unknown',
      licence: 'Public domain',
      what: 'Big-number arithmetic, inside PDFium.',
      source: 'https://mattmccutchen.net/bigint/',
      notes: ['Listed because PDFium\'s own build includes it; it has no readable text inside pdfium.wasm to confirm it. It asks for no notice.'],
      texts: [{ label: 'third_party/bigint/LICENSE (PDFium\'s copy)', body: await thirdParty('bigint-LICENSE') }],
    },
    // ── What the WebAssembly files were built with
    {
      name: 'Emscripten runtime libraries (Emscripten, musl libc, libc++)',
      version: 'unknown',
      licence: 'MIT, NCSA, Apache-2.0 with LLVM Exception',
      what: 'The runtime that the Emscripten compiler puts into WebAssembly files. The PDFium, SQLite and ONNX Runtime files were built with it.',
      source: 'https://emscripten.org/',
      notes: ['Emscripten and its glue code: MIT and NCSA. musl libc: MIT. libc++: Apache-2.0 with LLVM Exceptions. Found in pdfium.wasm, sqlite3.wasm and ort-wasm-simd-threaded.wasm; the versions are not known.'],
      texts: [
        { label: 'Emscripten LICENSE', body: await thirdParty('emscripten-LICENSE') },
        { label: 'musl COPYRIGHT', body: await thirdParty('musl-COPYRIGHT') },
        { label: 'libc++ LICENSE.TXT', body: await thirdParty('libcxx-LICENSE.TXT') },
      ],
    },
    // ── Icons
    {
      name: 'Material Design Icons: file-pdf-box',
      version: `${mdi} (@iconify-json/mdi)`,
      licence: 'Apache-2.0',
      what: 'The PDF file icon in the library (packages/ui/src/icons/file-pdf-box.ts).',
      source: 'https://pictogrammers.com/library/mdi/',
      texts: [
        { label: 'LICENSE (Pictogrammers Free License)', body: await thirdParty('mdi-LICENSE') },
        { label: 'Apache License 2.0', body: apache },
      ],
    },
    // ── What @pdf-lib/fontkit is built from (its dist file has these packages inside it)
    {
      name: '@pdf-lib/fontkit, built-in libraries',
      version: await versionOf('@pdf-lib/fontkit', extensionDir),
      licence: 'MIT, BSD-3-Clause, ISC',
      what: 'Code that @pdf-lib/fontkit\'s bundle contains: font table parsing, Unicode data, decompression and Node.js shims.',
      source: 'https://github.com/Hopding/fontkit',
      notes: [
        'Inside dist/fontkit.es.js: buffer, base64-js, ieee754 (BSD-3-Clause), clone, deep-equal, @pdf-lib/unicode-properties, tiny-inflate, ' +
          '@pdf-lib/restructure, @pdf-lib/brotli, dfa and unicode-trie (MIT), and the events and process shims of rollup-plugin-node-builtins (ISC) ' +
          'and rollup-plugin-node-globals (MIT).',
        '@pdf-lib/restructure, @pdf-lib/brotli, dfa and unicode-trie (Devon Govett) and the two rollup shims ship no licence file; their package.json states the licence. ' +
          'fontkit\'s own MIT text (Devon Govett) is listed with @pdf-lib/fontkit.',
      ],
      texts: [{ label: 'the LICENSE files of the packages that ship one', body: await thirdParty('fontkit-bundled-LICENSES.txt') }],
    },
    // ── Code copied into this project
    {
      name: 'pdf.js: text layer',
      version: 'commit 743102c',
      licence: 'Apache-2.0',
      what: 'The code that puts selectable text over a page (packages/viewer/src/text-layer/), ported from pdf.js.',
      source: 'https://github.com/mozilla/pdf.js',
      notes: ['Copyright 2015 Mozilla Foundation.'],
      texts: [{ label: 'packages/viewer/src/text-layer/LICENSE.pdfjs', body: await repoFile('packages/viewer/src/text-layer/LICENSE.pdfjs') }],
    },
    {
      name: 'pdf.js: Chromium extension helpers',
      version: 'unknown',
      licence: 'Apache-2.0',
      what: 'The code that takes over PDF links (apps/extension/src/background/takeover/), adapted from pdf.js.',
      source: 'https://github.com/mozilla/pdf.js/tree/master/extensions/chromium',
      notes: ['Copyright 2012 and 2015 Mozilla Foundation.'],
      texts: [{ label: 'apps/extension/src/background/takeover/LICENSE.pdfjs', body: await repoFile('apps/extension/src/background/takeover/LICENSE.pdfjs') }],
    },
    {
      name: 'approx-string-match',
      version: '2.0.1',
      licence: 'MIT',
      what: 'Finds the closest match of a quote in text, so a note finds its place again (packages/core/src/anchoring/vendor/).',
      source: 'https://github.com/robertknight/approx-string-match-js',
      texts: [{ label: 'LICENSE.approx-string-match', body: await repoFile('packages/core/src/anchoring/vendor/LICENSE.approx-string-match') }],
    },
    {
      name: 'Hypothesis client: match-quote',
      version: 'unknown',
      licence: 'BSD-2-Clause, MIT',
      what: 'Scores the matches for a quote and its context (packages/core/src/anchoring/vendor/match-quote.ts).',
      source: 'https://github.com/hypothesis/client',
      notes: ['BSD-2-Clause for the client; the file also covers an MIT-licensed subcomponent (the annotator).'],
      texts: [{ label: 'LICENSE.hypothesis', body: await repoFile('packages/core/src/anchoring/vendor/LICENSE.hypothesis') }],
    },
  ];
}

// ───────────────────────────────── the file ─────────────────────────────────

const RULE = '='.repeat(78);
const THIN = '-'.repeat(78);

/** The whole text of THIRD_PARTY_NOTICES.txt. The same packages always give the same text. */
export async function buildNotices() {
  const manifest = await readJson(join(extensionDir, 'package.json'));
  const entries = [...(await npmEntries()), ...(await manualEntries())].sort((a, b) => {
    const [x, y] = [a.name.toLowerCase(), b.name.toLowerCase()];
    return x < y ? -1 : x > y ? 1 : a.version < b.version ? -1 : a.version > b.version ? 1 : 0;
  });

  const lines = [
    // A byte order mark first: Chrome shows a plain .txt file from an extension as Windows-1252 unless it says UTF-8, and the
    // licence texts have letters like © and é in them.
    '\uFEFFTHIRD-PARTY NOTICES',
    `sickofpdfs ${manifest.version}`,
    '',
    'sickofpdfs is built on other people\'s open-source work. This file lists each piece of',
    'third-party code, model and font that is inside the extension. For each one it gives the',
    'name, the version, the licence and the full licence text.',
    '',
    'This file is part of the extension. It is never sent anywhere.',
    '',
    'What is listed',
    '  - The code libraries the extension is built from, found from its dependencies.',
    '  - The PDF engine (PDFium) and the libraries inside it.',
    '  - The machine-learning runtime (ONNX Runtime) and the small model the learning filter uses.',
    '  - Fonts and icons.',
    '  - Code that was copied into this project from other projects.',
    'A library can be listed here even if the build uses only part of it. That is on purpose: the',
    'list should never miss something.',
    '',
    `CONTENTS (${entries.length} items)`,
    ...entries.map((e, i) => `  ${String(i + 1).padStart(3)}. ${e.name}${e.version === 'unknown' ? '' : ` ${e.version}`}  [${e.licence}]`),
    '',
  ];

  entries.forEach((e, i) => {
    lines.push(RULE, `${i + 1}. ${e.name}`, `Version: ${e.version}`, `Licence: ${e.licence}`);
    if (e.what !== undefined) lines.push(`What it is: ${e.what}`);
    if (e.source !== undefined) lines.push(`Source: ${e.source}`);
    for (const note of e.notes ?? []) lines.push(`Note: ${note}`);
    for (const text of e.texts) lines.push('', THIN, `Licence text: ${text.label}`, THIN, text.body);
    lines.push('');
  });
  lines.push(RULE, 'End of third-party notices.', '');
  return lines.join('\n');
}

/** Writes apps/extension/public/THIRD_PARTY_NOTICES.txt (left alone when it already holds the same text). */
export default async function writeNotices() {
  const text = await buildNotices();
  const before = await readFile(outFile, 'utf8').catch(() => null);
  if (before !== text) await writeFile(outFile, text);
  const count = /^CONTENTS \((\d+) items\)$/m.exec(text)?.[1];
  console.log(`third-party notices: ${count} items, ${(Buffer.byteLength(text) / 2 ** 10).toFixed(0)} KiB in apps/extension/public/${NOTICES_NAME}`);
}

/** Fails when `folder`/THIRD_PARTY_NOTICES.txt is missing or is not the file the generator writes now. */
async function check(folder) {
  const shipped = await readFile(join(folder, NOTICES_NAME), 'utf8').catch(() => null);
  if (shipped === null) throw new Error(`${folder} has no ${NOTICES_NAME}`);
  if (shipped !== (await buildNotices())) throw new Error(`${folder}/${NOTICES_NAME} is not what the generator writes now; run the build again`);
  console.log(`third-party notices: ${folder}/${NOTICES_NAME} is complete and current`);
}

// Run as a script (`node scripts/third-party-notices.mjs [--check <folder>]`), not when imported.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const at = process.argv.indexOf('--check');
    if (at === -1) await writeNotices();
    else {
      const folder = process.argv[at + 1];
      if (!folder) throw new Error('usage: node scripts/third-party-notices.mjs --check <built extension folder>');
      await check(folder);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

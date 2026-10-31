# sickofpdfs Release 1 · Phase 0 and Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove that PDFium (EmbedPDF 2.15.1) works inside a Chrome MV3 extension within the spec's budgets (Phase 0). Then build the foundations (Phase 1): takeover of every PDF, a Drive-style viewer with reading basics at Chrome's level, the local SQLite store, fingerprint identity and the save decision.

**Architecture:** One pnpm monorepo, with the WXT extension in `apps/extension`: its service worker owns takeover (DNR rules, the `file://` fallback, Referer, the escape hatch), the viewer page draws the PDF, and an offscreen document is the only owner of SQLite-wasm on OPFS, which tabs reach over a MessagePort brokered by the service worker (PDF bytes go straight to OPFS). `packages/viewer` holds the `PdfBackend` adapter, which runs our own engine worker hosting a `PdfiumNative` subclass from EmbedPDF 2.15.1, plus the virtual page list, zoom, find and the text layer. `packages/core` holds pure identity, data-model and save-decision logic, and `packages/ui` holds the Drive tokens, fonts, icons and Radix-based components.

**Tech Stack:** pnpm 10.28.0 workspaces, Node 22, WXT 0.21.5 (Vite 8.3.5), React 19.3.1, TypeScript 6.0.3 (7.0.2 trialled in Phase 0), `@embedpdf/engines`/`pdfium`/`models` 2.15.1 (pinned and patched with `pnpm patch`, the pnpm-native patch-package), `@embedpdf/fonts-latin` and `@embedpdf/fonts-sc` 1.0.0, `@sqlite.org/sqlite-wasm` 3.54.1-build1 (`opfs-sahpool`), hash-wasm 4.12.0, `radix-ui` 1.8.1, `material-symbols` 0.48.2, `@fontsource-variable/google-sans` and `google-sans-flex` 5.3.2, `@iconify-json/mdi` 1.2.3, `diff-match-patch` 1.0.5, `pdf-lib` 1.17.1 (fixtures only), Vitest 5.0.5 (plus `@vitest/browser-playwright` 5.0.5), `@playwright/test` 1.63.0 (it matches the preinstalled Chromium 1243), ESLint 10.14.0, typescript-eslint 8.72.1, `@eslint/css` 2.0.1 and `@axe-core/playwright` 4.14.0.

**Spec:** `docs/superpowers/specs/2026-10-31-sickofpdfs-design.md` (commit 8b3358d). Research: `docs/research/01-pdf-engine.md`, `02-drive-visual-spec.md`, `03-platform-claude.md`, `04-features-classifier.md` and `06-figures-multimodal.md`.

**Scope:** this plan covers Release 1 Phase 0 (engine proof, a throwaway spike in `spikes/phase0/`) and Phase 1 (foundations, production code). Phases 2–4 get their own plans, written after Phase 0's results are known. Task 10 records the decisions those plans depend on.

## Global Constraints

- The product is a Chrome extension only: Manifest V3, `minimum_chrome_version` "128". It takes over every PDF in the same tab.
- The CSP for extension pages is `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`. No remote code is allowed.
- "Every engine file, font and model ships inside the extension; nothing is downloaded." A build test fails on any request other than the PDF itself and allowed calls.
- Pin every dependency to an exact version (`save-exact=true`). EmbedPDF stays pinned at 2.15.1, and every engine call goes through the one `PdfBackend` adapter.
- Use a "fixed extension key we generate ourselves (no Web Store account needed)". Commit the public key only.
- Privacy: "A PDF that isn't saved leaves no history row, thumbnail, search entry or log line." The filter decides in memory before anything is stored.
- "Large data never travels through Chrome's extension messages (limited to about 64 MB); it goes through a direct channel or the file storage."
- Secrets go in a separate store that backups, export and sync cannot read. Content scripts and web pages cannot read it either.
- A document is "the SHA-256 of the file's bytes, computed while it streams in". A stamped re-download becomes an alias when it has the "same page count" and its page text matches "at 99.5% or more after stamp lines, IP addresses and dates are removed". "A location's id is a hash of its canonical link", and "notes get a random id once".
- Speed budgets: first page under 1 s for a 50-page paper; a 600-page scan shows no blank page for more than 150 ms; a mark under 50 ms; the note box under 100 ms; the figure outline under 100 ms after hovering; figure detection never delays drawing a page.
- Budgets are measured on the reference laptop (Windows, stable Chrome, 150% scaling, 20% tolerance). CI runs looser smoke versions.
- Zoom offers fit width, fit page and 25 to 400%. Ctrl+= and Ctrl++ zoom in, Ctrl+− zooms out and Ctrl+0 fits the width. "Ctrl+wheel and pinch zoom the page, not the browser."
- "Single-key and Ctrl+Alt shortcuts never fire while you are typing." Letters are matched by the character they type; only the number row (Alt+Shift+5, 1 to 5) is matched by position.
- Large files: "Up to 1 GB opens normally; larger files (size read from the download header) open in Chrome's viewer with a note."
- "In an Incognito window the extension only views PDFs: no marks, notes or saving."
- "Colours, fonts, icons and spacing come only from the shared token file, taken from Drive. A lint rule blocks raw values." Use Google Sans, Google Sans Text (Google Sans at optical size 17) and Google Sans Flex, plus Material Symbols Outlined at weight 400, all bundled.
- Accessibility: "WCAG 2.2 AA for the interface; the text layer is readable by screen readers."
- "Nothing pops up on its own while you read." The right-click mark-up menu and the mark shortcuts are Phase 2. In Phase 1, a right-click shows Chrome's normal menu.
- The original file is never modified.
- Copied upstream files keep their licence headers. The adapted pdf.js files keep their Apache-2.0 notice and sit next to a copy of pdf.js's `LICENSE`.

## Review Focus

These five are the input classes most likely to hurt a user that no other test would catch. Each one gets a test in the task that owns the code.

1. **The re-fetch fails or returns something that is not a PDF.** Examples: an expiring signed link that works once, a login page served as `application/pdf`, a truncated file. Expected: an error card with "Open in Chrome's viewer" and "Import this PDF", never a blank page or an uncaught error. Tested in Task 20 (`e2e/open.spec.ts`: `once.pdf`, `fake.pdf`, `truncated.pdf`).
2. **Windows-style local file names:** spaces, `#`, `%`, en dashes, NFD accents and an upper-case `.PDF`. Expected: the takeover still fires, and every spelling gets one canonical location. Tested in Task 16 (`e2e/takeover.spec.ts` "awkward file names") and Task 18 (file vectors).
3. **Mixed page sizes and `/Rotate` pages in one file**, such as a landscape slide among portrait pages or a scan page with `/Rotate 90`. Expected: correct page boxes, upright rendering, correct go-to-page targets and text-layer alignment under 1 px. Tested in Task 21 (`mixed.pdf` layout and render) and Task 22 (`rotated-page` alignment).
4. **Fractional Windows scaling** (devicePixelRatio 1.25 or 1.5), and the scaling changing while a document is open. Expected: canvas backing size = round(CSS size × DPR), a re-render within 500 ms of a change, and text-layer error under 1 px at DPR 1.5. Tested in Task 21 and Task 22.
5. **Two tabs saving the same new PDF at once, and the store dying mid-request.** Expected: one document row, one blob, and no lost write. Tested in Task 28 (reconnect replay) and Task 30 (concurrent save, offscreen closed mid-save).

---

## File Structure

```text
spikes/phase0/                         THROWAWAY engine proof (own package and lockfile, outside the workspace)
  package.json  wxt.config.ts  playwright.config.ts  tsconfig.json
  patches/@embedpdf__engines@2.15.1.patch   makes PdfiumNative internals protected for our subclass
  entrypoints/background.ts            offscreen helpers and the MessagePort broker (P0-6)
  entrypoints/spike/index.html, main.ts  runs one check named in ?check=, writes window.__result
  entrypoints/offscreen/index.html, main.ts  receiving end for P0-6
  src/engine/spike-native.ts           PdfiumNative subclass: glyphs, glyph outlines, page objects, struct tree, form info
  src/engine/engine.worker.ts          our file-URL worker: wasm init, bundled fonts, RPC
  src/engine/client.ts                 createFileWorkerEngine / createStockBlobEngine (SpikeEngine)
  src/engine/fonts.ts                  bundled FontFallbackConfig (Latin plus one CJK file)
  src/textlayer/text-layer.ts          port of pdf.js src/display/text_layer.js (Apache-2.0 header kept)
  src/textlayer/items.ts, char-map.ts  PDFium glyphs → text items (drift-split); DOM range → char range
  src/figures/find-figures.ts          minimal objects-plus-captions detector (06 §3.2–3.3)
  src/checks/*.ts                      render, scroll, textlayer, bold, objects, transfer, big-open, forms, backup-folder
  scripts/*.mjs                        fetch-fixtures, make-paper50, make-font-fixture, make-scan-fixture,
                                       make-textlayer-fixtures, make-objects-fixture, make-tagged-fixture, make-big-pdf, report
  fixtures/src/*.html, *.txt           text-layer fixture sources and ground truth
  ts7/                                 TypeScript 7 + typescript-eslint probe
  tests/fixtures.ts, server.mjs, netlog.ts, record.ts, p0-*.spec.ts
docs/spikes/phase0-report.md           one line per check (generated table), plus the Decision section

package.json  pnpm-workspace.yaml  .npmrc  tsconfig.base.json  vitest.config.ts  eslint.config.mjs
.github/workflows/ci.yml               typecheck, lint, unit, browser, build, e2e
patches/@embedpdf__engines@2.15.1.patch  ported from the spike
scripts/fixtures/build.mjs             builds test-assets/ (gitignored): fetches plus generators below
scripts/fixtures/fetch-classifier.mjs  manifest.json → test-assets/classifier/** (sha256 verified)
scripts/fixtures/make-{paper50,scan,mixed,textlayer,objects,tagged,links}.mjs, make-password.py, textlayer-src/
tooling/eslint-plugin-sop/             local ESLint plugin: rule no-raw-design-values (+ RuleTester tests)
e2e/playwright.config.ts
e2e/support/launch.ts                  persistent Chromium with the built extension, a per-test netlog
e2e/support/seed-profile.ts            switches on "Allow access to file URLs" and "Allow in Incognito" once
e2e/support/netlog.ts                  netlogExternalUrls(): the network gate
e2e/support/server.ts, header-cases.ts local HTTP fixture server and its header-case registry
e2e/support/stamped-pdf.ts             JSTOR-style stamped PDF generator (pdf-lib)
e2e/support/test.ts                    Playwright fixtures: context, sw, server, openViewer, hooks
e2e/support/drag-select.ts             mouse-drag selection helper
e2e/support/textlayer-fixtures.ts      text-layer fixture list (name, page, dir, truth)
e2e/*.spec.ts                          one spec per feature area (named in each task)

packages/core/src/
  ids.ts                               Sha256, DocumentId, LocationId, LocationKind brands
  identity/fingerprint.ts              streaming SHA-256 (hash-wasm)
  identity/canonical-link.ts           cleanLink, canonicalLink, canonicalFileLocation
  identity/location.ts                 canonicalLocation, locationId
  identity/stamps.ts                   stripStamps, stampedTextSimilarity, ALIAS_THRESHOLD
  hlc.ts                               hybrid logical clock
  model/anchor.ts, model/rows.ts       normative anchor JSON and row types (schema v1)
  filter/types.ts, filter/stand-in.ts  FilterDecision; the Phase 1 stand-in filter (always "unsure")
  save/save-machine.ts                 pure save-decision reducer
packages/ui/src/
  tokens/tokens.css, tokens-dark.css   Drive GM3 tokens (02 §3) + spacing scale + viewer dimensions
  base.css                             body type, colour, focus ring
  fonts/register.ts                    FontFace registration of the bundled woff2 files
  icons/Icon.tsx, names.ts, file-pdf-box.ts, FileTypeIcon.tsx
  components/{IconButton,TextButton,Tooltip,Menu,MenuBar,Chip,Dialog,Banner,TextField,PillToolbar}.tsx + .module.css
packages/ui/scripts/extract-mdi.mjs    writes icons/file-pdf-box.ts from @iconify-json/mdi
packages/viewer/src/
  backend/types.ts, errors.ts, forms.ts                PdfBackend contract, hasFillableFields
  backend/embedpdf/{sop-native,engine.worker,rpc,fonts,backend}.ts   EmbedPDF implementation
  source/{load-source,errors,limits,file-name}.ts      fetch/XHR/File loading, hashing, size rule
  layout/{zoom,page-layout}.ts                         zoom maths, page boxes
  render/scheduler.ts                                  preview-first render queue
  text-layer/{text-layer,items,char-map}.ts, text-layer.css, LICENSE.pdfjs
  find/find-controller.ts  navigation/jump-history.ts  view/view-state.ts
  react/{PageList,PageView,TextLayer,LinkLayer,ThumbnailRail,OutlinePanel,FindBar,FindHighlights}.tsx, viewer-state.ts
packages/viewer/test/fixtures/password-secret.pdf      committed (we generate it; password "secret")
apps/extension/
  wxt.config.ts  extension-key.pub.txt  scripts/{gen-key,make-icons,extension-id}.mjs  public/icon/{16,32,48,128}.png
  src/shared/{viewer-url,messages}.ts
  src/entrypoints/background.ts  viewer/{index.html,main.tsx}  offscreen/{index.html,main.ts}  embed.content/{index.ts,style.css}
  src/background/takeover/{rules,feature-check,register,file-fallback,request-log,referer,escape,embedded,messages}.ts, LICENSE.pdfjs
  src/background/{offscreen,store-broker}.ts
  src/store/{schema,migrate,store-api,protocol,store-worker,client,transport,change-bus,blob-store,local-only}.ts
  src/viewer/App.tsx, test-hooks.ts, open-document.ts, frame-escape.ts, back-to-page.ts, shortcuts.ts, commands.ts, incognito.ts, presentation.ts
  src/viewer/chrome/{Header,Toolbar,ShortcutsDialog,AboutDialog}.tsx, menus.ts
  src/viewer/actions/{download,copy-link}.ts   src/viewer/print/{print.ts,print.css,PrintProgressDialog.tsx}
  src/viewer/ui/{LoadErrorCard,PasswordDialog,FileAccessDialog,LargeFileNotice}.tsx
  src/viewer/identity/resolve-identity.ts  src/viewer/save/{save-controller.ts,StatusChip.tsx,SaveAskDialog.tsx}
  src/viewer/forms/{form-bounce.ts,FormBanner.tsx}
apps/cloud/package.json                placeholder only (Release 2)
docs/checklists/phase1-windows.md, phase1-gate.md
```

Tests sit next to their source: `*.test.ts` (Node, Vitest project `unit`), `*.browser.test.ts(x)` (real Chromium, Vitest project `browser`) and `e2e/*.spec.ts` (Playwright with the built extension).

## Feature-to-phase table (Release 1)

| Feature | Phase |
| --- | --- |
| Engine proof: MV3 workers, bundled files, network, 600-page scan, selection suite, bold outlines, 300 MB moves, 1 GB limit, form detection, backup permission, page objects to figures in 20 ms, TS 7 | 0 |
| Takeover: links, DNR with the Chrome 128 check, `file://` fallback, Referer, embeds with "Back to page", form-post exclusion, "Open in Chrome's viewer", form-PDF bounce, large-file rule | 1 |
| Viewer: header menus, pill toolbar, virtual pages, zoom modes and keys, thumbnails and outline rail, links, find, go to page, rotate, two-page, presentation, dark pages, print (no marks), download / Ctrl+S, copy link, password PDFs, text layer and copy, shortcut sheet (?) | 1 |
| Local store (schema v1, offscreen owner, OPFS blobs, change events), secrets store, fingerprint identity, canonical links, stamp aliases, locations | 1 |
| Save decision with the stand-in filter, status chip, Ctrl+Alt+S, Undo after a first-mark save, Incognito view-only | 1 |
| Right-click mark-up menu; highlight, underline, bold, strikethrough, colours; comments and threads; Ctrl+Alt+M flow; drafts that survive a crash; re-anchoring; figure detection, figure comments, pins, Alt+drag areas; Figures tab; notes panel; next/previous note; undo/redo; print with marks; tabs in step | 2 |
| Real learning filter (+MiniLM), "not sure" banner after 20 s, never-save list, allow/deny lists, Forget; history and resume; library pages; Ctrl+K search; Settings; Markdown export; backup folder, badge and restore; Export library zip; arXiv/Crossref lookups | 3 |
| @Claude in threads (passages, figures, web search, models, cost caps); polish; SETUP.md; release on GitHub | 4 |

## Conventions

- **Commands:** run from the repo root with Node 22 and pnpm. Playwright always uses the preinstalled Chromium (`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`); never run `playwright install` locally. CI installs Chromium in the workflow only.
- **Spike commands:** `pnpm -C spikes/phase0 <script>`.
- **Monorepo commands:** `pnpm vitest run <file>` (unit and browser tests); `pnpm e2e <spec>` (builds the extension in `test` mode, then runs Playwright); `pnpm fixtures` (builds `test-assets/`).
- **Test hooks:** e2e reads viewer internals only through `globalThis.__sopTest` (`SopTestHooks`, `apps/extension/src/viewer/test-hooks.ts`). It is installed only when `import.meta.env.MODE === 'test'` (from `wxt build --mode test`). Task 12 adds a build test proving that production output contains no `__sopTest`.
- **Performance marks** are part of the product, not test hooks: `sop:first-page` and `sop:blank:<pageIndex>`.
- **Fixtures:** `SOP_FIXTURE_SRC` defaults to `/tmp/claude-0/-home-user/24aa939a-b5a9-56a1-a55e-601726feabba/scratchpad/research/classifier-fixtures`. A file missing there is downloaded from its manifest `url`, and every file is checked against its manifest `sha256`. `test-assets/` and `spikes/phase0/fixtures/out/` are gitignored.
- **Commits:** conventional messages. Stage only the task's files.

---

# Phase 0 · Engine proof (throwaway spike)

Every check writes `spikes/phase0/results/P0-<n>.json` through `record()`, which appends, so a check run several times (per engine, zoom or worker count) keeps every measurement. `node scripts/report.mjs` rebuilds the results table in `docs/spikes/phase0-report.md`, between `<!-- results:start -->` and `<!-- results:end -->`. Each check gets one row: `| P0-n | name | PASS/FAIL/BLOCKED | measured | notes |`.

### Task 1: Spike harness, P0-1 EmbedPDF rendering in MV3, P0-2 zero network

**Files:**
- Create: `spikes/phase0/package.json`, `wxt.config.ts`, `tsconfig.json`, `playwright.config.ts`, `patches/@embedpdf__engines@2.15.1.patch`
- Create: `spikes/phase0/entrypoints/background.ts`, `entrypoints/spike/index.html`, `entrypoints/spike/main.ts`
- Create: `spikes/phase0/src/engine/{spike-native.ts,engine.worker.ts,client.ts,fonts.ts}`, `src/checks/render.ts`
- Create: `spikes/phase0/scripts/{fetch-fixtures.mjs,make-paper50.mjs,make-font-fixture.mjs,report.mjs}`
- Create: `spikes/phase0/tests/{fixtures.ts,server.mjs,netlog.ts,record.ts,p0-1-render.spec.ts,p0-2-network.spec.ts}`
- Create: `docs/spikes/phase0-report.md`
- Modify: `.gitignore` (add `spikes/phase0/fixtures/out/`, `spikes/phase0/results/`, `test-assets/`, `*.pem`)

**Interfaces:**
- Consumes: nothing.
- Produces (used by Tasks 2–9):
```ts
// src/engine/client.ts
export interface SpikeEngine {
  open(url: string, password?: string): Promise<{ docId: string; pageCount: number; pages: { width: number; height: number }[] }>;
  render(docId: string, pageIndex: number, scale: number, rect?: { x: number; y: number; width: number; height: number }): Promise<ImageBitmap>;
  call<T>(method: string, ...args: unknown[]): Promise<T>; // any SpikeNative method by name
  close(docId: string): Promise<void>;
}
export function createFileWorkerEngine(opts?: { workers?: 1 | 2 }): Promise<SpikeEngine>;
export function createStockBlobEngine(): Promise<SpikeEngine>; // @embedpdf/engines createPdfiumWorkerEngine (blob workers)
// src/engine/spike-native.ts
export class SpikeNative extends PdfiumNative { fontRequests(): string[] }
// tests/record.ts, tests/netlog.ts, tests/fixtures.ts
export function record(id: `P0-${number}`, r: { pass: boolean | 'blocked'; measured: string; note?: string }): Promise<void>;
export function readNetlogUrls(path: string): Promise<string[]>;
export const test: TestType<{
  server: { url(p: string): string };
  spikePage(q: Record<string, string | number>, o?: { timeout?: number }): Promise<any>;   // opens spike.html?…, resolves window.__result
  launchSpike(o: { netlog?: boolean; profile?: string }): Promise<{ context: BrowserContext; page: Page; netlogPath: string; openSpike(q: Record<string, string | number>): Promise<any> }>;
}, {}>;
// per-check wrappers over spikePage, added by Tasks 3, 5 and 7: textlayerPage(f, zoom), objectsPage(file, pageIndex, opts?), formsPage(path)
```

- [ ] **Step 1: Scaffold the spike and fixtures**

  Create `package.json` with these exact pins: `wxt` 0.21.5, `@embedpdf/engines` 2.15.1, `@embedpdf/pdfium` 2.15.1, `@embedpdf/models` 2.15.1, `@embedpdf/fonts-latin` 1.0.0, `@embedpdf/fonts-sc` 1.0.0, `hash-wasm` 4.12.0, `pdf-lib` 1.17.1, `jpeg-js` 0.4.4, `@playwright/test` 1.63.0 and `typescript` 6.0.3.

  Scripts:
  - `"build": "wxt build"`
  - `"fixtures": "node scripts/fetch-fixtures.mjs && node scripts/make-paper50.mjs && node scripts/make-font-fixture.mjs"`
  - `"report": "node scripts/report.mjs"`

  Fixture scripts:
  - `fetch-fixtures.mjs` copies the manifest items into `fixtures/out/classifier/<path>` and verifies `sha256`.
  - `make-paper50.mjs` writes `fixtures/out/paper-50.pdf`: pages 1–50 of `learning/nber-w29000.pdf`, copied with pdf-lib `copyPages`.
  - `make-font-fixture.mjs` hand-writes `fixtures/out/font-fixture.pdf`. It is one page with two non-embedded fonts:
    - a `/TrueType /Calibri` font with WinAnsi text `Résumé naïve`;
    - a `/Type0` font with `/Encoding /UniJIS-UCS2-H`, CIDSystemInfo Adobe-Japan1 and text 日本語.

  Create `wxt.config.ts`:
  - the manifest has CSP `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`, `minimum_chrome_version` "128" and permissions `["offscreen"]`;
  - the `build:publicAssets` hook copies `pdfium.wasm` (`@embedpdf/pdfium/pdfium.wasm`), `NotoSans-{Regular,Italic,Bold,BoldItalic}.ttf` from `@embedpdf/fonts-latin/fonts/` and `NotoSansHans-Regular.otf` from `@embedpdf/fonts-sc/fonts/` into `pdf/`.

  Create `pnpm patch @embedpdf/engines@2.15.1`. It changes `private pdfiumModule` and `private cache` to `protected` in `dist/lib/pdfium/engine.d.ts` (types only; JS is unchanged), and is recorded in `pnpm.patchedDependencies`.

- [ ] **Step 2: Write the failing tests**

```ts
// tests/p0-1-render.spec.ts
for (const engine of ['v2-blob', 'v2-file'] as const) {
  test(`P0-1 ${engine}: paper-50 page 1 renders inside the extension page with bundled wasm and fonts`, async ({ spikePage, server }) => {
    const r = await spikePage({ check: 'render', engine, file: server.url('paper-50.pdf'), fonts: server.url('font-fixture.pdf') });
    expect(r.error).toBeNull();
    expect(r.cspViolations).toEqual([]);
    expect(r.pageCount).toBe(50);
    expect(r.inkFraction).toBeGreaterThan(0.02);              // share of non-white pixels on page 1
    expect(r.fontRequests.length).toBeGreaterThan(0);
    expect(r.fontRequests.every((u: string) => u.startsWith('chrome-extension://'))).toBe(true);
    expect(r.fontFixtureInkFraction).toBeGreaterThan(0.005);  // Calibri + Japanese text drawn from the bundled fallbacks
    await record('P0-1', { pass: true, measured: `${engine} first page ${r.firstPageMs} ms` });
  });
}
// tests/p0-2-network.spec.ts
test('P0-2: nothing leaves the browser except the two PDF fetches', async ({ launchSpike, server }) => {
  const { context, netlogPath, openSpike } = await launchSpike({ netlog: true });
  await openSpike({ check: 'render', engine: 'v2-file', file: server.url('paper-50.pdf'), fonts: server.url('font-fixture.pdf') });
  await context.close();
  const urls = (await readNetlogUrls(netlogPath)).filter((u) => /^(https?|wss?):/.test(u));
  expect(urls.map((u) => new URL(u).host).every((h) => h === new URL(server.url('/')).host)).toBe(true);
  expect([...new Set(urls.map((u) => new URL(u).pathname))].sort()).toEqual(['/font-fixture.pdf', '/paper-50.pdf']);
});
```
  The fixture launches `chromium.launchPersistentContext` with `--disable-extensions-except` and `--load-extension` pointing at `.output/chrome-mv3`, plus `--log-net-log=<results>/netlog-<test>.json` when `netlog` is set. `server.mjs` serves `fixtures/out/` on `127.0.0.1:<random port>`.

- [ ] **Step 3: Run them and confirm they fail.** Run: `pnpm -C spikes/phase0 install && pnpm -C spikes/phase0 fixtures && pnpm -C spikes/phase0 build && pnpm -C spikes/phase0 exec playwright test tests/p0-1-render.spec.ts tests/p0-2-network.spec.ts`. Expected: FAIL (`window.__result` is never set, because `src/checks/render.ts` does not exist yet).

- [ ] **Step 4: Implement the engine variants and the render check**
  - `engine.worker.ts`:
    - on `{type:'init', wasmUrl, fontBaseUrl}`, it fetches the wasm, calls `init({ wasmBinary })` from `@embedpdf/pdfium`, and constructs `new SpikeNative(module, { fontFallback: bundledFontFallback(fontBaseUrl) })`;
    - then it serves `{id, method, args}` by calling `native[method](...args)`, awaiting `PdfTask.toPromise()` when needed;
    - render requests return an `ImageBitmap` from `createImageBitmap(new ImageData(...))`, transferred.
  - `bundledFontFallback`:
    - `defaultFont` is the 4 NotoSans variants;
    - `fonts[SHIFTJIS|HANGEUL|GB2312|CHINESEBIG5]` is `NotoSansHans-Regular.otf`;
    - a `fontLoader` records each URL in `fontRequests()` and fetches it.
  - `createStockBlobEngine` calls `createPdfiumWorkerEngine(chrome.runtime.getURL('pdf/pdfium.wasm'), { fontFallback })`.
  - `checks/render.ts`:
    - listens for `securitypolicyviolation`;
    - opens the file;
    - renders page 1 at scale 1.5 into a canvas and measures the ink fraction;
    - does the same for `fonts`;
    - writes `window.__result`.
  - If **both** v2 variants fail, add `src/engine/v3.ts` on `@embedpdf/engine@3.0.0-next.19`. Use `engine: { worker, encoderWorker, wasmUrl }` with extension URLs, as in v3's `docs/content/viewer/self-hosting.mdx`, and re-run with `engine: 'v3-file'` added to the loop.

- [ ] **Step 5: Run them again and confirm they pass.** Run: `pnpm -C spikes/phase0 build && pnpm -C spikes/phase0 exec playwright test tests/p0-1-render.spec.ts tests/p0-2-network.spec.ts`. Expected: PASS for `v2-file` and for P0-2. Record `v2-blob` as it comes out, PASS or FAIL. A blob failure is information, not a blocker.

- [ ] **Step 6: Write the report and commit**
```bash
pnpm -C spikes/phase0 report
git add .gitignore spikes/phase0 docs/spikes/phase0-report.md
git commit -m "test(spike): P0-1 EmbedPDF renders in MV3 with bundled files, P0-2 zero network"
```

### Task 2: P0-3 600-page scanned PDF scrolls with no blank page over 150 ms

**Files:**
- Create: `spikes/phase0/scripts/make-scan-fixture.mjs`, `src/checks/scroll.ts`, `tests/p0-3-scroll.spec.ts`

**Interfaces:**
- Consumes: `createFileWorkerEngine({ workers })` and `SpikeEngine.render` (Task 1).
- Produces: `fixtures/out/scan-600.pdf`. The Phase 1 port is `scripts/fixtures/make-scan.mjs` (same CLI).

- [ ] **Step 1: Write the fixture synthesiser**

  CLI: `node scripts/make-scan-fixture.mjs --source <pdf> --pages 600 --dpi 200 --quality 60 --out fixtures/out/scan-600.pdf`. It prints the byte size. The algorithm is not fixed by the CLI, so here it is:
```text
for i in 0..pages-1:
  src = sourcePage(i mod sourcePageCount)              # PdfiumNative in Node: renderPageRaw at scaleFactor dpi/72
  grey = luminance(src)
  grey = rotateNearest(grey, skewDeg = (((i*7919) mod 13) - 6) / 10)     # −0.6°..+0.6°
  grey = grey + noise(seed=i, amplitude=8) ; darken a 2% gutter strip on the binding side (left if i even)
  jpeg = jpegjs.encode(grey as RGBA, quality)
  pdf-lib: addPage([612, 792]); embedJpg(jpeg); drawImage over the full page; no text objects
```
  The source is `fixtures/out/classifier/learning/textbook-grinstead-snell-probability.pdf` (GNU FDL, 518 pages, cycled).

- [ ] **Step 2: Write the failing test**
```ts
test.use({ viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1.5 });
for (const workers of [1, 2] as const) {
  test(`P0-3 workers=${workers}: steady 3000 px/s scroll for 20 s, no page blank > 150 ms`, async ({ spikePage, server }) => {
    const r = await spikePage({ check: 'scroll', workers, file: server.url('scan-600.pdf'), pattern: 'steady', pxPerSec: 3000, seconds: 20 });
    expect(r.pagesEntered).toBeGreaterThan(40);
    expect(r.maxBlankMs).toBeLessThanOrEqual(150);
  });
  test(`P0-3 workers=${workers}: jumps to pages 400, 120, 599 show each page within 150 ms`, async ({ spikePage, server }) => {
    const r = await spikePage({ check: 'scroll', workers, file: server.url('scan-600.pdf'), pattern: 'jump', targets: '400,120,599' });
    expect(r.maxBlankMs).toBeLessThanOrEqual(150);
  });
}
```
  "Blank" is the time from a page's placeholder first intersecting the viewport to the first paint of its canvas (preview or full).

- [ ] **Step 3: Run it and confirm it fails.** Run: `pnpm -C spikes/phase0 exec playwright test tests/p0-3-scroll.spec.ts`. Expected: FAIL (there is no `scroll` check).

- [ ] **Step 4: Implement `checks/scroll.ts`**

  This is a minimal virtual list: pages at fit width, absolutely positioned and mounted for the viewport ±2 screens.
  - The render queue first draws a **preview**: scale 0.15 × DPR, kept in an LRU of 300 bitmaps. It covers visible pages, then ±10 pages in the scroll direction.
  - Then it draws a **full** render (fit-width × DPR) for visible pages only, cancelling renders that are out of range.
  - With `workers=2`, open the document in two engines and split pages by parity.
  - Drive the scroll with `requestAnimationFrame` (pxPerSec/60 per frame). Record entry time and first-paint time per page.

- [ ] **Step 5: Run it again and record.** Run: `pnpm -C spikes/phase0 exec playwright test tests/p0-3-scroll.spec.ts && pnpm -C spikes/phase0 report`. Expected: PASS for at least one `workers` value. Record both values, with p50, p95 and max for each.

  If both fail, add an `engine=pdfjs` variant (`pdfjs-dist` 6.4.299, same harness, `page.render` to canvas) and record it, so the gate can compare.

- [ ] **Step 6: Commit**
```bash
git add spikes/phase0 docs/spikes/phase0-report.md
git commit -m "test(spike): P0-3 600-page synthetic scan scroll budget"
```

### Task 3: P0-4 text-layer selection suite

**Files:**
- Create: `spikes/phase0/src/textlayer/text-layer.ts` (pdf.js `src/display/text_layer.js` at 743102c; Apache-2.0 header kept, plus `// Modified for sickofpdfs: fed from PDFium glyphs`)
- Create: `spikes/phase0/src/textlayer/items.ts`, `src/textlayer/char-map.ts`, `src/checks/textlayer.ts`
- Create: `spikes/phase0/scripts/make-textlayer-fixtures.mjs`, `fixtures/src/{two-column,rotated-table,ligatures,maths,rtl}.html` and `.txt`
- Create: `spikes/phase0/tests/p0-4-textlayer.spec.ts`
- Modify: `spikes/phase0/src/engine/spike-native.ts` (add `getGlyphs`, `getTextRange`)

**Interfaces:**
- Consumes: `SpikeEngine` (Task 1).
- Produces (ported in Task 22):
```ts
// SpikeNative
getGlyphs(docId: string, pageIndex: number): { glyphs: { index: number; text: string; box: Rect; tight: Rect; fontSize: number; angle: number; generated: boolean }[]; runs: { start: number; end: number }[] };
getTextRange(docId: string, pageIndex: number, start: number, count: number): string; // FPDFText_GetText via getTextSlices
// items.ts / char-map.ts
export function buildTextItems(g: ReturnType<SpikeNative['getGlyphs']>, scale: number, measure: (text: string, font: string) => number): TextItem[];
export function charRangeFromDomRange(root: HTMLElement, range: Range): { pageIndex: number; start: number; end: number }[];
```

- [ ] **Step 1: Generate the fixtures**

  `make-textlayer-fixtures.mjs` renders each `fixtures/src/*.html` to `fixtures/out/tl-<name>.pdf` with Playwright `page.pdf({ format: 'Letter' })`. The fonts are bundled OFL `@fontsource/noto-serif` (ligatures fi, fl, ffi) and `@fontsource/noto-sans-hebrew`.
  - `two-column`: CSS `columns: 2`, 6 paragraphs.
  - `rotated-table`: a 5×4 table inside `transform: rotate(-90deg)`.
  - `ligatures`: "office, fluffy, affine, file".
  - `maths`: inline MathML `<math><msup><mi>x</mi><mn>2</mn></msup>…</math>` inside sentences.
  - `rtl`: a Hebrew paragraph with embedded numbers.

  It also writes `tl-rotated-page.pdf`: `tl-two-column.pdf` with `page.setRotation(degrees(90))`.

  Real pages: `arxiv-1512.03385-resnet.pdf` p1 (two columns) and `arxiv-1706.03762-attention.pdf` p1 (ligatures, inline maths). Each generated `<name>.txt` holds the ground-truth text.

- [ ] **Step 2: Write the failing test**
```ts
const norm = (s: string) => s.normalize('NFKC').replace(/\u00ad/g, '').replace(/\s+/g, ' ').trim();
for (const f of TEXTLAYER_FIXTURES) for (const zoom of [1, 2]) {
  test(`P0-4 ${f.name} @${zoom * 100}%: drag selection maps to the PDFium char range`, async ({ textlayerPage }) => {
    const p = await textlayerPage(f, zoom);
    for (const [a, b] of p.seededPairs(20)) {
      const sel = await p.dragSelect(a, b); // mouse down at glyph a's centre, up at glyph b's centre
      expect(sel.ranges).toEqual([{ pageIndex: f.page, start: Math.min(a, b), end: Math.max(a, b) + 1 }]);
      expect(norm(sel.domText)).toBe(norm(await p.textRange(Math.min(a, b), Math.abs(b - a) + 1)));
    }
  });
  test(`P0-4 ${f.name} @${zoom * 100}%: every glyph edge within 1 px of PDFium's box`, async ({ textlayerPage }) => {
    const r = await (await textlayerPage(f, zoom)).alignment(); // along-text edges per char; ligature expansions split their box equally
    expect(r.maxEdgeErrorPx).toBeLessThan(1);
    expect(r.minVerticalOverlap).toBeGreaterThanOrEqual(0.8);
  });
}
test('P0-4 generated LTR fixtures: select-all text equals the HTML ground truth', async ({ textlayerPage }) => {
  for (const f of TEXTLAYER_FIXTURES.filter((x) => x.truth && x.dir === 'ltr'))
    expect(norm(await (await textlayerPage(f, 1)).selectAllText())).toBe(norm(f.truth!));
});
test('P0-4 two-column: dragging from column 1 bottom line to column 2 top line selects no column-2 lower text', async ({ textlayerPage }) => {
  const r = await (await textlayerPage(TWO_COLUMN, 1)).dragColumns();
  expect(r.ranges).toHaveLength(1);
  expect(r.domText).not.toContain(TWO_COLUMN.column2LastSentence);
});
test('P0-4 rtl: Hebrew runs carry dir="rtl" and a right-to-left drag gives the same range as left-to-right', async ({ textlayerPage }) => {
  const p = await textlayerPage(RTL, 1);
  expect(await p.runDirs()).toContain('rtl');
  expect((await p.dragSelect(p.lastGlyph, p.firstGlyph)).ranges).toEqual((await p.dragSelect(p.firstGlyph, p.lastGlyph)).ranges);
});
```

- [ ] **Step 3: Run it and confirm it fails.** Run: `pnpm -C spikes/phase0 exec playwright test tests/p0-4-textlayer.spec.ts`. Expected: FAIL (`getGlyphs` is not a function).

- [ ] **Step 4: Implement the port**

  `getGlyphs` combines `getPageGeometry` (runs and boxes) with `FPDFText_GetCharAngle` and the PDFium "generated" flags.

  `buildTextItems` splits each PDFium run into pdf.js text items. This "drift-split" algorithm is not fixed by the signature:
```text
for each run (same text object, font size, baseline, angle):
  span = [first glyph]
  for each next glyph g:
    candidate = span + g ; scaleX = (box(last).right − box(first).left) / measure(text(candidate))
    if any glyph i in candidate has |left + scaleX·measure(text[first..i]) − box(i).right| > 0.5 px: emit span; span = [g]
    else span = candidate
  emit span as { str, dir: rtl-script ? 'rtl' : 'ltr', transform: [fs·cosθ, fs·sinθ, −fs·sinθ, fs·cosθ, x, y], width, hasEOL }
chars sharing one PDFium box (ligature expansions) get equal shares of its width
```
  Rendering details:
  - The measurer and the CSS both use `font-kerning: none; font-variant-ligatures: none; white-space: pre`.
  - Each span records `data-start` (PDFium char index).
  - `charRangeFromDomRange` maps (text node, offset) back to char indices.
  - DOM order follows the PDFium char index, so drag order equals reading order.

- [ ] **Step 5: Run it again and record.** Run: `pnpm -C spikes/phase0 exec playwright test tests/p0-4-textlayer.spec.ts && pnpm -C spikes/phase0 report`. Expected: PASS. Record max edge error per fixture and zoom. Any failure is recorded with its fixture name.

- [ ] **Step 6: Commit**
```bash
git add spikes/phase0 docs/spikes/phase0-report.md
git commit -m "test(spike): P0-4 text-layer selection suite on PDFium glyph boxes"
```

### Task 4: P0-5 bold as a glyph-outline overlay

**Files:**
- Modify: `spikes/phase0/src/engine/spike-native.ts` (add `getGlyphOutlines`, `missingGlyphFunctions`)
- Create: `spikes/phase0/src/checks/bold.ts`, `tests/p0-5-bold.spec.ts`

**Interfaces:**
- Consumes: `SpikeNative`, `getGlyphs` (Task 3).
- Produces (the Phase 2 plan adds it to `PdfBackend`):
```ts
getGlyphOutlines(docId: string, pageIndex: number, charStart: number, charCount: number): { charIndex: number; d: string /* SVG path, page space pt, origin top-left */ }[];
missingGlyphFunctions(): string[];
```

- [ ] **Step 1: Record the API finding**

  Add this paragraph to the report notes for P0-5 (it comes from grepping the clones):
  > `embed-pdf-viewer-v2/packages/pdfium/src/vendor/functions.ts` exports these in the wasm wrapper: `FPDFFont_GetGlyphPath` (l.404), `FPDFFont_GetGlyphWidth` (405), `FPDFGlyphPath_CountGlyphSegments`/`GetGlyphPathSegment` (412–413), `FPDFPathSegment_GetPoint/GetType/GetClose` (541–543), `FPDFText_GetMatrix` (568), `FPDFText_GetTextObject` (575), `FPDFTextObj_GetFont`/`GetFontSize` (586–587).
  >
  > `PdfiumNative` (`engines/src/lib/pdfium/engine.ts`) wraps none of them. Its only page-object bounds call is at l.8291. v3 exports the same functions (`engine/runtime/src/core/pdf-functions.generated.ts`).
  >
  > So bold needs our subclass and no wasm rebuild.

- [ ] **Step 2: Write the failing test**
```ts
test('P0-5: the nine glyph-path functions exist on the wrapped module', async ({ spikePage, server }) => {
  const r = await spikePage({ check: 'bold', file: server.url('classifier/learning/arxiv-1706.03762-attention.pdf'), probeOnly: 1 });
  expect(r.missingFunctions).toEqual([]);
});
for (const zoom of [1, 2]) {
  test(`P0-5 @${zoom * 100}%: 20 words in bold overlay < 50 ms p95, covering ≥ 95% of glyph ink`, async ({ spikePage, server }) => {
    const r = await spikePage({ check: 'bold', file: server.url('classifier/learning/arxiv-1706.03762-attention.pdf'), page: 0, words: 20, zoom, reps: 10 });
    expect(r.p95Ms).toBeLessThan(50);           // request → <path> elements in the DOM
    expect(r.inkCoverage).toBeGreaterThanOrEqual(0.95);  // glyph-ink pixels (luminance < 128) inside the overlay fill
    expect(r.spillFraction).toBeLessThanOrEqual(0.10);   // overlay pixels further than 2 px from any ink
  });
}
```

- [ ] **Step 3: Run it and confirm it fails.** Run: `pnpm -C spikes/phase0 build && pnpm -C spikes/phase0 exec playwright test tests/p0-5-bold.spec.ts`. Expected: FAIL (`getGlyphOutlines` is not a function).

- [ ] **Step 4: Implement `getGlyphOutlines`**

  For each character:
  1. Get the text object (`FPDFText_GetTextObject`), its font (`FPDFTextObj_GetFont`) and its size (`FPDFTextObj_GetFontSize`).
  2. Get the glyph path. Try `FPDFFont_GetGlyphPath(font, unicode, size)` first. If the path is empty, retry with the char code. Record which argument form works.
  3. Read the segments and transform them by `FPDFText_GetMatrix` and the char origin (`FPDFText_GetCharOrigin`).
  4. Flip to a top-left origin and emit an SVG `d`.

  `checks/bold.ts`:
  - draws `<path fill="currentColor" stroke="currentColor" stroke-width="{0.03 × fontSize}pt">` in an SVG overlay over the rendered page;
  - rasterises the overlay to compute coverage and spill;
  - saves `results/bold-zoom<z>.png` for the gate review.

- [ ] **Step 5: Run it again and record.** Run: `pnpm -C spikes/phase0 exec playwright test tests/p0-5-bold.spec.ts && pnpm -C spikes/phase0 report`. Expected: PASS. Record p95 ms, coverage, and the glyph argument form that worked.

- [ ] **Step 6: Commit**
```bash
git add spikes/phase0 docs/spikes/phase0-report.md
git commit -m "test(spike): P0-5 bold glyph-outline overlay speed and coverage"
```

### Task 5: P0-10 PDFium page objects find figures within 20 ms a page

**Files:**
- Modify: `spikes/phase0/src/engine/spike-native.ts` (add `getPageObjects`, `getStructFigures`, `detectFigures`)
- Create: `spikes/phase0/src/figures/find-figures.ts`, `scripts/make-objects-fixture.mjs`, `scripts/make-tagged-fixture.mjs`, `src/checks/objects.ts`, `tests/p0-10-objects.spec.ts`

**Interfaces:**
- Consumes: `SpikeNative` (Task 1).
- Produces (the shapes reused by `PdfBackend.listPageObjects` and `getStructTree` in Task 15):
```ts
type PageObjectType = 'text' | 'path' | 'image' | 'shading' | 'form' | 'unknown';
interface PageObjectInfo { type: PageObjectType; bounds: Rect; formDepth: number; markedContentId: number /* −1 none */;
  image?: { pixelWidth: number; pixelHeight: number; filters: string[] }; path?: { segmentCount: number; filled: boolean; stroked: boolean } }
getPageObjects(docId: string, pageIndex: number, opts: { recurseForms: boolean; maxObjects: number; budgetMs: number }): { objects: PageObjectInfo[]; truncated: boolean; elapsedMs: number };
getStructFigures(docId: string, pageIndex: number): { type: string; alt: string | null; actualText: string | null; mcids: number[] }[];
detectFigures(docId: string, pageIndex: number): { figures: DetectedFigure[]; objectCount: number; elapsedMs: number };
interface DetectedFigure { kind: 'image' | 'vector' | 'mixed' | 'table' | 'unknown'; rect: Rect; label: string | null; captionRect: Rect | null; confidence: 'high' | 'medium' }
```

- [ ] **Step 1: Generate the fixtures**

  `make-objects-fixture.mjs` writes `fixtures/out/objects.pdf` (pdf-lib, Letter). Page 1 has:
  - one embedded JPEG at (72, 90, 216×144) with the caption "Figure 1: A photo." 8 pt below it;
  - a vector chart of 48 path objects inside (330, 90, 200×140), with 6 axis-label strings at 6 pt, and the caption "Figure 2: A chart." below;
  - the caption "Table 1: Scores." above a 4-row text table at (72, 420, 300×80);
  - body paragraphs elsewhere.

  Page 2 has 50,000 tiny rectangles.

  `make-tagged-fixture.mjs` writes `tagged.pdf` from `<figure><img alt="Bar chart of test scores" src=data:…><figcaption>Figure 1: Scores.</figcaption></figure>` with Playwright `page.pdf({ tagged: true })`.

- [ ] **Step 2: Write the failing test**
```ts
const iou = (a: Rect, b: Rect) => /* intersection over union */ 0;
test('P0-10: objects fixture enumerates images and paths with exact bounds', async ({ objectsPage }) => {
  const r = await objectsPage('objects.pdf', 0);
  const img = r.objects.find((o) => o.type === 'image')!;
  expect(img.bounds).toMatchObject({ x: expect.closeTo(72, 0.5), y: expect.closeTo(90, 0.5), width: expect.closeTo(216, 0.5), height: expect.closeTo(144, 0.5) });
  expect(r.objects.filter((o) => o.type === 'path').length).toBeGreaterThanOrEqual(48);
});
test('P0-10: captions pair with figures and a text table', async ({ objectsPage }) => {
  const { figures } = await objectsPage('objects.pdf', 0, { detect: true });
  expect(figures.map((f) => f.label).sort()).toEqual(['Figure 1', 'Figure 2', 'Table 1']);
  expect(iou(figures.find((f) => f.label === 'Figure 1')!.rect, { x: 72, y: 90, width: 216, height: 144 })).toBeGreaterThanOrEqual(0.9);
  expect(iou(figures.find((f) => f.label === 'Figure 2')!.rect, { x: 330, y: 90, width: 200, height: 140 })).toBeGreaterThanOrEqual(0.9);
  expect(figures.find((f) => f.label === 'Table 1')!.kind).toBe('table');
  expect(figures.every((f) => f.confidence === 'high')).toBe(true);
});
test('P0-10: tagged PDF exposes Figure with alt text', async ({ objectsPage }) => {
  expect((await objectsPage('tagged.pdf', 0)).struct).toContainEqual(expect.objectContaining({ type: 'Figure', alt: 'Bar chart of test scores' }));
});
test('P0-10: objects + detection p95 ≤ 20 ms a page on 50 real paper pages', async ({ objectsPage }) => {
  const r = await objectsPage('papers', 0, { timing: ['arxiv-1512.03385-resnet', 'arxiv-1706.03762-attention', 'arxiv-1603.02754-xgboost', 'nature-s41586-021-03819-2-alphafold', 'arxiv-1802.03042-deep-hedging'], pages: 10 });
  expect(r.p95Ms).toBeLessThanOrEqual(20);
  expect(r.maxMs).toBeLessThanOrEqual(40);
  expect(r.resnetPage0Labels).toContain('Figure 1');
});
test('P0-10: a 50,000-object page stops at the cap', async ({ objectsPage }) => {
  const r = await objectsPage('objects.pdf', 1);
  expect(r.truncated).toBe(true);
  expect(r.elapsedMs).toBeLessThanOrEqual(25);
});
```

- [ ] **Step 3: Run it and confirm it fails.** Run: `pnpm -C spikes/phase0 exec playwright test tests/p0-10-objects.spec.ts`. Expected: FAIL (`getPageObjects` is not a function).

- [ ] **Step 4: Implement**
  - `getPageObjects` loops `FPDFPage_CountObjects`/`GetObject`, reading `FPDFPageObj_GetType`, `GetBounds` and `GetMarkedContentID`. It recurses through `FPDFFormObj_CountObjects`/`GetObject` when `recurseForms` is set. It reads image metadata (`FPDFImageObj_GetImagePixelSize`, `GetImageFilter(Count)`) and path data (`FPDFPath_CountSegments`, `GetDrawMode`). It stops at `maxObjects` 20000 or `budgetMs` 15.
  - `getStructFigures` uses `FPDF_StructTree_GetForPage` and `FPDF_StructElement_GetType/GetAltText/GetActualText/GetMarkedContentIdAtIndex`.
  - `find-figures.ts` implements 06 §3.2 steps 2–4:
    - images and forms with area ≥ 2% and both sides ≥ 36 pt;
    - path clusters with a 6 pt merge distance, kept when they have ≥ 8 paths or area ≥ 3%;
    - absorbed text within 12 pt that is not body text;
    - the caption regex from 06 §3.3;
    - nearest same-column pairing (figures above their caption, tables below);
    - high confidence for tagged, caption-linked, or one large image/form.
  - `detectFigures` runs it in the worker, with lines from `getPageTextRuns`.

- [ ] **Step 5: Run it again and record.** Run: `pnpm -C spikes/phase0 exec playwright test tests/p0-10-objects.spec.ts && pnpm -C spikes/phase0 report`. Expected: PASS. Record the p50, p95 and max ms.

- [ ] **Step 6: Commit**
```bash
git add spikes/phase0 docs/spikes/phase0-report.md
git commit -m "test(spike): P0-10 page objects, struct tree and figure finding within 20 ms"
```

### Task 6: P0-6 moving 300 MB between a tab and the offscreen document; the 1 GB open limit

**Files:**
- Modify: `spikes/phase0/entrypoints/background.ts`, `wxt.config.ts` (add `offscreen` permission)
- Create: `spikes/phase0/entrypoints/offscreen/index.html`, `main.ts`, `src/checks/transfer.ts`, `src/checks/big-open.ts`, `scripts/make-big-pdf.mjs`, `tests/p0-6-transfer.spec.ts`

**Interfaces:**
- Consumes: `createFileWorkerEngine` (Task 1).
- Produces: the transport the Phase 1 store uses (Task 28 reads the result).
  - Service worker: `self.addEventListener('message', e => …)`. On `{type:'connect-offscreen'}` with `e.ports[0]`, it ensures the offscreen document exists (reason `WORKERS`), then calls `(await clients.matchAll({ includeUncontrolled: true })).find(c => c.url.endsWith('/offscreen.html')).postMessage({type:'port'}, [port])`.

- [ ] **Step 1: Write the big-file generator**

  `node scripts/make-big-pdf.mjs --bytes 1073741824 --out fixtures/out/big-1g.pdf` writes a valid 1-page PDF ("Big file test", Helvetica). An `/EmbeddedFiles` stream of seeded random bytes, streamed in 16 MB chunks, pads the file to exactly `--bytes`. The xref comes from tracked offsets. Also generate `big-1.5g.pdf` (1610612736 bytes) and `big-1.9g.pdf` (2040109465 bytes).

- [ ] **Step 2: Write the failing test**
```ts
const MB300 = 300 * 1024 * 1024;
test('P0-6a: 300 MB ArrayBuffer tab→offscreen and back over an SW-brokered MessagePort', async ({ spikePage }) => {
  const r = await spikePage({ check: 'transfer', mode: 'port', bytes: MB300 });
  expect(r.hashMatches).toBe(true);
  expect(r.toOffscreenMs).toBeLessThan(1000);
  expect(r.backMs).toBeLessThan(1000);
});
test('P0-6b: 300 MB via OPFS (tab createWritable, offscreen getFile stream)', async ({ spikePage }) => {
  const r = await spikePage({ check: 'transfer', mode: 'opfs', bytes: MB300 });
  expect(r.hashMatches).toBe(true);
  expect(r.totalMs).toBeLessThan(5000);
});
test('P0-6c: 300 MB via chrome.runtime.sendMessage fails, as the spec assumes', async ({ spikePage }) => {
  expect((await spikePage({ check: 'transfer', mode: 'runtime', bytes: MB300 })).failed).toBe(true);
});
test('P0-6d: a 1 GiB PDF opens and renders page 1 within 20 s', async ({ spikePage, server }) => {
  const r = await spikePage({ check: 'big-open', file: server.url('big-1g.pdf') }, { timeout: 60_000 });
  expect(r.error).toBeNull();
  expect(r.firstPageMs).toBeLessThan(20_000);
  expect(r.inkFraction).toBeGreaterThan(0.001);
});
test('P0-6e: record the largest file that opens', async ({ spikePage, server }) => {
  for (const f of ['big-1.5g.pdf', 'big-1.9g.pdf']) await record('P0-6', { pass: true, measured: JSON.stringify(await spikePage({ check: 'big-open', file: server.url(f) }, { timeout: 90_000 })) });
});
```
  `big-open` uses exactly the Phase 1 loading sequence: stream with hashing → `Blob` → `blob.arrayBuffer()` → transfer to the worker → `openDocumentBuffer`.

- [ ] **Step 3: Run it and confirm it fails.** Run: `pnpm -C spikes/phase0 exec playwright test tests/p0-6-transfer.spec.ts`. Expected: FAIL (there is no `transfer` check).

- [ ] **Step 4: Implement the three transports and `big-open`**

  The tab fills the buffer with `crypto.getRandomValues` in 64 KiB slices and hashes it with hash-wasm. For the port mode it calls `(await navigator.serviceWorker.ready).active.postMessage({type:'connect-offscreen'}, [port2])`. The offscreen side hashes what it receives and echoes the buffer back, transferred.

- [ ] **Step 5: Run it again and record.** Run: `pnpm -C spikes/phase0 exec playwright test tests/p0-6-transfer.spec.ts && pnpm -C spikes/phase0 report`. Expected: 6a, 6b, 6c and 6d PASS. 6e records the largest size that opened.

- [ ] **Step 6: Commit**
```bash
git add spikes/phase0 docs/spikes/phase0-report.md
git commit -m "test(spike): P0-6 300 MB transfers and the 1 GiB open limit"
```

### Task 7: P0-7 form-field detection

**Files:**
- Modify: `spikes/phase0/src/engine/spike-native.ts` (add `getFormInfo`)
- Create: `spikes/phase0/src/checks/forms.ts`, `tests/p0-7-forms.spec.ts`

**Interfaces:**
- Consumes: `SpikeNative` (Task 1).
- Produces (copied into `PdfBackend` in Task 15):
```ts
getFormInfo(docId: string): { formType: 'none' | 'acroform' | 'xfa-full' | 'xfa-foreground'; firstFillablePage: number | null };
export const hasFillableFields = (i: { formType: string; firstFillablePage: number | null }) => i.formType.startsWith('xfa') || i.firstFillablePage !== null;
```

- [ ] **Step 1: Write the failing test**
```ts
// The four learning fixtures whose /AcroForm holds no fields (hyperref-style; see docs/research/04 §B.2)
const NOT_FORMS = ['nber-w29000', 'lse-cep-dp1800', 'nature-s41586-021-03819-2-alphafold', 'lecture-notes-mit-6.006-lec1'];
for (const f of NOT_FORMS) test(`P0-7 ${f}: AcroForm flag but not a form`, async ({ formsPage }) => {
  const i = await formsPage(`learning/${f}.pdf`);
  expect(i.formType).toBe('acroform');
  expect(hasFillableFields(i)).toBe(false);
});
test('P0-7 HMRC SA100 (4 real text fields) is a form', async ({ formsPage }) => {
  const i = await formsPage('not-learning/tax-form-hmrc-sa100-2026.pdf');
  expect(i.firstFillablePage).not.toBeNull();
  expect(hasFillableFields(i)).toBe(true);
});
test('P0-7 IRS W-9 (XFA + fields) is a form', async ({ formsPage }) => {
  expect(hasFillableFields(await formsPage('not-learning/tax-form-irs-w9.pdf'))).toBe(true);
});
test('P0-7 detection on the 133-page NBER paper takes < 200 ms', async ({ formsPage }) => {
  expect((await formsPage('learning/nber-w29000.pdf')).elapsedMs).toBeLessThan(200);
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run: `pnpm -C spikes/phase0 exec playwright test tests/p0-7-forms.spec.ts`. Expected: FAIL (`getFormInfo` is not a function).

- [ ] **Step 3: Implement `getFormInfo`**

  Map `FPDF_GetFormType(docPtr)` to `0 none / 1 acroform / 2 xfa-full / 3 xfa-foreground`.

  For `acroform`, walk pages with `getPageAnnoWidgets`. Stop at the first page holding a widget whose field type is CHECKBOX 2, RADIOBUTTON 3, COMBOBOX 4, LISTBOX 5 or TEXTFIELD 6. Push buttons (1) and signatures (7) do not count.

- [ ] **Step 4: Run it again and record.** Run: `pnpm -C spikes/phase0 exec playwright test tests/p0-7-forms.spec.ts && pnpm -C spikes/phase0 report`. Expected: PASS. Record the `formType` reported for the W-9.

- [ ] **Step 5: Commit**
```bash
git add spikes/phase0 docs/spikes/phase0-report.md
git commit -m "test(spike): P0-7 fillable-field detection ignores hyperref AcroForms"
```

### Task 8: P0-8 backup-folder permission from an extension origin

**Files:**
- Create: `spikes/phase0/src/checks/backup-folder.ts`, `tests/p0-8-backup-folder.spec.ts`

**Interfaces:**
- Consumes: the spike harness (Task 1).
- Produces: the report's "Handed to the Windows checklist" items W-B1 to W-B3, which Task 32 copies.

- [ ] **Step 1: Write the failing test**
```ts
test('P0-8a: showDirectoryPicker in an extension tab yields a writable handle (picker intercepted)', async ({ launchSpike }) => {
  const { page } = await launchSpike({ profile: 'p08' });
  const dir = await mkdtemp(join(tmpdir(), 'sop-backup-'));
  const chooser = page.waitForEvent('filechooser', { timeout: 5000 }).then((fc) => fc.setFiles(dir)).catch(() => 'no-chooser');
  const r = await page.evaluate(() => (window as any).spikeBackupPick());  // click-initiated pick, writes backup-probe.txt, stores handle in IndexedDB
  if ((await chooser) === 'no-chooser') return record('P0-8', { pass: 'blocked', measured: 'picker not automatable', note: 'see W-B1..W-B3' });
  expect(await readFile(join(dir, 'backup-probe.txt'), 'utf8')).toBe('sickofpdfs backup probe');
  expect(r.permission).toBe('granted');
});
test('P0-8b: after a browser restart the stored handle reports granted or prompt', async ({ launchSpike }) => {
  const { page } = await launchSpike({ profile: 'p08' });   // same user-data dir, new browser process
  const state = await page.evaluate(() => (window as any).spikeBackupQuery());
  expect(['granted', 'prompt']).toContain(state);
  await record('P0-8', { pass: true, measured: `after restart: ${state}` });
});
test('P0-8c: requestPermission without a user gesture is refused', async ({ launchSpike }) => {
  const { page } = await launchSpike({ profile: 'p08' });
  expect(await page.evaluate(() => (window as any).spikeBackupRequestNoGesture())).toMatch(/SecurityError|NotAllowedError|prompt/);
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run: `pnpm -C spikes/phase0 exec playwright test tests/p0-8-backup-folder.spec.ts`. Expected: FAIL (`spikeBackupPick` is undefined).

- [ ] **Step 3: Implement `checks/backup-folder.ts`**

  Implement `spikeBackupPick`, `spikeBackupQuery` and `spikeBackupRequestNoGesture`. Store the `FileSystemDirectoryHandle` in IndexedDB `spike-backup`.

  Add to the report's Windows hand-off list:
  - **W-B1** pick a folder, restart Chrome and note `queryPermission`, and whether the three-way "Allow on every visit" prompt appears;
  - **W-B2** pick a folder inside `G:\My Drive` (Google Drive for desktop), write `backup-probe.txt`, and confirm it appears on drive.google.com within 2 minutes;
  - **W-B3** the same for a OneDrive folder.

- [ ] **Step 4: Run it again and record.** Run: `pnpm -C spikes/phase0 exec playwright test tests/p0-8-backup-folder.spec.ts && pnpm -C spikes/phase0 report`. Expected: PASS, or BLOCKED for 8a and 8b with the reason recorded. 8c must PASS.

- [ ] **Step 5: Commit**
```bash
git add spikes/phase0 docs/spikes/phase0-report.md
git commit -m "test(spike): P0-8 backup-folder permission probes and Windows hand-offs"
```

### Task 9: P0-9 TypeScript 7 with typescript-eslint

**Files:**
- Create: `spikes/phase0/ts7/{package.json,tsconfig.json,eslint.config.mjs,src/good.ts,src/bad.ts}`, `spikes/phase0/tests/p0-9-ts7.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the `TOOLING_TS` decision (Task 10), which Task 11 uses.

- [ ] **Step 1: Write the failing test**
```ts
// ts7/package.json pins typescript 7.0.2, typescript-eslint 8.72.1, eslint 10.14.0
// bad.ts line 3: `fetchThing();` with no await, where fetchThing(): Promise<void>
test('P0-9: tsc 7 type-checks and typed lint rules work', async () => {
  const tsc = spawnSync('pnpm', ['-C', 'ts7', 'exec', 'tsc', '--noEmit', '-p', '.'], { encoding: 'utf8' });
  expect(tsc.status).toBe(0);
  const lint = spawnSync('pnpm', ['-C', 'ts7', 'exec', 'eslint', '--format', 'json', 'src'], { encoding: 'utf8' });
  const msgs = JSON.parse(lint.stdout).flatMap((f: any) => f.messages.map((m: any) => `${basename(f.filePath)}:${m.line}:${m.ruleId}`));
  expect(msgs).toEqual(['bad.ts:3:@typescript-eslint/no-floating-promises']);
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run: `pnpm -C spikes/phase0/ts7 install && pnpm -C spikes/phase0 exec playwright test tests/p0-9-ts7.spec.ts`. Expected: FAIL (the `ts7/src` files are missing).

- [ ] **Step 3: Add the files**

  `eslint.config.mjs` uses `tseslint.configs.recommendedTypeChecked` with `parserOptions.projectService: true`. Add `good.ts`, a clean module, and `bad.ts`.

- [ ] **Step 4: Run it again and record.** Run: `pnpm -C spikes/phase0 exec playwright test tests/p0-9-ts7.spec.ts && pnpm -C spikes/phase0 report`. Expected: PASS or FAIL. Both are acceptable results. Record the error text: typescript-eslint 8.72.1 declares the peer `typescript >=4.8.4 <6.1.0`.

- [ ] **Step 5: Commit**
```bash
git add spikes/phase0 docs/spikes/phase0-report.md
git commit -m "test(spike): P0-9 TypeScript 7 with typescript-eslint"
```

### Task 10: Phase 0 gate and decision

**Files:**
- Modify: `docs/spikes/phase0-report.md` (the Decision section)

**Interfaces:**
- Consumes: every `results/P0-*.json`.
- Produces: these decision constants, read by later tasks:
```text
ENGINE          = embedpdf-v2 | embedpdf-v3 | pdfjs
ENGINE_WORKERS  = 1 | 2                         (Task 15 createEmbedPdfBackend opts.workers)
MAX_OPEN_BYTES  = 1073741824 unless P0-6d failed (Task 20)
STORE_TRANSPORT = sw-brokered-port | runtime-port (Task 28)
TOOLING_TS      = 6.0.3 | 7.0.2                  (Task 11)
BOLD            = glyph-outline | strong         (Phase 2 plan; "strong" only with the user's OK)
FIGURES         = objects+captions | captions-only (Phase 2 plan)
GLYPH_ARG       = unicode | charcode             (Phase 2 plan, from P0-5)
```

- [ ] **Step 1: Run every check.** Run: `pnpm -C spikes/phase0 build && pnpm -C spikes/phase0 exec playwright test && pnpm -C spikes/phase0 report`. Expected: a full results table, with no row missing.

- [ ] **Step 2: Apply the gate rules and write the Decision section**

  The rules, verbatim:
  - **Engine (blocking).** EmbedPDF v2 stays if P0-1 `v2-file`, P0-2, P0-3 (with either worker count), P0-4 pairs and copy, P0-6d and P0-7 all PASS.
    - If only P0-1 fails on v2 and passes on v3, choose `embedpdf-v3`.
    - Otherwise, if P0-1 or P0-3 fails, choose `pdfjs` (pdfjs-dist 6.4.299).
    - P0-4 alignment failing only on RTL is recorded as a Task 22 defect, not as an engine failure.
  - **pdf.js fallback.**
    - Task 15 is re-planned as `PdfjsBackend` behind the unchanged `PdfBackend` interface.
    - Bold becomes "strong" (spec).
    - `listPageObjects` returns image objects from `recordImages`, and `getStructTree` comes from `page.getStructTree()` (06 §3.6). Vector clusters are dropped.
    - The Release 3 export path is planned separately.
  - **Non-blocking:**
    - P0-5 FAIL means `BOLD=strong`, which is asked of the user at this gate before Phase 2.
    - P0-10 FAIL on timing means `FIGURES=captions-only`.
    - P0-6a FAIL means `STORE_TRANSPORT=runtime-port`, and Task 28 Step 4 then uses `chrome.runtime.connect({ name: 'sop-store' })`, which the offscreen document relays to the worker.
    - P0-6d FAIL means `MAX_OPEN_BYTES` = the largest size that passed, rounded down to a multiple of 256 MiB, and the user is told.
    - P0-8 goes to the Windows checklist.
    - P0-9 PASS means `TOOLING_TS=7.0.2`.

- [ ] **Step 3: Demo for the user**

  Attach `results/*.png`, the results table and the Decision constants to the gate message. Get the user's OK on `ENGINE`, and on `BOLD` if it is `strong`.

- [ ] **Step 4: Commit**
```bash
git add docs/spikes/phase0-report.md
git commit -m "docs(spike): Phase 0 gate results and engine decision"
```

# Phase 1 · Foundations

### Task 11: Workspace scaffold, lint with the design-token rule, unit tests, fixtures, CI

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `.npmrc`, `tsconfig.base.json`, `vitest.config.ts`, `eslint.config.mjs`, `.github/workflows/ci.yml`
- Create: `tooling/eslint-plugin-sop/{package.json,index.js,rules/no-raw-design-values.js,rules/no-raw-design-values.test.js}`
- Create: `packages/{core,ui,viewer}/{package.json,tsconfig.json,src/index.ts}`, `apps/cloud/package.json`
- Create: `scripts/fixtures/{build.mjs,fetch-classifier.mjs,make-paper50.mjs}`
- Modify: `.gitignore` (add `test-assets/`, `.vitest-attachments/`)

**Interfaces:**
- Consumes: `TOOLING_TS` (Task 10).
- Produces:
  - root scripts `typecheck`, `lint`, `test` (Vitest project `unit`), `test:browser` (Vitest project `browser`), `e2e` (added in Task 12) and `fixtures`;
  - the ESLint rule `sop/no-raw-design-values` with messageIds `rawColor`, `rawLength`, `rawFont`, `rawShadow`;
  - `test-assets/classifier/**` and `test-assets/paper-50.pdf`.

- [ ] **Step 1: Write the failing rule tests**
```js
// tooling/eslint-plugin-sop/rules/no-raw-design-values.test.js (ESLint RuleTester; CSS cases use language "css/css" from @eslint/css)
cssTester.run('no-raw-design-values', rule, {
  valid: [
    'a { color: var(--gm3-sys-color-primary); padding: var(--space-2); border-bottom: 1px solid var(--drive-row-divider); margin: 0; width: 100%; }',
    { code: ':root { --gm3-sys-color-primary: #0b57d0; --row-h: 48px; }', filename: 'packages/ui/src/tokens/tokens.css' },
  ],
  invalid: [
    { code: 'a { color: #0b57d0 }', errors: [{ messageId: 'rawColor' }] },
    { code: 'a { background: rgb(0 0 0) }', errors: [{ messageId: 'rawColor' }] },
    { code: 'a { color: red }', errors: [{ messageId: 'rawColor' }] },
    { code: 'a { padding: 8px }', errors: [{ messageId: 'rawLength' }] },
    { code: 'a { font-family: Arial }', errors: [{ messageId: 'rawFont' }] },
    { code: 'a { box-shadow: 0 1px 2px var(--x) }', errors: [{ messageId: 'rawShadow' }] },
  ],
});
jsxTester.run('no-raw-design-values', rule, {
  valid: ["<div style={{ width: '100%', color: 'var(--gm3-sys-color-on-surface)' }} />"],
  invalid: [
    { code: "<div style={{ color: '#fff' }} />", errors: [{ messageId: 'rawColor' }] },
    { code: '<div style={{ padding: 12 }} />', errors: [{ messageId: 'rawLength' }] },
  ],
});
```
  Allowed without tokens: `0`, `1px` (hairlines), `%`, `fr`, `auto`, `transparent`, `currentColor`, `inherit` and `none`. Files under `packages/ui/src/tokens/` are exempt.

- [ ] **Step 2: Run them and confirm they fail.** Run: `pnpm install && pnpm vitest run tooling/eslint-plugin-sop`. Expected: FAIL (`Cannot find module './no-raw-design-values.js'`).

- [ ] **Step 3: Implement the scaffold and the rule**
  - **Root `package.json`:** `"private": true`, `"packageManager": "pnpm@10.28.0"`, `"engines": { "node": ">=22" }`, `pnpm.patchedDependencies` (filled in Task 15), and these exact devDependencies: `typescript` `TOOLING_TS`, `vitest` 5.0.5, `@vitest/browser-playwright` 5.0.5, `eslint` 10.14.0, `@eslint/js` 10.0.1, `@eslint/css` 2.0.1, `typescript-eslint` 8.72.1, `eslint-plugin-react-hooks` 7.1.1, `globals` 17.13.0, `@playwright/test` 1.63.0, `pdf-lib` 1.17.1, `jpeg-js` 0.4.4, `@types/node` 22.20.5.
  - **`pnpm-workspace.yaml`:** `packages: [apps/*, packages/*, tooling/*]` (it excludes `spikes/**`).
  - **`.npmrc`:** `save-exact=true`.
  - **`vitest.config.ts`:** two projects. `unit` runs in environment `node`, includes `**/*.test.{ts,js}` and excludes `*.browser.test.*` and `spikes/**`. `browser` includes `**/*.browser.test.{ts,tsx}`, with `browser: { enabled: true, provider: playwright(), headless: true, instances: [{ browser: 'chromium' }] }` and `server.fs.allow` set to the repo root.
  - **`eslint.config.mjs`:** typed rules for `**/*.{ts,tsx}`, `@eslint/css` for `**/*.css`, and the plugin `sop` with `sop/no-raw-design-values: 'error'`.
  - **`scripts/fixtures/build.mjs`:** runs `fetch-classifier.mjs` (manifest `docs/research/classifier-fixtures/manifest.json`, `SOP_FIXTURE_SRC` first, then `url`, sha256 verified) and `make-paper50.mjs`. Later tasks append their generators to this list.
  - **`apps/cloud/package.json`:** `{ "name": "@sop/cloud", "private": true, "description": "Release 2 Cloudflare Worker; not started" }`.

- [ ] **Step 4: Add the CI workflow.** `.github/workflows/ci.yml` runs on push and pull_request on `ubuntu-latest`, in this order: `actions/checkout@v4`, `pnpm/action-setup@v4`, `actions/setup-node@v4` (Node 22, `cache: pnpm`); `pnpm install --frozen-lockfile`; `pnpm typecheck`, `pnpm lint`, `pnpm test`; `actions/cache@v4` on `test-assets/`, keyed on `hashFiles('scripts/fixtures/**', 'docs/research/classifier-fixtures/manifest.json')`; `pnpm fixtures`; `pnpm exec playwright install --with-deps chromium` (CI runner only); `pnpm test:browser`, `pnpm e2e`; and `actions/upload-artifact@v4` with `playwright-report/` when a step fails.

- [ ] **Step 5: Run everything and confirm it passes.** Run: `pnpm vitest run tooling/eslint-plugin-sop && pnpm lint && pnpm typecheck && pnpm fixtures`. Expected: PASS. `test-assets/paper-50.pdf` exists with 50 pages.

- [ ] **Step 6: Commit**
```bash
git add package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc tsconfig.base.json vitest.config.ts eslint.config.mjs .github tooling packages apps/cloud scripts .gitignore
git commit -m "chore: pnpm monorepo, lint with design-token rule, vitest projects, fixtures, CI"
```

### Task 12: Extension manifest, stable key, Playwright extension fixture and network gate

**Files:**
- Create: `apps/extension/{package.json,tsconfig.json,wxt.config.ts,extension-key.pub.txt}`, `apps/extension/scripts/{gen-key.mjs,make-icons.mjs,extension-id.mjs,extension-id.test.ts}`, `apps/extension/public/icon/{16,32,48,128}.png`
- Create: `apps/extension/src/entrypoints/background.ts`, `src/entrypoints/viewer/{index.html,main.tsx}`, `src/entrypoints/offscreen/{index.html,main.ts}`, `src/viewer/test-hooks.ts`
- Create: `e2e/playwright.config.ts`, `e2e/support/{launch.ts,seed-profile.ts,netlog.ts,netlog.test.ts,server.ts,header-cases.ts,test.ts}`, `e2e/smoke.spec.ts`
- Modify: root `package.json` (add scripts `"e2e": "pnpm -C apps/extension build:e2e && playwright test -c e2e/playwright.config.ts"` and `"build": "pnpm -C apps/extension build"`)

**Interfaces:**
- Consumes: the workspace (Task 11).
- Produces:
```ts
// apps/extension/scripts/extension-id.mjs (Node only; the extension itself uses chrome.runtime.id)
export function extensionIdFromKey(base64Der: string): string;   // sha256(DER)[0..16] hex mapped 0-f → a-p
export const EXTENSION_ID: string;                               // = extensionIdFromKey(apps/extension/extension-key.pub.txt)
// apps/extension/src/viewer/test-hooks.ts (fields are added by later tasks)
export interface SopTestHooks { [k: string]: unknown }
export function installTestHooks(h: Partial<SopTestHooks>): void; // merges into globalThis.__sopTest; no-op unless MODE === 'test'
// e2e/support/test.ts
export const test: TestType<{
  context: BrowserContext; sw: Worker; server: FixtureServer;
  openViewer(source: string, opts?: { back?: string; page?: number }): Promise<Page>;   // buildViewerUrl, then waits for the viewer root
}, { profile: 'seeded' | 'bare' }>;
export function hooks(page: Page): { eval<T>(fn: (h: SopTestHooks) => T | Promise<T>): Promise<T> };
export interface FixtureServer {   // 127.0.0.1, random port; /f/<name> serves test-assets/<name> as application/pdf; /h/* serves HEADER_CASES and the pages tasks add
  origin: string; url(path: string): string; requests(path: string): number;
  serveSequence(path: string, bodies: Uint8Array[]): void;   // successive GETs get successive bodies (Task 30)
}
// e2e helpers in e2e/support/test.ts, each added by the first task that uses it:
// css(page, sel), box(page, sel), clickMenu(page, menu, item), steadyScroll(page, o), copyFixture(name, dest),
// sha256File(path), opfsList(page, dir): Promise<string[]>, grepOpfs(page, dir, needle): Promise<boolean>
// e2e/support/netlog.ts
export function netlogExternalUrls(netlogPath: string, allowedOrigin: string): Promise<string[]>;
```

- [ ] **Step 1: Write the failing tests**
```ts
// apps/extension/scripts/extension-id.test.ts
test('extensionIdFromKey maps sha256 hex to a-p', () => {
  expect(extensionIdFromKey(Buffer.from('test').toString('base64'))).toBe('jpignaibiiemhngfjkcpokkamffknabf');
});
test('EXTENSION_ID derives from the committed public key', () => {
  expect(EXTENSION_ID).toMatch(/^[a-p]{32}$/);
  expect(EXTENSION_ID).toBe(extensionIdFromKey(readFileSync('apps/extension/extension-key.pub.txt', 'utf8').trim()));
});
// e2e/support/netlog.test.ts
test('netlogExternalUrls reports only non-allowed http(s)/ws(s) URLs', async () => {
  expect(await netlogExternalUrls('e2e/support/__fixtures__/sample-netlog.json', 'http://127.0.0.1:4100'))
    .toEqual(['https://cdn.jsdelivr.net/npm/x.wasm']);
});
// e2e/smoke.spec.ts
test('extension loads under the stable id', async ({ sw }) => {
  expect(sw.url()).toBe(`chrome-extension://${EXTENSION_ID}/background.js`);
});
test('manifest pins CSP, Chrome 128, incognito split and permissions', async ({ sw }) => {
  expect(await sw.evaluate(() => chrome.runtime.getManifest())).toMatchObject({
    manifest_version: 3, minimum_chrome_version: '128', incognito: 'split',
    content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" },
    permissions: expect.arrayContaining(['declarativeNetRequestWithHostAccess', 'webRequest', 'webNavigation', 'tabs', 'storage', 'unlimitedStorage', 'offscreen']),
    host_permissions: ['<all_urls>'],
    web_accessible_resources: [{ resources: ['viewer.html'], matches: ['<all_urls>'] }],
  });
});
test('file URL access is pre-seeded', async ({ sw }) => {
  expect(await sw.evaluate(() => chrome.extension.isAllowedFileSchemeAccess())).toBe(true);
});
test('eval is blocked in extension pages', async ({ context }) => {
  const p = await context.newPage(); await p.goto(`chrome-extension://${EXTENSION_ID}/viewer.html`);
  expect(await p.evaluate(() => { try { eval('1'); return 'ran'; } catch { return 'blocked'; } })).toBe('blocked');
});
test('production build contains no test hooks', () => {
  execSync('pnpm -C apps/extension build');
  expect(execSync('grep -rl __sopTest apps/extension/.output/chrome-mv3 || true').toString().trim()).toBe('');
});
```
  `e2e/support/test.ts` adds a network gate to **every** e2e test. After the test, the context closes, then: `expect(await netlogExternalUrls(netlogPath, server.origin)).toEqual([])`.

- [ ] **Step 2: Run them and confirm they fail.** Run: `pnpm vitest run apps/extension/scripts/extension-id.test.ts e2e/support/netlog.test.ts && pnpm e2e e2e/smoke.spec.ts`. Expected: FAIL (`extension-id.mjs` is missing; the WXT project is missing).

- [ ] **Step 3: Generate the key and implement**
  - **Key.** `node apps/extension/scripts/gen-key.mjs` runs `crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })`. It writes the private key PEM to `~/.config/sickofpdfs/extension-key.pem` (mode 600, never in the repo) and the base64 SPKI DER of the public key to `apps/extension/extension-key.pub.txt`, then prints the ID.
  - **Icons.** `make-icons.mjs` renders Material Symbol `menu_book` (white, FILL 1) on a `#0b57d0` rounded tile with Playwright, at 16/32/48/128 px, into `public/icon/`.
  - **`wxt.config.ts`:** `srcDir: 'src'`, `modules: ['@wxt-dev/module-react']` (exact `@wxt-dev/module-react` 1.2.2), and the manifest: `name: 'sickofpdfs'`, `key`, `minimum_chrome_version: '128'`, `incognito: 'split'`, the permissions and `host_permissions` asserted above, the CSP, `web_accessible_resources` and `icons`.
  - **Scripts:** `apps/extension` gets `"build": "wxt build"`, `"build:e2e": "wxt build --mode test"`, `"typecheck": "tsc --noEmit"`.
  - **e2e launch:**
    - `launch.ts` calls `chromium.launchPersistentContext(copyOfSeededProfile, { headless: true, args: ['--disable-extensions-except=…/chrome-mv3', '--load-extension=…/chrome-mv3', '--log-net-log=<testInfo.outputPath("netlog.json")>', '--disable-component-update', '--no-pings', '--disable-domain-reliability'] })`.
    - `seed-profile.ts` runs once per worker. It opens `chrome://extensions/?id=${EXTENSION_ID}` and clicks the `cr-toggle` inside `extensions-toggle-row` with the text "Allow access to file URLs", and the one for "Allow in Incognito". It waits for the service worker to restart and then confirms with `isAllowedFileSchemeAccess()`.
    - The `profile: 'bare'` option skips seeding.

- [ ] **Step 4: Run them again and confirm they pass.** Run: `pnpm vitest run apps/extension/scripts/extension-id.test.ts e2e/support/netlog.test.ts && pnpm e2e e2e/smoke.spec.ts`. Expected: PASS, including the network gate in teardown.

- [ ] **Step 5: Commit**
```bash
git add apps/extension e2e package.json pnpm-lock.yaml
git commit -m "feat(extension): MV3 manifest with stable key, Playwright extension fixture, network gate"
```

### Task 13: Design tokens, fonts and icons (`packages/ui`)

**Files:**
- Create: `packages/ui/src/tokens/{tokens.css,tokens-dark.css,tokens.test.ts}`, `packages/ui/src/base.css`
- Create: `packages/ui/src/fonts/{register.ts,fonts.browser.test.ts}`
- Create: `packages/ui/src/icons/{Icon.tsx,names.ts,file-pdf-box.ts,FileTypeIcon.tsx,Icon.browser.test.tsx}`, `packages/ui/scripts/extract-mdi.mjs`
- Modify: `packages/ui/package.json` (exact deps `react` 19.3.1, `radix-ui` 1.8.1, `material-symbols` 0.48.2, `@fontsource-variable/google-sans` 5.3.2, `@fontsource-variable/google-sans-flex` 5.3.2; devDependency `@iconify-json/mdi` 1.2.3)

**Interfaces:**
- Consumes: the ESLint rule (Task 11).
- Produces:
```ts
export function registerFonts(): Promise<void>;        // FontFace for "Google Sans", "Google Sans Text", "Google Sans Flex", "Material Symbols Outlined"
export const ICON_NAMES: readonly [...];                // every Material Symbol used in Phase 1 (list below)
export type IconName = (typeof ICON_NAMES)[number];
export function Icon(p: { name: IconName; size?: 20 | 24; filled?: boolean; className?: string }): JSX.Element;
export function FileTypeIcon(p: { kind: 'pdf'; size?: 18 | 24 }): JSX.Element;  // mdi:file-pdf-box filled var(--filetype-pdf)
// CSS: import '@sop/ui/tokens.css'; set data-theme="dark" on the viewer root
```

- [ ] **Step 1: Write the failing tests**
```ts
// tokens.test.ts (parses the CSS text)
test('light tokens are Drive GM3 values (02 §3.1)', () => {
  expect(light['--gm3-sys-color-primary']).toBe('#0b57d0');
  expect(light['--gm3-sys-color-surface-container-low']).toBe('#f8fafd');
  expect(light['--gm3-sys-color-surface-container']).toBe('#f0f4f9');
  expect(light['--gm3-sys-color-surface-container-high']).toBe('#e9eef6');
  expect(light['--drive-row-hover']).toBe('#ededed');
  expect(light['--drive-row-selected-bg']).toBe('#c2e7ff');
  expect(light['--gm3-sys-color-inverse-surface']).toBe('#303030');
  expect(light['--filetype-pdf']).toBe('#FC413D');
  expect(light['--topbar-h']).toBe('64px'); expect(light['--row-h']).toBe('48px'); expect(light['--shape-docs-comment']).toBe('12px');
});
test('dark tokens are the Drive dark block', () => {
  expect(dark['--gm3-sys-color-surface-container-low']).toBe('#1b1b1b');
  expect(dark['--gm3-sys-color-surface-container']).toBe('#1e1f20');
  expect(dark['--gm3-sys-color-surface-container-high']).toBe('#282a2c');
  expect(dark['--gm3-sys-color-surface-container-highest']).toBe('#333537');
  expect(dark['--gm3-sys-color-surface-bright']).toBe('#37393b');
  expect(dark['--gm3-sys-color-on-surface']).toBe('#e3e3e3');
  expect(dark['--gm3-sys-color-on-surface-variant']).toBe('#c4c7c5');
  expect(dark['--gm3-sys-color-outline']).toBe('#8e918f');
  expect(dark['--gm3-sys-color-outline-variant']).toBe('#444746');
  expect(dark['--gm3-sys-color-primary']).toBe('#a8c7fa');
});
test('every var(--x) used in packages/ui CSS is defined', () => { expect(undefinedTokens()).toEqual([]); });
// fonts.browser.test.ts
test('bundled families load with no network fetch', async () => {
  await registerFonts();
  for (const f of ['Google Sans', 'Google Sans Text', 'Google Sans Flex', 'Material Symbols Outlined']) expect(document.fonts.check(`14px "${f}"`)).toBe(true);
  expect(performance.getEntriesByType('resource').filter((e) => /fonts\.(googleapis|gstatic)\.com/.test(e.name))).toEqual([]);
});
test('"Google Sans Text" at 14 px matches Google Sans at opsz 17 and differs from opsz 18', async () => {
  const w = (style: string) => measureSpan('Handgloves Illustrated', style);
  expect(w('font: 14px "Google Sans Text"')).toBeCloseTo(w('font: 14px "Google Sans"; font-variation-settings: "opsz" 17'), 2);
  expect(w('font: 14px "Google Sans Text"')).not.toBeCloseTo(w('font: 14px "Google Sans"; font-variation-settings: "opsz" 18'), 2);
});
// Icon.browser.test.tsx
test('Icon renders Material Symbols Outlined at weight 400, FILL 0 by default', async () => {
  const el = render(<Icon name="download" size={20} />);
  expect(getComputedStyle(el).fontVariationSettings).toBe('"FILL" 0, "wght" 400, "GRAD" 0, "opsz" 20');
  expect(el.getBoundingClientRect().width).toBeCloseTo(20, 0);
});
test('every ICON_NAMES entry resolves to a single glyph', async () => {
  for (const n of ICON_NAMES) expect(render(<Icon name={n} size={24} />).getBoundingClientRect().width).toBeLessThanOrEqual(25);
});
```

- [ ] **Step 2: Run them and confirm they fail.** Run: `pnpm vitest run packages/ui`. Expected: FAIL (missing `tokens.css` and `register.ts`).

- [ ] **Step 3: Implement**
  - **`tokens.css`.** Copy the `:root` block of 02 §3.1 verbatim, then add:
    - the spacing scale `--space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px; --space-5: 20px; --space-6: 24px; --space-8: 32px; --space-10: 40px; --space-12: 48px; --space-14: 56px; --space-16: 64px`;
    - viewer dimensions from 02 §4.10: `--viewer-header-h: 64px; --viewer-pill-h: 48px; --viewer-pill-pad: 8px; --icon-btn: 32px; --icon-btn-lg: 40px; --menubar-btn-h: 24px; --menu-dark-w: 288px; --menu-dark-item-h: 36px; --menu-item-h: 32px; --menu-separator-gap: 8px; --page-gap: 16px; --rail-w: 196px; --thumb-num-w: 28px; --menu-light-min-w: 320px`;
    - viewer colours: `--viewer-page-placeholder: rgba(68,71,70,.2); --viewer-icon-hover: #3e4041; --viewer-focus: #a8c7fa`.
  - **`tokens-dark.css`.** Apply these values under `[data-theme='dark']`, and under `:root:not([data-theme='light'])` inside `@media (prefers-color-scheme: dark)`:
```css
--gm3-sys-color-background:#131314; --gm3-sys-color-on-background:#e3e3e3; --gm3-sys-color-surface:#131314; --gm3-sys-color-surface-dim:#131314;
--gm3-sys-color-surface-bright:#37393b; --gm3-sys-color-surface-container-lowest:#0e0e0e; --gm3-sys-color-surface-container-low:#1b1b1b;
--gm3-sys-color-surface-container:#1e1f20; --gm3-sys-color-surface-container-high:#282a2c; --gm3-sys-color-surface-container-highest:#333537;
--gm3-sys-color-surface-variant:#444746; --gm3-sys-color-on-surface:#e3e3e3; --gm3-sys-color-on-surface-variant:#c4c7c5;
--gm3-sys-color-outline:#8e918f; --gm3-sys-color-outline-variant:#444746; --gm3-sys-color-primary:#a8c7fa; --gm3-sys-color-on-primary:#062e6f;
--gm3-sys-color-primary-container:#0842a0; --gm3-sys-color-on-primary-container:#d3e3fd; --gm3-sys-color-secondary:#7fcfff;
--gm3-sys-color-secondary-container:#004a77; --gm3-sys-color-on-secondary-container:#c2e7ff; --gm3-sys-color-tertiary:#6dd58c;
--gm3-sys-color-error:#f2b8b5; --gm3-sys-color-on-error:#601410; --gm3-sys-color-error-container:#8c1d18; --gm3-sys-color-on-error-container:#f9dedc;
--gm3-sys-color-inverse-surface:#e3e3e3; --gm3-sys-color-inverse-on-surface:#303030; --gm3-sys-color-inverse-primary:#0b57d0;
```
  - **`register.ts`.** Import `?url` for `@fontsource-variable/google-sans/files/google-sans-latin-full-{normal,italic}.woff2` and the `latin-ext` pair, `@fontsource-variable/google-sans-flex/files/google-sans-flex-latin-full-normal.woff2` and its `latin-ext` file, and `material-symbols/material-symbols-outlined.woff2`. Then:
    - add `FontFace` "Google Sans" and "Google Sans Text" (the same files, `weight: '400 700'`);
    - add "Google Sans Flex" (`weight: '1 1000'`);
    - add "Material Symbols Outlined" (`weight: '100 700'`).

    `base.css` sets `font-variation-settings: "opsz" 17` on `--font-text` roles and `"opsz" 18` on `--font-display` roles.
  - **`ICON_NAMES`:** `open_in_new, download, link, print, library_add, library_add_check, rotate_right, rotate_left, zoom_in, zoom_out, remove, add, arrow_drop_down, auto_stories, slideshow, dark_mode, photo_library, toc, find_in_page, pageview, keyboard, info, arrow_back, close, keyboard_arrow_up, keyboard_arrow_down, left_panel_close, left_panel_open, lock, error, check, undo`.
  - **`extract-mdi.mjs`** writes `file-pdf-box.ts` (`export const FILE_PDF_BOX = { body: '<path …/>', width: 24, height: 24 }`) from `@iconify-json/mdi/icons.json`.

- [ ] **Step 4: Run them again and confirm they pass.** Run: `pnpm vitest run packages/ui && pnpm lint`. Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add packages/ui pnpm-lock.yaml
git commit -m "feat(ui): Drive GM3 tokens, bundled Google Sans fonts, Material Symbols icons"
```

### Task 14: Drive components on Radix (`packages/ui`)

**Files:**
- Create: `packages/ui/src/components/{IconButton,TextButton,Tooltip,Menu,MenuBar,Chip,Dialog,Banner,TextField,PillToolbar}.tsx` and a `.module.css` for each, `packages/ui/src/components/components.browser.test.tsx`
- Modify: `packages/ui/src/index.ts` (exports)

**Interfaces:**
- Consumes: tokens, `Icon` and `IconName` (Task 13).
- Produces:
```ts
export type MenuItemDef =
  | { kind: 'item'; id: string; label: string; icon?: IconName; shortcut?: string; disabled?: boolean; checked?: boolean; onSelect: () => void }
  | { kind: 'separator' };
export interface MenuDef { id: string; label: string; items: MenuItemDef[] }
export function MenuBar(p: { menus: MenuDef[] }): JSX.Element;                                    // Radix Menubar
export function DropdownMenu(p: { trigger: ReactElement; items: MenuItemDef[]; align?: 'start' | 'end' }): JSX.Element;
export function IconButton(p: { icon: IconName; label: string; onClick?: () => void; size?: 32 | 40; pressed?: boolean; disabled?: boolean; shortcut?: string }): JSX.Element;
export function TextButton(p: { label: string; icon?: IconName; onClick?: () => void; disabled?: boolean }): JSX.Element;
export function Tooltip(p: { label: string; shortcut?: string; children: ReactElement }): JSX.Element;
export function Chip(p: { label: string; icon?: IconName; tone: 'neutral' | 'saved' | 'attention'; tooltip?: string; onClick?: () => void; disabled?: boolean }): JSX.Element;
export function Dialog(p: { open: boolean; title: string; children: ReactNode; actions: { label: string; onClick: () => void; primary?: boolean }[]; onOpenChange(open: boolean): void }): JSX.Element;
export function Banner(p: { message: string; actions?: { label: string; onClick: () => void }[]; onDismiss?: () => void }): JSX.Element;
export const TextField: ForwardRefExoticComponent<{ value: string; onChange(v: string): void; label: string; type?: 'text' | 'password'; width?: number; invalid?: boolean; onEnter?(e: KeyboardEvent): void } & RefAttributes<HTMLInputElement>>;
export function PillToolbar(p: { label: string; children: ReactNode }): JSX.Element;               // role="toolbar"
export function ToolbarSeparator(): JSX.Element;
```

- [ ] **Step 1: Write the failing tests**
```tsx
// all inside <div data-theme="dark"> unless noted
test('dark menu matches the Drive viewer File menu (02 §4.10)', async () => {
  const m = await openMenuBar([{ id: 'file', label: 'File', items: FILE_ITEMS }], 'File');
  expect(css(m.content)).toMatchObject({ backgroundColor: 'rgb(40, 42, 44)', borderRadius: '4px', width: '288px', paddingTop: '8px' });
  expect(m.item(0).getBoundingClientRect().height).toBe(36);
  expect(css(m.itemLabel(0)).fontFamily).toMatch(/^"Google Sans Flex"/);
  expect(css(m.shortcut(0))).toMatchObject({ fontSize: '11px', fontWeight: '500' });
  expect(m.separator(0).getBoundingClientRect().height).toBe(17);
  expect(css(m.trigger)).toMatchObject({ backgroundColor: 'rgb(55, 57, 59)', borderRadius: '4px 4px 0px 0px', height: '24px' });
});
test('menubar keyboard: ArrowRight moves to the next menu, Escape closes and refocuses the trigger', async () => { /* File open → ArrowRight → View trigger aria-expanded=true; Escape → no open menu and document.activeElement is the View trigger */ });
test('pill toolbar and icon buttons', async () => {
  const t = render(<PillToolbar label="Document"><IconButton icon="download" label="Download" /></PillToolbar>);
  expect(css(t.root)).toMatchObject({ height: '48px', backgroundColor: 'rgb(51, 53, 55)' });
  expect(t.button.getBoundingClientRect()).toMatchObject({ width: 32, height: 32 });
  await userEvent.hover(t.button);
  expect(css(t.button).backgroundColor).toBe('rgb(62, 64, 65)');
  expect(t.button.getAttribute('aria-label')).toBe('Download');
});
test('tooltips: light #303030 on #f2f2f2 text, dark #e3e3e3 on #303030 text, 12px', async () => { /* light: backgroundColor rgb(48, 48, 48), color rgb(242, 242, 242); dark: backgroundColor rgb(227, 227, 227), color rgb(48, 48, 48); fontSize 12px; top ≥ anchor.bottom + 4 */ });
test('chip tones and focus ring', async () => { /* saved/neutral/attention colours from tokens; focus-visible outline 2px var(--drive-focus-ring) light, var(--viewer-focus) dark */ });
test('visual baselines', async () => {
  await expect.element(page.getByTestId('gallery-dark')).toMatchScreenshot('ui-gallery-dark');
  await expect.element(page.getByTestId('gallery-light')).toMatchScreenshot('ui-gallery-light');
});
```

- [ ] **Step 2: Run them and confirm they fail.** Run: `pnpm vitest run --project browser packages/ui/src/components`. Expected: FAIL (missing exports).

- [ ] **Step 3: Implement**

  Wrap `radix-ui` `Menubar`, `DropdownMenu`, `Tooltip` and `Dialog`. Every value comes from tokens:
  - menu items use `var(--menu-dark-item-h)`;
  - the separator is `var(--menu-separator-gap)` margins plus a 1px `var(--gm3-sys-color-outline-variant)` rule;
  - the pill uses `border-radius: var(--shape-full)` and `background: var(--gm3-sys-color-surface-container-highest)`;
  - icon-button hover is `var(--viewer-icon-hover)`;
  - tooltip text uses `var(--type-tooltip)`.

  Dialogs trap focus and close on Esc. `Banner` uses `role="status"`.

- [ ] **Step 4: Run them again and confirm they pass.** Run: `pnpm vitest run --project browser packages/ui/src/components && pnpm lint`. Expected: PASS. The first run writes the baselines; commit them.

- [ ] **Step 5: Commit**
```bash
git add packages/ui
git commit -m "feat(ui): Drive menus, menubar, pill toolbar, buttons, chips, dialogs on Radix"
```

### Task 15: `PdfBackend` interface and the EmbedPDF implementation

**Files:**
- Create: `patches/@embedpdf__engines@2.15.1.patch` (ported from the spike), root `package.json` `pnpm.patchedDependencies`
- Create: `packages/viewer/src/backend/{types.ts,errors.ts,forms.ts}`
- Create: `packages/viewer/src/backend/embedpdf/{sop-native.ts,engine.worker.ts,rpc.ts,fonts.ts,backend.ts,backend.browser.test.ts}`
- Create: `scripts/fixtures/{make-objects.mjs,make-tagged.mjs,make-password.py}`, `packages/viewer/test/fixtures/password-secret.pdf`
- Modify: `packages/viewer/package.json` (exact `@embedpdf/engines` / `pdfium` / `models` 2.15.1, `@embedpdf/fonts-latin` 1.0.0, `@embedpdf/fonts-sc` 1.0.0), `apps/extension/wxt.config.ts` (`build:publicAssets` copies `pdf/pdfium.wasm`, the 4 NotoSans files and `NotoSansHans-Regular.otf` into `pdf/`), `scripts/fixtures/build.mjs`

**Interfaces:**
- Consumes: `ENGINE` and `ENGINE_WORKERS` (Task 10); the spike's `SpikeNative` methods (Tasks 1, 3, 5, 7).
- Produces (every later viewer task uses these; Phase 2 adds `getGlyphOutlines`):
```ts
export type DocHandle = string & { readonly __doc: unique symbol };
export interface PdfRect { x: number; y: number; width: number; height: number }        // points, unrotated page space, origin top-left
export type Rotation = 0 | 90 | 180 | 270;
export interface PageSize { width: number; height: number; rotation: Rotation }          // rotation = the page's /Rotate
export interface PdfMetadata { title: string | null; author: string | null; subject: string | null; keywords: string | null; creator: string | null; producer: string | null; pdfId: string | null }
export interface OpenResult { doc: DocHandle; pageCount: number; pages: PageSize[]; metadata: PdfMetadata; encrypted: boolean }
export interface TileRequest { pageIndex: number; scale: number /* device px per pt */; rect?: PdfRect; viewRotation: Rotation; withAnnotations: boolean }
export interface Glyph { index: number; text: string; box: PdfRect; tight: PdfRect; fontSize: number; angle: number; generated: boolean }
export interface PageGlyphs { pageIndex: number; glyphs: Glyph[]; runs: { start: number; end: number }[] }
export interface SearchHit { pageIndex: number; start: number; count: number; rects: PdfRect[] }
export type LinkTarget = { kind: 'page'; pageIndex: number; top: number | null; left: number | null } | { kind: 'url'; url: string };
export interface PdfLink { rect: PdfRect; target: LinkTarget }
export interface OutlineItem { title: string; target: LinkTarget | null; children: OutlineItem[] }
export type FormType = 'none' | 'acroform' | 'xfa-full' | 'xfa-foreground';
export interface FormInfo { formType: FormType; firstFillablePage: number | null }
export type PageObjectType = 'text' | 'path' | 'image' | 'shading' | 'form' | 'unknown';
export interface PageObjectInfo { type: PageObjectType; bounds: PdfRect; formDepth: number; markedContentId: number;
  image?: { pixelWidth: number; pixelHeight: number; filters: string[] }; path?: { segmentCount: number; filled: boolean; stroked: boolean } }
export interface PageObjectList { objects: PageObjectInfo[]; truncated: boolean }
export interface StructElement { type: string; altText: string | null; actualText: string | null; markedContentIds: number[]; children: StructElement[] }
export interface PdfBackend {
  open(bytes: ArrayBuffer, opts?: { password?: string }): Promise<OpenResult>;   // bytes are transferred to the worker
  close(doc: DocHandle): Promise<void>;
  renderTile(doc: DocHandle, req: TileRequest, signal?: AbortSignal): Promise<ImageBitmap>;
  getPageGlyphs(doc: DocHandle, pageIndex: number): Promise<PageGlyphs>;
  getPageText(doc: DocHandle, pageIndex: number): Promise<string>;
  getTextRange(doc: DocHandle, pageIndex: number, start: number, count: number): Promise<string>;
  searchPage(doc: DocHandle, pageIndex: number, query: string, opts: { matchCase: boolean; wholeWord: boolean }): Promise<SearchHit[]>;
  getLinks(doc: DocHandle, pageIndex: number): Promise<PdfLink[]>;
  getOutline(doc: DocHandle): Promise<OutlineItem[]>;
  getFormInfo(doc: DocHandle): Promise<FormInfo>;
  listPageObjects(doc: DocHandle, pageIndex: number, opts?: { recurseForms?: boolean; maxObjects?: number; budgetMs?: number }): Promise<PageObjectList>;
  getStructTree(doc: DocHandle, pageIndex: number): Promise<StructElement[]>;
}
export function hasFillableFields(info: FormInfo): boolean;
export class PdfPasswordError extends Error { readonly wrongPassword: boolean }
export class PdfFormatError extends Error {}
export interface EngineAssets { wasmUrl: string; fontBaseUrl: string }
export function createEmbedPdfBackend(assets: EngineAssets, opts?: { workers?: 1 | 2 }): PdfBackend;
```

- [ ] **Step 1: Generate the fixtures**

  `make-objects.mjs` and `make-tagged.mjs` are ported from the spike. `make-password.py` runs once with `python3 -I` (pypdf): it writes `password-secret.pdf`, 2 pages, AES-256, user password `secret`, and that file is committed. `build.mjs` now also writes `test-assets/{objects,tagged}.pdf`.

- [ ] **Step 2: Write the failing tests**
```ts
// backend.browser.test.ts; fixtureBytes(name) fetches /@fs/<repo>/test-assets/<name>
const be = createEmbedPdfBackend({ wasmUrl: pdfiumWasmUrl, fontBaseUrl: '/@fs/<repo>/node_modules/@embedpdf/fonts-latin/fonts/' });
test('open paper-50', async () => {
  const r = await be.open(await fixtureBytes('paper-50.pdf'));
  expect(r.pageCount).toBe(50);
  expect(r.pages[0]).toEqual({ width: expect.closeTo(612, 0.5), height: expect.closeTo(792, 0.5), rotation: 0 });
});
test('renderTile at scale 4/3 gives an 816×1056 bitmap with ink', async () => { /* width 816 ±1, ink > 2% */ });
test('glyphs, page text and ranges', async () => {
  expect((await be.getPageText(doc, 0))).toContain('Household Wealth');
  const g = await be.getPageGlyphs(doc, 0); expect(g.glyphs.length).toBeGreaterThan(1000);
  expect(await be.getTextRange(doc, 0, g.runs[0].start, g.runs[0].end - g.runs[0].start)).toBe(g.glyphs.slice(g.runs[0].start, g.runs[0].end).map((x) => x.text).join(''));
});
test('searchPage finds "wealth" with rects', async () => { expect((await be.searchPage(doc, 0, 'wealth', { matchCase: false, wholeWord: false })).length).toBeGreaterThan(0); });
test('links and outline', async () => {
  expect((await be.getLinks(attention, 0)).some((l) => l.target.kind === 'page')).toBe(true);
  expect((await be.getOutline(thinkpython)).length).toBeGreaterThanOrEqual(10);
});
test('form info (P0-7 vectors)', async () => {
  for (const f of NOT_FORMS) expect(hasFillableFields(await be.getFormInfo(await openFixture(f)))).toBe(false);
  expect(hasFillableFields(await be.getFormInfo(await openFixture('classifier/not-learning/tax-form-hmrc-sa100-2026.pdf')))).toBe(true);
});
test('listPageObjects and getStructTree', async () => {
  const o = await be.listPageObjects(objects, 0, { recurseForms: true });
  expect(o.truncated).toBe(false);
  expect(o.objects.filter((x) => x.type === 'image')).toHaveLength(1);
  expect((await be.listPageObjects(objects, 1, { maxObjects: 20000, budgetMs: 15 })).truncated).toBe(true);
  expect(await be.getStructTree(tagged, 0)).toContainEqual(expect.objectContaining({ type: expect.stringMatching(/Document|Part|Sect|Figure/) }));
  expect(JSON.stringify(await be.getStructTree(tagged, 0))).toContain('"altText":"Bar chart of test scores"');
});
test('password: wrong then right', async () => {
  await expect(be.open(await fixtureBytes('password-secret.pdf'), { password: 'nope' })).rejects.toMatchObject({ name: 'PdfPasswordError', wrongPassword: true });
  expect((await be.open(await fixtureBytes('password-secret.pdf'), { password: 'secret' })).encrypted).toBe(true);
});
test('a corrupt file rejects with PdfFormatError', async () => {
  await expect(be.open(new TextEncoder().encode('<html>login</html>').buffer)).rejects.toBeInstanceOf(PdfFormatError);
});
test('only same-origin requests (wasm, fonts, fixtures)', () => {
  expect(performance.getEntriesByType('resource').map((e) => new URL(e.name).origin).every((o) => o === location.origin)).toBe(true);
});
```

- [ ] **Step 3: Run them and confirm they fail.** Run: `pnpm fixtures && pnpm vitest run --project browser packages/viewer/src/backend`. Expected: FAIL (missing `createEmbedPdfBackend`).

- [ ] **Step 4: Implement**
  - **`SopPdfiumNative extends PdfiumNative`** (relies on the protected `pdfiumModule` and `cache` from the patch). It adds:
    - `renderBitmap`: `renderPageRect` → `createImageBitmap(new ImageData(...))`;
    - `getGlyphs`, `getTextRange`, `getFormInfo`, `listPageObjects` and `getStructTree`, ported from the spike. `getStructTree` reads type, alt text, actual text and marked-content ids recursively to depth 32.
  - **`engine.worker.ts`:**
    - on init, fetches the wasm, calls `init({ wasmBinary })` and builds the native instance with `fontFallback: bundledFontFallback(fontBaseUrl)` (the spike's mapping);
    - serves `rpc.ts` messages `{ id, method, args }` → `{ id, ok, value | error: { name, message, wrongPassword? } }`, transferring `ImageBitmap` and `ArrayBuffer`.
  - **`createEmbedPdfBackend`:**
    - starts `opts.workers` workers with `new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' })`;
    - with two workers, the document opens in both, and pages are routed by `pageIndex % 2`;
    - maps PDFium error code 4 (`FPDF_ERR_PASSWORD`) to `PdfPasswordError` (`wrongPassword` = a password was supplied), and codes 2 and 3 to `PdfFormatError`;
    - `AbortSignal` drops the reply and the render-queue entry.
  - **`hasFillableFields`:** `info.formType.startsWith('xfa') || info.firstFillablePage !== null`.

- [ ] **Step 5: Run them again and confirm they pass.** Run: `pnpm vitest run --project browser packages/viewer/src/backend`. Expected: PASS.

- [ ] **Step 6: Commit**
```bash
git add patches package.json pnpm-lock.yaml packages/viewer scripts/fixtures apps/extension/wxt.config.ts
git commit -m "feat(viewer): PdfBackend adapter with EmbedPDF 2.15.1 in our own worker"
```

### Task 16: Takeover: DNR rules, the Chrome 128 check, the `file://` fallback, Referer, form-post exclusion

**Files:**
- Create: `apps/extension/src/background/takeover/{rules.ts,rules.test.ts,feature-check.ts,feature-check.test.ts,register.ts,file-fallback.ts,request-log.ts,referer.ts,messages.ts,LICENSE.pdfjs}`
- Create: `apps/extension/src/shared/{viewer-url.ts,viewer-url.test.ts,messages.ts}`, `apps/extension/src/entrypoints/embed.content/index.ts`
- Create: `e2e/takeover.spec.ts`
- Modify: `apps/extension/src/entrypoints/background.ts`, `e2e/support/header-cases.ts`, `e2e/support/server.ts`

Every file adapted from `pdf.js/extensions/chromium` (`pdfHandler.js`, `preserve-referer.js`, `contentscript.js`) starts with the pdf.js Apache-2.0 header, followed by `Modified for sickofpdfs, 2026`. `LICENSE.pdfjs` is a copy of pdf.js's `LICENSE`.

**Interfaces:**
- Consumes: the extension build and the e2e fixtures (Task 12).
- Produces:
```ts
// shared/viewer-url.ts
export interface ViewerParams { source: string | null; back: string | null; page: number | null }
export const VIEWER_PATH = 'viewer.html';
export function parseViewerUrl(href: string): ViewerParams;          // handles "?DNR:<raw url>" and "?file=<enc>&back=<enc>#page=N"
export function buildViewerUrl(p: ViewerParams): string;
// shared/messages.ts
export type RuntimeMessage =
  | { type: 'takeover:prepare-fetch'; url: string }        // → { referer: string | null }
  | { type: 'takeover:sniffed'; url: string }              // content script: Chrome shows a sniffed PDF
  | { type: 'takeover:can-take-over'; url: string }        // → boolean (false after POST or while escaped)
  | { type: 'takeover:open-file-settings' }
  | { type: 'takeover:open-in-chrome'; url: string }       // Task 17
  | { type: 'takeover:embedded'; url: string }             // Task 17
  | { type: 'takeover:suppress-embeds'; pageUrl: string }; // Task 17
// background/takeover
export function buildTakeoverRules(viewerUrl: string): chrome.declarativeNetRequest.Rule[];
export interface DnrLike { updateSessionRules(o: chrome.declarativeNetRequest.UpdateRuleOptions): Promise<void> }
export function isHeaderConditionSupported(dnr: DnrLike): Promise<boolean>;
export type TakeoverMode = 'dnr' | 'content-script';
export function registerTakeover(): Promise<TakeoverMode>;          // once per browser session (chrome.storage.session flag)
export function installFileFallback(): void;
export function installRequestLog(): void;
export function getRequestInfo(tabId: number, frameId: number): { referer: string | null; method: string } | null;
export function setStickyReferer(tabId: number, url: string, referer: string): Promise<number>;  // returns the session rule id
```

- [ ] **Step 1: Write the failing unit tests**
```ts
test('rules: order, priorities and actions', () => {
  const r = buildTakeoverRules('chrome-extension://x/viewer.html');
  expect(r.map((x) => [x.id, x.priority, x.action.type])).toEqual([[1,6,'redirect'],[2,5,'allow'],[3,4,'allow'],[4,3,'redirect'],[5,2,'redirect'],[6,1,'redirect']]);
  expect(r[0].condition).toMatchObject({ regexFilter: '^file://.*\\.pdf$', resourceTypes: ['main_frame', 'sub_frame'] });
  expect(r[0].condition.isUrlFilterCaseSensitive ?? false).toBe(false);
  expect(r[3].condition).toMatchObject({ excludedRequestMethods: ['post'], responseHeaders: [{ header: 'content-type', values: ['application/pdf', 'application/pdf;*'] }] });
  expect(r[3].action.redirect!.regexSubstitution).toBe('chrome-extension://x/viewer.html?DNR:\\0');
  expect(r[1].condition).toMatchObject({ resourceTypes: ['sub_frame'], responseHeaders: [{ header: 'content-disposition', values: ['attachment*'] }] });
  expect(r[2].condition).toMatchObject({ urlFilter: '=download', resourceTypes: ['main_frame'] });
  expect(r[5].condition.excludedResponseHeaders).toEqual([{ header: 'content-type', excludedValues: ['application/octet-stream', 'application/octet-stream;*'] }]);
});
test('feature check: false when the condition throws, false when validation is skipped, true when it validates', async () => {
  expect(await isHeaderConditionSupported(fakeDnr({ throwsOnFirst: true }))).toBe(false);
  expect(await isHeaderConditionSupported(fakeDnr({ acceptsAll: true }))).toBe(false);
  expect(await isHeaderConditionSupported(fakeDnr({ rejectsEmptyHeaders: true }))).toBe(true);
  expect(lastFake.sessionRuleIds()).toEqual([]); // probe rule 123456 always removed
});
test('viewer URLs', () => {
  expect(parseViewerUrl('chrome-extension://id/viewer.html?DNR:https://a.org/x.pdf?y=1&z=2')).toEqual({ source: 'https://a.org/x.pdf?y=1&z=2', back: null, page: null });
  const p = { source: 'file:///C:/a b/c%23d.pdf', back: 'https://moodle.x/course/view.php?id=3', page: 3 };
  expect(parseViewerUrl(buildViewerUrl(p))).toEqual(p);
});
```

- [ ] **Step 2: Write the failing e2e tests**
```ts
// e2e/support/header-cases.ts
export const HEADER_CASES = [
  { path: '/h/plain.pdf', ct: 'application/pdf', expect: 'viewer' },
  { path: '/h/charset', ct: 'application/pdf; charset=binary', expect: 'viewer' },
  { path: '/h/octet.pdf', ct: 'application/octet-stream', expect: 'viewer' },
  { path: '/h/octet-noext', ct: 'application/octet-stream', cd: 'attachment; filename="a.pdf"', expect: 'download' },
  { path: '/h/attachment.pdf', ct: 'application/pdf', cd: 'attachment; filename="a.pdf"', expect: 'viewer' },
  { path: '/h/x?type=download', ct: 'application/pdf', cd: 'attachment; filename="a.pdf"', expect: 'download' },
  { path: '/h/cd-inline', ct: 'text/plain', cd: 'inline; filename="a.pdf"', expect: 'viewer' },
  { path: '/h/no-ctype.pdf', ct: null, expect: 'viewer' },           // content-script sniff path
] as const;
// e2e/takeover.spec.ts
for (const c of HEADER_CASES) test(`header case ${c.path} → ${c.expect}`, async ({ context, server }) => { /* viewer: waitForURL(/viewer\.html/) and parseViewerUrl(url).source === server.url(c.path); download: waitForEvent('download'); chrome: url still server.url(c.path) after 2 s */ });
test('form POST returning a PDF stays in Chrome\'s viewer, also after 2 s (no sniff redirect)', async ({ context, server }) => {
  const page = await context.newPage(); await page.goto(server.url('/h/post-form')); await page.click('button[type=submit]');
  await page.waitForURL(server.url('/h/post')); await page.waitForTimeout(2000);
  expect(page.url()).toBe(server.url('/h/post'));
});
test('Referer is preserved on the viewer re-fetch', async ({ context, server }) => {
  const page = await context.newPage(); await page.goto(server.url('/h/referer-page')); await page.click('a#pdf');
  await page.waitForURL(/viewer\.html/);
  const status = await page.evaluate(async (u) => { await chrome.runtime.sendMessage({ type: 'takeover:prepare-fetch', url: u }); return (await fetch(u)).status; }, server.url('/h/needs-referer.pdf'));
  expect(status).toBe(200);   // the server answers 403 unless Referer === <origin>/h/referer-page
});
test('awkward file names open in the viewer (Review Focus 2)', async ({ context }) => {
  for (const name of ['Week 3 – café #2.PDF', 'cafe\u0301 100% done.pdf', 'a b.pdf']) {
    const f = await copyFixture('paper-50.pdf', join(tmp, 'dir with spaces', name));
    const page = await context.newPage(); await page.goto(pathToFileURL(f).href);
    await page.waitForURL(/viewer\.html/);
    const src = parseViewerUrl(page.url()).source!;
    expect(await page.evaluate((u) => new Promise((r) => { const x = new XMLHttpRequest(); x.open('GET', u); x.responseType = 'arraybuffer'; x.onload = () => r(x.response.byteLength); x.send(); }), src)).toBe(statSync(f).size);
  }
});
test.describe('without file access', () => {
  test.use({ profile: 'bare' });
  test('file:// goes to the viewer with ?file= via webNavigation', async ({ context }) => { /* page.url() matches /viewer\.html\?file=file%3A/ */ });
});
test('registerTakeover runs once per session and reports dnr', async ({ sw }) => {
  expect(await sw.evaluate(() => chrome.storage.session.get('takeoverMode'))).toEqual({ takeoverMode: 'dnr' });
  expect((await sw.evaluate(() => chrome.declarativeNetRequest.getDynamicRules())).length).toBe(6);
});
```

- [ ] **Step 3: Run them and confirm they fail.** Run: `pnpm vitest run apps/extension/src/background apps/extension/src/shared && pnpm e2e e2e/takeover.spec.ts`. Expected: FAIL (missing modules; no redirect happens).

- [ ] **Step 4: Implement**
  - **Rules.** Port pdf.js `registerPdfRedirectRule` without the `pdfjs.action=download` rule, in the six-rule order tested above.
  - **Feature check.** `isHeaderConditionSupported` is pdf.js's two-step probe with rule id 123456.
  - **`registerTakeover`.** It clears the dynamic rules and adds ours when the probe passes. It always sets `chrome.storage.session.takeoverMode`.
  - **`installFileFallback`.** It listens to `webNavigation.onBeforeNavigate` with url filters `{ urlPrefix: 'file://', urlSuffix: '.pdf' }` and `{ urlPrefix: 'file://', urlSuffix: '.PDF' }`, frame 0. When `!isAllowedFileSchemeAccess`, it calls `tabs.update(tabId, { url: buildViewerUrl({ source: url, back: null, page: null }) })`.
  - **`installRequestLog`.** Port of `preserve-referer.js`: `webRequest.onSendHeaders` for `main_frame`/`sub_frame` with `['requestHeaders', 'extraHeaders']`. It records the Referer and method per tab and frame for 5 minutes.
  - **`setStickyReferer`.** It adds a session rule for the viewer's own requests:
    - condition: `urlFilter: '|' + url + '|'`, `initiatorDomains: [chrome.runtime.id]`, `resourceTypes: ['xmlhttprequest']`, `tabIds: [tabId]`;
    - action: `modifyHeaders`, setting `referer`.

    It is removed when the tab navigates.
  - **Content script** (`embed.content/index.ts`, `document_start`, all frames, http/https/file):
    - if `document.contentType === 'application/pdf'` and `await sendMessage({ type: 'takeover:can-take-over', url: location.href })` is true, it sends `takeover:sniffed`;
    - the service worker answers with `tabs.update(sender.tab.id, { url: buildViewerUrl(...) })`, but only for frame 0;
    - `can-take-over` is false when the logged method was POST, and while the tab is escaped (Task 17).

- [ ] **Step 5: Run them again and confirm they pass.** Run: `pnpm vitest run apps/extension/src/background apps/extension/src/shared && pnpm e2e e2e/takeover.spec.ts`. Expected: PASS.

- [ ] **Step 6: Commit**
```bash
git add apps/extension/src e2e
git commit -m "feat(takeover): DNR redirect rules with Chrome 128 probe, file fallback, Referer, POST exclusion"
```

### Task 17: Embedded PDFs with "Back to page", and the escape hatch

**Files:**
- Create: `apps/extension/src/background/takeover/{escape.ts,escape.test.ts,embedded.ts}`, `apps/extension/src/entrypoints/embed.content/style.css`
- Create: `apps/extension/src/viewer/{frame-escape.ts,back-to-page.ts}`, `e2e/embedded.spec.ts`, `e2e/escape.spec.ts`
- Modify: `apps/extension/src/entrypoints/embed.content/index.ts`, `apps/extension/src/background/takeover/messages.ts`, `apps/extension/src/entrypoints/viewer/main.tsx`

**Interfaces:**
- Consumes: `buildViewerUrl`, `parseViewerUrl`, `RuntimeMessage` (Task 16).
- Produces:
```ts
export function escapeForRegexFilter(url: string): string;                 // RE2-safe, anchored ^…$
export function openInChromeViewer(tabId: number, url: string): Promise<void>; // one-time allow rule for this url + tab, then tabs.update
export function isEscaped(tabId: number, url: string): Promise<boolean>;      // chrome.storage.session, 60 s expiry
export function openEmbeddedInTab(tabId: number, url: string, pageUrl: string): Promise<void>;
export function suppressEmbeds(tabId: number, pageUrl: string): Promise<void>;
export function areEmbedsSuppressed(tabId: number, pageUrl: string): Promise<boolean>;
// viewer
export function maybeLeaveFrame(p: ViewerParams): boolean;   // true when inside a frame and the full-tab open was requested
export function goBackToPage(p: ViewerParams): Promise<void>; // suppressEmbeds(back), then history.back() (or location.assign(back) when history.length === 1)
```

- [ ] **Step 1: Write the failing tests**
```ts
// escape.test.ts
test('escapeForRegexFilter anchors and escapes RE2 metacharacters', () => {
  expect(escapeForRegexFilter('https://a.org/x(1).pdf?q=a+b&r=[2]')).toBe('^https://a\\.org/x\\(1\\)\\.pdf\\?q=a\\+b&r=\\[2\\]$');
});
// e2e/escape.spec.ts
test('Open in Chrome\'s viewer uses a one-time allow rule', async ({ openViewer, server, sw }) => {
  const src = server.url('/h/plain.pdf'); const page = await openViewer(src);
  await page.evaluate((u) => chrome.runtime.sendMessage({ type: 'takeover:open-in-chrome', url: u }), src);
  await page.waitForURL(src); await page.waitForTimeout(2000);
  expect(page.url()).toBe(src);                                                            // the sniff path did not bounce it back
  expect((await sw.evaluate(() => chrome.declarativeNetRequest.getSessionRules())).filter((r) => r.action.type === 'allow')).toEqual([]);
  await page.goto(src); await page.waitForURL(/viewer\.html/);                             // the next visit is ours again
});
test('the escape hatch works for file:// too', async ({ openViewer }) => { /* the three assertions above with pathToFileURL(copy of paper-50.pdf) */ });
// e2e/embedded.spec.ts
for (const kind of ['embed', 'object', 'iframe'] as const) test(`${kind}-embedded PDF opens in the full tab with back=page`, async ({ context, server }) => {
  const page = await context.newPage(); await page.goto(server.url(`/h/${kind}-page`));
  await page.waitForURL(/viewer\.html/);
  expect(parseViewerUrl(page.url())).toMatchObject({ source: server.url('/h/plain.pdf'), back: server.url(`/h/${kind}-page`) });
});
test('Back to page returns and does not bounce again', async ({ context, server }) => {
  const page = await context.newPage(); await page.goto(server.url('/h/embed-page')); await page.waitForURL(/viewer\.html/);
  await page.getByRole('button', { name: 'Back to page' }).click();
  await page.waitForURL(server.url('/h/embed-page')); await page.waitForTimeout(2000);
  expect(page.url()).toBe(server.url('/h/embed-page'));
  await expect(page.locator('embed[type="application/pdf"]')).toHaveCount(1);
});
test('an iframe serving Content-Disposition attachment downloads and leaves the page alone', async ({ context, server }) => { /* waitForEvent('download'); url unchanged */ });
```

- [ ] **Step 2: Run them and confirm they fail.** Run: `pnpm vitest run apps/extension/src/background/takeover/escape.test.ts && pnpm e2e e2e/embedded.spec.ts e2e/escape.spec.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**
  - **`openInChromeViewer`.** Allocate a rule id from a `chrome.storage.session` counter starting at 1000. Add the session rule:
    - `priority: 100`;
    - condition: `{ regexFilter: escapeForRegexFilter(url), tabIds: [tabId], resourceTypes: ['main_frame'] }`;
    - action: `{ type: 'allow' }`.

    Store `escaped[tabId] = { url, until: now + 60000 }`, then call `tabs.update(tabId, { url })`. Remove the rule when one of these comes first: `webNavigation.onCommitted` (frame 0, the same url), the tab navigating elsewhere, or `tabs.onRemoved`.
  - **Embed detection.** `style.css` holds the pdf.js keyframes trick, renamed `sop-detect-embed`, on `object, embed`. The content script ports `watchObjectOrEmbed`, with the same skip rules: `about:blank` src, Chrome's own full-page `name="plugin"` embed, and a non-PDF type. A detected PDF sends `takeover:embedded { url: absolute src }` unless `areEmbedsSuppressed`. The service worker then calls `openEmbeddedInTab(sender.tab.id, url, sender.tab.url)`.
  - **Frame escape.** `maybeLeaveFrame` runs in the viewer. When `window.top !== window`, it sends `takeover:embedded` with `source` and shows "Opening in the full tab…". When suppressed, it stays and renders inside the frame.
  - **Back to page.** The viewer root shows a "Back to page" `TextButton` (icon `arrow_back`) when `back` is set. Task 23 moves it into the header.

- [ ] **Step 4: Run them again and confirm they pass.** Run: `pnpm vitest run apps/extension/src/background/takeover/escape.test.ts && pnpm e2e e2e/embedded.spec.ts e2e/escape.spec.ts`. Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add apps/extension/src e2e
git commit -m "feat(takeover): embedded PDFs open full-tab with Back to page; one-time escape to Chrome's viewer"
```

### Task 18: Identity core: fingerprints, canonical links and location ids

**Files:**
- Create: `packages/core/src/ids.ts`, `packages/core/src/identity/{fingerprint.ts,fingerprint.test.ts,canonical-link.ts,canonical-link.test.ts,location.ts,location.test.ts}`
- Modify: `packages/core/package.json` (exact `hash-wasm` 4.12.0), `packages/core/src/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
```ts
export type Sha256 = string & { readonly __sha256: unique symbol };      // 64 lowercase hex
export type DocumentId = Sha256;
export type LocationId = string & { readonly __location: unique symbol };
export type LocationKind = 'url' | 'file';
export interface Sha256Hasher { update(chunk: Uint8Array): void; digest(): Sha256 }
export function createSha256(): Promise<Sha256Hasher>;
export function sha256Hex(data: Uint8Array | string): Promise<Sha256>;
export function cleanLink(url: string): string;            // tracking/token params removed, fragment dropped, params sorted; used by "Copy link"
export function canonicalLink(url: string): string;        // cleanLink + https + host rules (below); non-http(s) returned unchanged
export function canonicalFileLocation(fileUrl: string): string;
export function canonicalLocation(kind: LocationKind, raw: string): string;
export function locationId(kind: LocationKind, canonical: string): Promise<LocationId>;  // sha256Hex(`${kind}:${canonical}`)
```

- [ ] **Step 1: Write the failing tests (the normative test vectors)**
```ts
test('sha256', async () => {
  expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const h = await createSha256(); const bytes = await readFile('test-assets/classifier/learning/arxiv-1706.03762-attention.pdf');
  for (let i = 0; i < bytes.length; i += 65536) h.update(bytes.subarray(i, i + 65536));
  expect(h.digest()).toBe('bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697');
});
const LINK_VECTORS: [string, string][] = [
  ['http://www.jstor.org/stable/pdf/1234.pdf?utm_source=x&refreqid=fastly-default%3Aabc', 'https://jstor.org/stable/pdf/1234.pdf'],
  ['https://example.ac.uk/a.pdf?b=2&a=1#page=3', 'https://example.ac.uk/a.pdf?a=1&b=2'],
  ['https://EXAMPLE.org:443/Path/A.PDF', 'https://example.org/Path/A.PDF'],
  ['https://site.org/x.pdf?fbclid=1&gclid=2&dclid=3&msclkid=4&mc_cid=5&mc_eid=6&_ga=7&_gl=8&igshid=9&yclid=10&ref_src=11', 'https://site.org/x.pdf'],
  ['https://b.s3.amazonaws.com/f.pdf?X-Amz-Algorithm=A&X-Amz-Credential=c&X-Amz-Date=d&X-Amz-Expires=300&X-Amz-SignedHeaders=host&X-Amz-Signature=s&X-Amz-Security-Token=t', 'https://b.s3.amazonaws.com/f.pdf'],
  ['https://d1.cloudfront.net/f.pdf?Expires=1&Signature=2&Key-Pair-Id=3&Policy=4', 'https://d1.cloudfront.net/f.pdf'],
  ['https://storage.googleapis.com/b/f.pdf?GoogleAccessId=a&X-Goog-Signature=b&X-Goog-Expires=c', 'https://storage.googleapis.com/b/f.pdf'],
  ['https://site.org/f.pdf?token=abc&access_token=def&id_token=g&id=7', 'https://site.org/f.pdf?id=7'],
  ['http://arxiv.org/pdf/1706.03762v7', 'https://arxiv.org/abs/1706.03762'],
  ['https://arxiv.org/pdf/1706.03762v5.pdf', 'https://arxiv.org/abs/1706.03762'],
  ['https://arxiv.org/abs/1706.03762v2', 'https://arxiv.org/abs/1706.03762'],
  ['https://export.arxiv.org/abs/hep-th/9901001v3', 'https://arxiv.org/abs/hep-th/9901001'],
  ['https://www.arxiv.org/pdf/2301.00001', 'https://arxiv.org/abs/2301.00001'],
  ['http://dx.doi.org/10.1371/JOURNAL.PONE.0000308', 'https://doi.org/10.1371/journal.pone.0000308'],
  ['https://doi.org/10.1000%2F182', 'https://doi.org/10.1000/182'],
  ['https://moodle.lse.ac.uk/pluginfile.php/123456/mod_resource/content/7/Week%203.pdf?forcedownload=1', 'https://moodle.lse.ac.uk/pluginfile.php/123456/mod_resource/content/0/Week%203.pdf'],
  ['https://moodle.lse.ac.uk/webservice/pluginfile.php/1/mod_folder/content/12/a.pdf?token=xyz', 'https://moodle.lse.ac.uk/pluginfile.php/1/mod_folder/content/0/a.pdf'],
  ['https://moodle.lse.ac.uk/pluginfile.php/99/mod_label/intro/a.pdf', 'https://moodle.lse.ac.uk/pluginfile.php/99/mod_label/intro/a.pdf'],
  ['https://www-jstor-org.ezproxy.lse.ac.uk/stable/pdf/1234.pdf', 'https://jstor.org/stable/pdf/1234.pdf'],
  ['https://link-springer-com.libproxy.ucl.ac.uk/content/pdf/10.1007/s1.pdf', 'https://link.springer.com/content/pdf/10.1007/s1.pdf'],
  ['https://onlinelibrary-wiley-com.ezp.lib.cam.ac.uk/doi/pdf/10.1111/x', 'https://onlinelibrary.wiley.com/doi/pdf/10.1111/x'],
  ['https://www-annualreviews-org.idm.oclc.org/doi/pdf/10.1146/x', 'https://annualreviews.org/doi/pdf/10.1146/x'],
  ['https://www-taylor--francis-com.ezproxy.x.ac.uk/a.pdf', 'https://taylor-francis.com/a.pdf'],
  ['https://ezproxy.lse.ac.uk/login?url=https://www.jstor.org/stable/1234', 'https://jstor.org/stable/1234'],
  ['https://login.ezproxy.lib.ucl.ac.uk/login?qurl=https%3A%2F%2Fwww.jstor.org%2Fstable%2F1234', 'https://jstor.org/stable/1234'],
  ['https://www.ezproxy-docs.org/a.pdf', 'https://ezproxy-docs.org/a.pdf'],
  ['blob:chrome-extension://abc/123', 'blob:chrome-extension://abc/123'],
];
test.each(LINK_VECTORS)('canonicalLink(%s)', (input, out) => expect(canonicalLink(input)).toBe(out));
test('cleanLink keeps host, scheme and arXiv form; strips tracking and fragment', () => {
  expect(cleanLink('http://arxiv.org/pdf/1706.03762v7?utm_medium=x#page=2')).toBe('http://arxiv.org/pdf/1706.03762v7');
});
test.each([
  ['file:///C:/Users/Rex/My%20Docs/caf%C3%A9.pdf', 'file:///C:/Users/Rex/My Docs/café.pdf'],
  ['file:///c:/Users/Rex/a.PDF', 'file:///C:/Users/Rex/a.PDF'],
  ['file:///home/rex/cafe%CC%81.pdf', 'file:///home/rex/café.pdf'],              // NFD → NFC
  ['file:///home/rex/Week%203%20%E2%80%93%20%23notes.pdf', 'file:///home/rex/Week 3 – #notes.pdf'],
  ['file://server/share/a.pdf', 'file://server/share/a.pdf'],
])('canonicalFileLocation(%s)', (i, o) => expect(canonicalFileLocation(i)).toBe(o));
test('locationId', async () => {
  expect(await locationId('url', 'https://jstor.org/stable/pdf/1234.pdf')).toBe('40ea1921427eaadca817d8e9a12e07dcbc9b4e336569adcdbfc273158dd81626');
  expect(canonicalLocation('url', 'http://www.jstor.org/stable/pdf/1234.pdf?utm_source=x')).toBe('https://jstor.org/stable/pdf/1234.pdf');
});
```

- [ ] **Step 2: Run them and confirm they fail.** Run: `pnpm vitest run packages/core/src/identity`. Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

  The rule list is not fixed by the signatures, so here it is.

  `cleanLink` (http(s) only):
  - drop the fragment;
  - delete these query keys, case-insensitive: `utm_*`, `fbclid`, `gclid`, `dclid`, `msclkid`, `mc_cid`, `mc_eid`, `_ga`, `_gl`, `igshid`, `yclid`, `twclid`, `ttclid`, `ref_src`, `refreqid`, `forcedownload`, `token`, `access_token`, `id_token`, `X-Amz-*`, `X-Goog-*`, `GoogleAccessId`, `Expires`, `Signature`, `Key-Pair-Id`, `Policy`;
  - sort the remaining params by key, stably;
  - drop an empty `?`.

  `canonicalLink` applies `cleanLink`, then these in order:
  1. EZproxy `/login?url=` or `?qurl=` (a host containing `ezproxy` or `proxy`): recurse on the decoded target.
  2. Proxy-by-hostname. The rest of the host matches `/(^|\.)(ezproxy|libproxy|ezp|proxy|eresources)\.|\.idm\.oclc\.org$/`, and the first label contains `-`. Decode the first label (`--` → `-`, `-` → `.`). Accept it if the last decoded label matches `/^[a-z]{2,6}$/`, and use the decoded label as the host.
  3. Lower-case the host, drop a leading `www.`, drop the default port, and set the scheme to `https`.
  4. arXiv: hosts `arxiv.org` and `export.arxiv.org`, paths `/abs/` and `/pdf/` with an optional `vN` and `.pdf` → `https://arxiv.org/abs/<id>`.
  5. DOI: hosts `doi.org` and `dx.doi.org` → `https://doi.org/` + the percent-decoded, lower-cased DOI.
  6. Moodle: strip the leading `/webservice` before `/pluginfile.php/`, then replace `/(mod_resource|mod_folder|mod_page|mod_book)/content/\d+/` with `/$1/content/0/`.

  `canonicalFileLocation`:
  - percent-decode the path;
  - NFC-normalise it;
  - upper-case a drive letter;
  - collapse `//` inside the path.

- [ ] **Step 4: Run them again and confirm they pass.** Run: `pnpm vitest run packages/core/src/identity`. Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add packages/core pnpm-lock.yaml
git commit -m "feat(core): streaming SHA-256, canonical links with test vectors, location ids"
```

### Task 19: Identity core: download-stamp stripping and alias similarity

**Files:**
- Create: `packages/core/src/identity/{stamps.ts,stamps.test.ts}`, `e2e/support/stamped-pdf.ts`
- Modify: `packages/core/package.json` (exact `diff-match-patch` 1.0.5, `@types/diff-match-patch` 1.0.36)

**Interfaces:**
- Consumes: nothing.
- Produces:
```ts
export const ALIAS_THRESHOLD = 0.995;
export function stripStamps(pageText: string): string;
export function stampedTextSimilarity(a: readonly string[], b: readonly string[]): number; // 0 when page counts differ
// e2e/support/stamped-pdf.ts
export function makeStampedPdf(stamp: { ip: string; date: string }, body?: 'jstor-body' | 'other-body'): Promise<Uint8Array>; // 8 pages, same body, different stamp, /ID and CreationDate
```

- [ ] **Step 1: Write the failing tests**
```ts
test.each([
  ['Results\nThis content downloaded from 158.143.197.12 on Tue, 31 Oct 2026 10:41:07 UTC\nAll use subject to https://about.jstor.org/terms\nMore', 'Results More'],
  ['Intro\nDownloaded from https://academic.oup.com/qje/article/138/1/1/6750017 by London School of Economics user on 31 October 2026\nBody', 'Intro Body'],
  ['Text\nDownloaded by [London School of Economics] at 10:41 31 October 2026\nEnd', 'Text End'],
  ['Server 10.0.0.1 logged 2026-10-31T10:41:07Z and fe80::1:2:3:4 at 3:15 PM on 31/10/2026', 'Server logged and at on'],
  ['We collected data on 31 October 2025 from 12 sites', 'We collected data on from 12 sites'],
])('stripStamps(%#)', (i, o) => expect(stripStamps(i)).toBe(o));
test('similarity: same body, different stamps → ≥ 0.995', () => {
  expect(stampedTextSimilarity(pagesWithStamp('158.143.1.1', 'Tue, 31 Oct 2026 10:41:07 UTC'), pagesWithStamp('81.2.3.4', 'Wed, 1 Nov 2026 09:00:00 UTC'))).toBeGreaterThanOrEqual(ALIAS_THRESHOLD);
});
test('similarity: one changed word in 30,000 chars still aliases; a different paper does not', () => {
  expect(stampedTextSimilarity(BODY, withOneWordChanged(BODY))).toBeGreaterThanOrEqual(ALIAS_THRESHOLD);
  expect(stampedTextSimilarity(BODY, OTHER_BODY_SAME_PAGE_COUNT)).toBeLessThan(0.5);
});
test('similarity: page count differs → 0', () => expect(stampedTextSimilarity(['a'], ['a', 'b'])).toBe(0));
test('similarity: 300 pages × 3,000 chars compares in < 500 ms', () => { /* performance.now() delta < 500 for two 300-page arrays that differ only by stamps; result ≥ ALIAS_THRESHOLD */ });
```

- [ ] **Step 2: Run them and confirm they fail.** Run: `pnpm vitest run packages/core/src/identity/stamps.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**
  - **`stripStamps`** removes these, in order:
    1. lines matching `/^This content downloaded from .*$/im` and `/^All use subject to https?:\/\/about\.jstor\.org\/terms\s*$/im`;
    2. `/^Downloaded from https?:\/\/\S+( by .+?)? on .+$/im` and `/^Downloaded by \[.+?\] at .+$/im`;
    3. IPv4 `\b(?:\d{1,3}\.){3}\d{1,3}\b` and IPv6 `\b(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{1,4}\b` (case-insensitive);
    4. dates: ISO with an optional time and zone; `D Month YYYY`; `Day, D Mon YYYY[ HH:MM[:SS][ UTC|GMT]]`; `Month D, YYYY`; `D/M/YYYY`; times `H:MM[:SS][ AM|PM|UTC|GMT]`;
    5. then collapse whitespace to single spaces and trim.
  - **`stampedTextSimilarity`:**
    - return 0 when the page counts differ;
    - return 0 when the total stripped lengths differ by more than 0.5%;
    - otherwise run `diff_match_patch` (`Diff_Timeout = 0.1`) per page and return `1 − Σ levenshtein(diffs) / Σ max(lenA, lenB)`;
    - stop early, returning the current value, once the cumulative distance exceeds 0.5% of the total.

- [ ] **Step 4: Run them again and confirm they pass.** Run: `pnpm vitest run packages/core/src/identity/stamps.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add packages/core e2e/support/stamped-pdf.ts pnpm-lock.yaml
git commit -m "feat(core): download-stamp stripping and 99.5% alias similarity"
```

### Task 20: Loading a PDF: fetch, file and picker sources, streaming hash, the 1 GB rule, password, error card

**Files:**
- Create: `packages/viewer/src/source/{load-source.ts,errors.ts,limits.ts,file-name.ts,file-name.test.ts,load-source.browser.test.ts}`
- Create: `apps/extension/src/viewer/open-document.ts`, `apps/extension/src/viewer/ui/{LoadErrorCard,PasswordDialog,FileAccessDialog,LargeFileNotice}.tsx`, `e2e/open.spec.ts`
- Modify: `apps/extension/src/entrypoints/viewer/main.tsx`, `apps/extension/src/viewer/test-hooks.ts`, `e2e/support/server.ts` (adds `once.pdf`, `fake.pdf`, `truncated.pdf`, `huge.pdf`, `password.pdf`)

**Interfaces:**
- Consumes: `createSha256` (Task 18); `PdfBackend`, `PdfPasswordError`, `PdfFormatError` (Task 15); `openInChromeViewer` through `takeover:open-in-chrome` (Task 17); `takeover:prepare-fetch` (Task 16); `MAX_OPEN_BYTES` (Task 10).
- Produces:
```ts
export const MAX_OPEN_BYTES = 1_073_741_824;
export type PdfSourceRef = { kind: 'url'; url: string } | { kind: 'file'; file: File };
export interface LoadedPdf { blob: Blob; sha256: Sha256; size: number; displayName: string; sourceUrl: string | null }
export type PdfLoadErrorCode = 'http' | 'network' | 'not-pdf' | 'too-large' | 'file-access' | 'aborted';
export class PdfLoadError extends Error { constructor(readonly code: PdfLoadErrorCode, readonly detail: { status?: number; size?: number } = {}) }
export function loadPdfSource(ref: PdfSourceRef, opts: { signal?: AbortSignal; maxBytes?: number }): Promise<LoadedPdf>;
export function displayNameFor(url: string | null, contentDisposition: string | null, fallback?: string): string;
// apps/extension/src/viewer/open-document.ts
export interface OpenedDocument { loaded: LoadedPdf; open: OpenResult; password: string | null }
export type OpenOutcome = { kind: 'ready'; doc: OpenedDocument } | { kind: 'error'; error: PdfLoadError | PdfFormatError } | { kind: 'bounced' };
export function openDocument(p: ViewerParams, deps: { backend: PdfBackend; askPassword(retry: boolean): Promise<string | null> }): Promise<OpenOutcome>;
// SopTestHooks gains: backend: PdfBackend; doc(): OpenedDocument | null; viewerState(): 'loading' | 'ready' | 'error' | 'bounced'
```

- [ ] **Step 1: Write the failing tests**
```ts
// file-name.test.ts
test.each([
  [null, "attachment; filename*=UTF-8''caf%C3%A9.pdf", 'café.pdf'],
  [null, 'inline; filename="a b.pdf"', 'a b.pdf'],
  ['https://x.org/dir/Week%203.pdf?x=1', null, 'Week 3.pdf'],
  ['https://arxiv.org/pdf/1706.03762', null, '1706.03762.pdf'],
  ['file:///C:/x/r%C3%A9sum%C3%A9.PDF', null, 'résumé.PDF'],
])('displayNameFor(%s, %s)', (u, cd, n) => expect(displayNameFor(u, cd)).toBe(n));
// load-source.browser.test.ts
test('url source hashes while streaming', async () => {
  const r = await loadPdfSource({ kind: 'url', url: fixtureUrl('classifier/learning/arxiv-1706.03762-attention.pdf') }, {});
  expect(r.sha256).toBe('bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697');
  expect(r.size).toBe(2215244);
});
test('Content-Length above the limit aborts before reading the body', async () => {
  await expect(loadPdfSource({ kind: 'url', url: mockUrl({ contentLength: 1_200_000_000 }) }, {})).rejects.toMatchObject({ code: 'too-large', detail: { size: 1_200_000_000 } });
});
test('streamed bytes above maxBytes abort when there is no Content-Length', async () => { /* chunked mock, maxBytes 1 MiB */ });
test('non-PDF body → not-pdf; HTTP 403 → http/403', async () => {
  await expect(loadPdfSource({ kind: 'url', url: mockUrl({ contentType: 'application/pdf', body: '<html>login</html>' }) }, {})).rejects.toMatchObject({ code: 'not-pdf' });
  await expect(loadPdfSource({ kind: 'url', url: mockUrl({ status: 403 }) }, {})).rejects.toMatchObject({ code: 'http', detail: { status: 403 } });
});
// e2e/open.spec.ts
test('password PDF: wrong then right', async ({ openViewer, server }) => {
  const page = await openViewer(server.url('/h/password.pdf'));
  await page.getByLabel('Password').fill('nope'); await page.keyboard.press('Enter');
  await expect(page.getByText('Incorrect password. Try again.')).toBeVisible();
  await page.getByLabel('Password').fill('secret'); await page.keyboard.press('Enter');
  await expect.poll(() => hooks(page).eval((h) => h.viewerState())).toBe('ready');
});
test('Review Focus 1: a link that works only once shows the error card', async ({ context, server }) => {
  const page = await context.newPage(); await page.goto(server.url('/h/once.pdf'));
  await expect(page.getByText("Couldn't load this PDF")).toBeVisible();
  await expect(page.getByRole('button', { name: "Open in Chrome's viewer" })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Import this PDF' })).toBeVisible();
});
test('Review Focus 1: a login page served as application/pdf', async ({ openViewer, server }) => {
  await expect((await openViewer(server.url('/h/fake.pdf'))).getByText("This link didn't return a PDF")).toBeVisible();
});
test('Review Focus 1: a truncated PDF reaches ready or error with no uncaught error', async ({ openViewer, server }) => {
  const errors: string[] = []; const page = await openViewer(server.url('/h/truncated.pdf')); page.on('pageerror', (e) => errors.push(e.message));
  await expect.poll(() => hooks(page).eval((h) => h.viewerState())).toMatch(/ready|error/); expect(errors).toEqual([]);
});
test('Import this PDF opens a chosen file', async ({ openViewer, server }) => { /* setInputFiles on the card's input → ready */ });
test('a 1.2 GB Content-Length shows the note and bounces to Chrome\'s viewer', async ({ openViewer, server }) => {
  const page = await openViewer(server.url('/h/huge.pdf'));
  await expect(page.getByText(/larger than the 1 GB this viewer opens/)).toBeVisible();
  await page.waitForURL(server.url('/h/huge.pdf'));
});
test.describe('bare profile', () => { test.use({ profile: 'bare' });
  test('file:// without access: dialog with settings button and Choose file', async ({ context }) => { /* dialog text "Allow access to file URLs"; setInputFiles → ready */ });
});
```

- [ ] **Step 2: Run them and confirm they fail.** Run: `pnpm vitest run packages/viewer/src/source && pnpm e2e e2e/open.spec.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**
  - **`loadPdfSource`:**
    - **http(s):** `fetch(url, { credentials: 'include', cache: 'default' })`. Check `Content-Length` against `maxBytes`, then read the stream into chunks while `hasher.update`. Check the first 1024 bytes for `%PDF-` and throw `not-pdf` early if it is missing. Build `blob = new Blob(chunks, { type: 'application/pdf' })`.
    - **`file:`:** XHR with `responseType = 'arraybuffer'`. The first `onprogress` total is checked against the limit; a load error means `file-access`.
    - **`File`:** read `file.stream()`.
  - **`openDocument`:**
    1. `await chrome.runtime.sendMessage({ type: 'takeover:prepare-fetch', url })` for http(s).
    2. `loadPdfSource`.
    3. `backend.open(await loaded.blob.arrayBuffer(), { password })`, looping on `PdfPasswordError` through `askPassword(retry)`.
    4. On `too-large` with a URL source, show `LargeFileNotice` ("This PDF is {size} GB, larger than the 1 GB this viewer opens. Opening it in Chrome's viewer…") with an "Open now" button. Send `takeover:open-in-chrome` after 2000 ms. Return `bounced`.
  - **Copy:**
    - `LoadErrorCard` titles are "Couldn't load this PDF" (http/network/damaged) and "This link didn't return a PDF" (not-pdf). Its buttons are "Open in Chrome's viewer" and "Import this PDF", the latter backed by a hidden `<input type=file accept="application/pdf">`.
    - `PasswordDialog` says "This PDF is password protected" with the field label "Password" and the error "Incorrect password. Try again.".
    - `FileAccessDialog` says "Allow access to file URLs", with the buttons "Open extension settings" (`takeover:open-file-settings` → `tabs.create({ url: 'chrome://extensions/?id=' + chrome.runtime.id })`) and "Choose file".
  - **Backend:** `main.tsx` creates `createEmbedPdfBackend({ wasmUrl: chrome.runtime.getURL('pdf/pdfium.wasm'), fontBaseUrl: chrome.runtime.getURL('pdf/') }, { workers: ENGINE_WORKERS })` once per tab. `performance.mark('sop:first-page')` is set in Task 21.

- [ ] **Step 4: Run them again and confirm they pass.** Run: `pnpm vitest run packages/viewer/src/source && pnpm e2e e2e/open.spec.ts`. Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add packages/viewer apps/extension e2e
git commit -m "feat(viewer): load PDFs with streaming hash, 1 GB rule, password prompt and error card"
```

### Task 21: Virtual page list, render scheduling, zoom modes and keys, keyboard scrolling

**Files:**
- Create: `packages/viewer/src/layout/{zoom.ts,zoom.test.ts,page-layout.ts,page-layout.test.ts}`, `packages/viewer/src/render/{scheduler.ts,scheduler.test.ts}`
- Create: `packages/viewer/src/react/{PageList.tsx,PageView.tsx,viewer-state.ts}`, `apps/extension/src/viewer/{App.tsx,shortcuts.ts,shortcuts.test.ts}`
- Create: `scripts/fixtures/{make-scan.mjs,make-mixed.mjs}`, `e2e/view-zoom.spec.ts`, `e2e/perf-smoke.spec.ts`
- Modify: `scripts/fixtures/build.mjs` (writes `scan-120.pdf`, plus `scan-600.pdf` when `SOP_GATE=1`, and `mixed.pdf`)

**Interfaces:**
- Consumes: `PdfBackend` (Task 15), `ENGINE_WORKERS` (Task 10), `OpenedDocument` (Task 20).
- Produces:
```ts
export const ZOOM_STEPS = [0.25, 0.333, 0.5, 0.666, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4] as const; // Chromium presets, 25–400%
export const MIN_SCALE = 0.25, MAX_SCALE = 4, PAGE_GAP = 16, PT_TO_CSS = 96 / 72;
export type ZoomMode = { kind: 'fit-width' } | { kind: 'fit-page' } | { kind: 'scale'; scale: number };
export function stepZoom(scale: number, dir: 1 | -1): number;
export function wheelZoom(scale: number, deltaY: number, deltaMode: number): number;   // clamp(scale · exp(−deltaPx / 400))
export function resolveScale(mode: ZoomMode, viewport: { width: number; height: number }, pages: PageSize[], o: { viewRotation: Rotation; spread: Spread }): number;
export type Spread = 'none' | 'two-page';
export interface PageBox { index: number; top: number; left: number; width: number; height: number; rotation: Rotation }  // CSS px
export interface PageLayout { boxes: PageBox[]; width: number; height: number }
export function computeLayout(pages: PageSize[], o: { scale: number; viewRotation: Rotation; spread: Spread; viewportWidth: number }): PageLayout;
export function visibleRange(l: PageLayout, scrollTop: number, viewportHeight: number, overscan: number): { first: number; last: number };
export class RenderScheduler {
  constructor(backend: PdfBackend, doc: DocHandle, o: { concurrency: 1 | 2; previewWidthPx: 160; previewCache: 300 });
  request(pageIndex: number, kind: 'preview' | 'full', scale: number, priority: number, rect?: PdfRect): Promise<ImageBitmap>;
  retain(range: { first: number; last: number }): void;   // cancels queued work outside the range
}
export interface ViewerStore { get(): ViewerSnapshot; set(p: Partial<ViewerSnapshot>): void; subscribe(cb: () => void): () => void }
export interface ViewerSnapshot { zoom: ZoomMode; scale: number; currentPage: number; viewRotation: Rotation; spread: Spread; darkPages: boolean; railOpen: boolean }
export function PageList(p: { backend: PdfBackend; doc: OpenedDocument; store: ViewerStore; renderPage?: (box: PageBox) => ReactNode }): JSX.Element;
// shortcuts.ts
export type KeyCombo = string;    // 'Ctrl+=', 'Ctrl+Alt+S', 'Alt+Shift+Digit5', 'F4', 'Shift+F4', '?'
export interface ShortcutDef { id: string; keys: KeyCombo[]; run(e: KeyboardEvent): void; enabled?(): boolean }
export function matchesCombo(e: KeyboardEvent, combo: KeyCombo): boolean;
export function isTypingTarget(t: EventTarget | null): boolean;
export function installShortcuts(defs: ShortcutDef[], target?: Window): () => void;  // capture phase, preventDefault on match
// SopTestHooks gains: viewer: { scale(): number; currentPage(): number; scrollTo(pageIndex: number): Promise<void> }
```

- [ ] **Step 1: Write the failing unit tests**
```ts
test('stepZoom walks ZOOM_STEPS and clamps', () => {
  expect(stepZoom(1, 1)).toBe(1.1); expect(stepZoom(1, -1)).toBe(0.9); expect(stepZoom(1.05, 1)).toBe(1.1);
  expect(stepZoom(4, 1)).toBe(4); expect(stepZoom(0.25, -1)).toBe(0.25);
});
test('wheelZoom is smooth and clamped', () => {
  expect(wheelZoom(1, -100, 0)).toBeCloseTo(Math.exp(0.25), 5); expect(wheelZoom(4, -1000, 0)).toBe(4); expect(wheelZoom(1, -3, 1)).toBeCloseTo(Math.exp(120 / 400), 5);
});
test('layout: three Letter pages at 100%', () => {
  const l = computeLayout([LETTER, LETTER, LETTER], { scale: 1, viewRotation: 0, spread: 'none', viewportWidth: 1200 });
  expect(l.boxes.map((b) => [b.top, b.width, b.height])).toEqual([[16, 816, 1056], [1088, 816, 1056], [2160, 816, 1056]]);
  expect(l.boxes[0].left).toBe(192); expect(l.height).toBe(3232);
});
test('Review Focus 3: mixed sizes and /Rotate 90', () => {
  const l = computeLayout(MIXED, { scale: 1, viewRotation: 0, spread: 'none', viewportWidth: 1400 });
  expect(l.boxes[2]).toMatchObject({ width: 1056, height: 816, rotation: 90 });   // Letter with /Rotate 90
  expect(l.boxes[1].width).toBeCloseTo(842 * PT_TO_CSS, 1);                       // A4 landscape
  expect(computeLayout(MIXED, { scale: 1, viewRotation: 90, spread: 'none', viewportWidth: 1400 }).boxes[2].rotation).toBe(180);
});
test('two-page spreads pair (1,2),(3,4)', () => { /* boxes 0 and 1 share top; left of box 1 = box0.left + box0.width + 16 */ });
test('fit-width and fit-page', () => {
  expect(resolveScale({ kind: 'fit-width' }, { width: 1232, height: 800 }, [LETTER], { viewRotation: 0, spread: 'none' })).toBeCloseTo((1232 - 32) / 816, 4);
  expect(resolveScale({ kind: 'fit-page' }, { width: 1232, height: 800 }, [LETTER], { viewRotation: 0, spread: 'none' })).toBeCloseTo((800 - 32) / 1056, 4);
});
test('scheduler: previews before full, cancels outside the retained range', async () => { /* fake backend records call order */ });
test('shortcuts: zoom keys and the typing guard', () => {
  expect(matchesCombo(key({ key: '=', ctrlKey: true }), 'Ctrl+=')).toBe(true);
  expect(matchesCombo(key({ key: '+', ctrlKey: true, shiftKey: true }), 'Ctrl++')).toBe(true);
  expect(matchesCombo(key({ key: 'ś', ctrlKey: true, altKey: true }), 'Ctrl+Alt+S')).toBe(false);          // Polish AltGr+S
  expect(matchesCombo(key({ key: '%', code: 'Digit5', altKey: true, shiftKey: true }), 'Alt+Shift+Digit5')).toBe(true);
  expect(isTypingTarget(inputEl)).toBe(true);
  // installShortcuts: Ctrl+Alt+* and single-key combos are skipped while isTypingTarget(e.target); Ctrl+P still fires
});
```

- [ ] **Step 2: Write the failing e2e tests**
```ts
test.use({ viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1.5 });
test('Ctrl+= and Ctrl++ zoom in, Ctrl+− out, Ctrl+0 fits width; the browser zoom never changes', async ({ openViewer, server }) => {
  const page = await openViewer(server.url('/f/paper-50.pdf')); const h = hooks(page);
  await page.keyboard.press('Control+0'); const fit = await h.eval((x) => x.viewer.scale());
  await page.keyboard.press('Control+Equal'); expect(await h.eval((x) => x.viewer.scale())).toBe(stepZoom(fit, 1));
  await page.keyboard.press('Control+Shift+Equal'); expect(await h.eval((x) => x.viewer.scale())).toBe(stepZoom(stepZoom(fit, 1), 1));
  await page.keyboard.press('Control+Minus'); await page.keyboard.press('Control+0');
  expect(await h.eval((x) => x.viewer.scale())).toBeCloseTo(fit, 6);
  expect(await page.evaluate(() => [window.devicePixelRatio, visualViewport!.scale])).toEqual([1.5, 1]);
});
test('Ctrl+wheel and pinch zoom the page, anchored under the pointer', async ({ openViewer, server }) => { /* keyboard.down('Control'); mouse.wheel(0,-200); scale > before; DPR unchanged; the PDF point under the pointer moves < 2 px */ });
test('scale stays within 25%–400%', async () => { /* 30 × Ctrl+= → 4; 30 × Ctrl+− → 0.25 */ });
test('keyboard scrolling follows Chromium', async () => { /* ArrowDown +40 px; PageDown + (viewport − 40); Home → 0; End → bottom; ArrowRight → next page when there is no horizontal overflow */ });
test('Review Focus 3: mixed.pdf renders every page upright with the right box', async ({ openViewer, server }) => { /* page 3 ink bbox wider than tall; boxes match computeLayout */ });
test('Review Focus 4: canvas backing = round(css × DPR) at 1.25 and 1.5, and re-renders within 500 ms after a DPR change', async ({ openViewer, server }) => {
  /* CDP Emulation.setDeviceMetricsOverride({ deviceScaleFactor: 2, width: 1366, height: 768, mobile: false }) → canvas.width === Math.round(cssW * 2) within 500 ms */
});
// e2e/perf-smoke.spec.ts (thresholds tighten with SOP_GATE=1)
const GATE = !!process.env.SOP_GATE;
test('first page of paper-50 paints in time', async ({ openViewer, server }) => {
  const page = await openViewer(server.url('/f/paper-50.pdf'));
  const t = await page.evaluate(() => new Promise<number>((r) => { const e = performance.getEntriesByName('sop:first-page')[0]; if (e) r(e.startTime); else new PerformanceObserver((l) => r(l.getEntries()[0].startTime)).observe({ type: 'mark' }); }));
  expect(t).toBeLessThan(GATE ? 1000 * 1.2 : 3000);
});
test('scan steady scroll: no page blank too long', async ({ openViewer, server }) => {
  const page = await openViewer(server.url(GATE ? '/f/scan-600.pdf' : '/f/scan-120.pdf'));
  await steadyScroll(page, { pxPerSec: 3000, seconds: 10 });
  const worst = await page.evaluate(() => Math.max(...performance.getEntriesByType('measure').filter((m) => m.name.startsWith('sop:blank:')).map((m) => m.duration)));
  expect(worst).toBeLessThanOrEqual(GATE ? 150 * 1.2 : 500);
});
```
  `make-scan.mjs` is the spike's synthesiser with the same CLI. `make-mixed.mjs` builds five pages with pdf-lib: Letter portrait; A4 landscape (842×595); Letter with `setRotation(90)`; a 960×540 slide; and A5 (420×595). Each page reads "Page N" at 48 pt in the top-left corner.

- [ ] **Step 3: Run them and confirm they fail.** Run: `pnpm vitest run packages/viewer/src/layout packages/viewer/src/render apps/extension/src/viewer/shortcuts.test.ts && pnpm fixtures && pnpm e2e e2e/view-zoom.spec.ts e2e/perf-smoke.spec.ts`. Expected: FAIL.

- [ ] **Step 4: Implement**
  - **`PageList`:**
    - one scroll container (`role="document"`, `aria-label` = file name) holding absolutely positioned `PageView`s for `visibleRange(…, overscan 1)`;
    - each `PageView` holds a placeholder (`var(--viewer-page-placeholder)`), a `<canvas>` with backing `Math.round(cssW·dpr) × Math.round(cssH·dpr)` and `box-shadow: var(--shadow-pdf-page)`, and slots for the text and link layers;
    - `performance.mark('sop:blank-start:i')` when the placeholder becomes visible, and `performance.measure('sop:blank:i', start)` on its first paint;
    - `performance.mark('sop:first-page')` on page 0's first full paint.
  - **Rendering:**
    - full renders whose bitmap side would exceed 4096 device px use 1024 px tiles of the visible rect only;
    - re-render on `matchMedia('(resolution: <dpr>dppx)')` change.
  - **Zoom:**
    - keys and wheel keep the page-space point under the pointer (keys: the viewport centre) fixed;
    - `wheel` listeners use `{ passive: false }` and `preventDefault` when `ctrlKey` is set.
  - **Shortcuts** registered here: `view.zoomIn` = `Ctrl+=`, `Ctrl++`; `view.zoomOut` = `Ctrl+-`; `view.fitWidth` = `Ctrl+0`.
  - **Scroll keys:**
    - ArrowUp and ArrowDown move 40 px;
    - PageUp, PageDown, Space and Shift+Space move the viewport height − 40, or one page in fit-page mode;
    - Home and End go to the start and the end;
    - ArrowLeft and ArrowRight go to the previous or next page when there is no horizontal overflow, and otherwise scroll 40 px.

- [ ] **Step 5: Run them again and confirm they pass.** Run: `pnpm vitest run packages/viewer/src/layout packages/viewer/src/render apps/extension/src/viewer/shortcuts.test.ts && pnpm e2e e2e/view-zoom.spec.ts e2e/perf-smoke.spec.ts`. Expected: PASS.

- [ ] **Step 6: Commit**
```bash
git add packages/viewer apps/extension scripts/fixtures e2e
git commit -m "feat(viewer): virtual page list, preview-first rendering, Chromium zoom steps and keys"
```

### Task 22: Text layer: selection, copy and screen readers

**Files:**
- Create: `packages/viewer/src/text-layer/{text-layer.ts,items.ts,items.test.ts,char-map.ts,text-layer.css,LICENSE.pdfjs}`, `packages/viewer/src/react/TextLayer.tsx`
- Create: `scripts/fixtures/make-textlayer.mjs`, `scripts/fixtures/textlayer-src/*`, `e2e/support/{drag-select.ts,textlayer-fixtures.ts}`, `e2e/text-layer.spec.ts`
- Modify: `packages/viewer/src/react/PageView.tsx`, `apps/extension/src/viewer/test-hooks.ts`

**Interfaces:**
- Consumes: `PageGlyphs`, `getTextRange` (Task 15); `PageBox` (Task 21); the spike's text-layer code (Task 3).
- Produces (used by Find in Task 25, and by marks in Phase 2):
```ts
export interface CharRange { pageIndex: number; start: number; end: number }   // end exclusive
export interface TextItem { str: string; dir: 'ltr' | 'rtl'; transform: [number, number, number, number, number, number]; width: number; height: number; hasEOL: boolean; start: number }
export function buildTextItems(g: PageGlyphs, measure: (text: string, cssFont: string) => number, scale: number): TextItem[];
export interface TextLayerHandle { root: HTMLElement; update(scale: number, rotation: Rotation): void; destroy(): void }
export function renderTextLayer(container: HTMLElement, items: TextItem[], box: PageBox, pageIndex: number): TextLayerHandle;
export function getSelectionRanges(viewerRoot: HTMLElement): CharRange[];
export function selectCharRanges(viewerRoot: HTMLElement, ranges: CharRange[]): void;
export function normalizeCopiedText(s: string): string;   // U+FB00–U+FB06 → letters; U+0000 removed
// SopTestHooks gains: selectionRanges(): CharRange[]; glyphCenter(pageIndex: number, charIndex: number): { x: number; y: number }
```

- [ ] **Step 1: Write the failing tests**
```ts
// items.test.ts
test('drift-split keeps every edge within 0.5 px: a monospaced run stays one item, a mismatched run splits', () => {
  expect(buildTextItems(MONO_RUN, monoMeasure, 1)).toHaveLength(1);
  const items = buildTextItems(PROPORTIONAL_RUN, monoMeasure, 2);
  expect(items.length).toBeGreaterThan(1);
  expect(maxPredictedEdgeError(items, PROPORTIONAL_RUN, monoMeasure)).toBeLessThanOrEqual(0.5);
});
test('ligature expansions share their box equally; RTL runs get dir rtl', () => {
  expect(charEdges(buildTextItems(LIGATURE_RUN /* "fi" sharing one 10 pt box */, monoMeasure, 1)[0])).toEqual([[0, 5], [5, 10]]);
  expect(buildTextItems(HEBREW_RUN, monoMeasure, 1).every((i) => i.dir === 'rtl')).toBe(true);
});
test('normalizeCopiedText', () => expect(normalizeCopiedText('\ufb01le e\ufb03cient\u0000')).toBe('file efficient'));
// e2e/text-layer.spec.ts: the P0-4 suite on the real viewer
test.use({ deviceScaleFactor: 1.5 });                                     // Review Focus 4
for (const f of TEXTLAYER_FIXTURES /* incl. tl-rotated-page (Review Focus 3) */) for (const zoom of [1, 2]) {
  test(`${f.name} @${zoom * 100}% DPR 1.5: drag maps to PDFium chars and copies PDFium text`, async ({ openViewer, server }) => { /* per seeded pair: ranges equal [{ pageIndex, start: min, end: max + 1 }] and norm(domText) === norm(getTextRange(...)) */ });
  test(`${f.name} @${zoom * 100}% DPR 1.5: glyph edges within 1 px`, async () => { /* maxEdgeErrorPx < 1; minVerticalOverlap ≥ 0.8 */ });
}
test('Ctrl+C copies the selection as PDFium text', async ({ context, openViewer, server }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `chrome-extension://${EXTENSION_ID}` });
  /* drag, Ctrl+C, navigator.clipboard.readText() === normalizeCopiedText(getTextRange(...)) */
});
test('screen readers see page text', async ({ openViewer, server }) => {
  const page = await openViewer(server.url('/f/paper-50.pdf'));
  expect(await page.locator('[data-page-index="0"] .sop-text-layer').ariaSnapshot()).toContain('Household Wealth');
});
```

- [ ] **Step 2: Run them and confirm they fail.** Run: `pnpm vitest run packages/viewer/src/text-layer && pnpm fixtures && pnpm e2e e2e/text-layer.spec.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**

  Move the spike's port in:
  - `text-layer.ts` keeps the pdf.js Apache-2.0 header and `Modified for sickofpdfs`, with `LICENSE.pdfjs` next to it;
  - `items.ts` is the drift-split algorithm from Task 3 Step 4;
  - `char-map.ts` uses `data-start` offsets.

  Then:
  - the layer CSS scales with `--total-scale-factor`, as pdf.js does;
  - text is transparent with `::selection { background: rgba(11,87,208,.3) }` through a token;
  - the layer is not `aria-hidden`;
  - the copy handler writes `normalizeCopiedText(getSelection().toString())`;
  - `TextLayer.tsx` builds the layer lazily when a page enters the viewport, after the full render, and destroys it outside the overscan.

- [ ] **Step 4: Run them again and confirm they pass.** Run: `pnpm vitest run packages/viewer/src/text-layer && pnpm e2e e2e/text-layer.spec.ts`. Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add packages/viewer scripts/fixtures e2e apps/extension/src/viewer/test-hooks.ts
git commit -m "feat(viewer): text layer on PDFium glyph boxes with selection-to-char mapping and copy"
```

### Task 23: Viewer chrome: header, File/View/Tools/Help menus, pill toolbar, go to page, download, copy link

**Files:**
- Create: `apps/extension/src/viewer/commands.ts`, `apps/extension/src/viewer/chrome/{Header.tsx,Toolbar.tsx,menus.ts,menus.test.ts,ShortcutsDialog.tsx,AboutDialog.tsx}`, `apps/extension/src/viewer/actions/{download.ts,copy-link.ts,copy-link.test.ts}`, `e2e/viewer-chrome.spec.ts`
- Modify: `apps/extension/src/viewer/App.tsx` (moves "Back to page" from Task 17 into the header)

**Interfaces:**
- Consumes: `MenuBar`, `PillToolbar`, `IconButton`, `TextField`, `Tooltip`, `FileTypeIcon` (Tasks 13–14); `ViewerStore`, `stepZoom`, `installShortcuts` (Task 21); `cleanLink` (Task 18); `goBackToPage` (Task 17).
- Produces:
```ts
export type ViewerCommandId =
  | 'file.openInChrome' | 'file.download' | 'file.copyLink' | 'file.print' | 'file.saveToLibrary'
  | 'view.fitWidth' | 'view.fitPage' | 'view.zoomIn' | 'view.zoomOut' | 'view.rotateCw' | 'view.rotateCcw'
  | 'view.twoPage' | 'view.presentation' | 'view.darkPages' | 'view.toggleRail'
  | 'tools.find' | 'tools.goToPage' | 'help.shortcuts' | 'help.about';
export interface ViewerCommand { id: ViewerCommandId; label: string; icon?: IconName; keys: KeyCombo[]; run(): void; enabled(): boolean; checked?(): boolean }
export function createCommands(ctx: ViewerContext): Map<ViewerCommandId, ViewerCommand>;   // the one source for menus, toolbar, shortcuts and the shortcut sheet
export function buildMenus(cmds: Map<ViewerCommandId, ViewerCommand>): MenuDef[];
export function linkForCopy(source: string): string;          // http(s) → cleanLink(source); file: unchanged
export function downloadOriginal(blob: Blob, fileName: string): void;   // <a download> on an object URL, revoked after 60 s
export interface ViewerContext {   // built once per tab in App.tsx; later tasks fill the nullable fields
  params: ViewerParams; backend: PdfBackend; opened: OpenedDocument; store: ViewerStore; scheduler: RenderScheduler; root: HTMLElement;
  jumps: JumpHistory | null;     // Task 24
  find: FindController | null;   // Task 25
  save: SaveController | null;   // Task 30
}
```
  Commands that later tasks implement are registered now and filled in there: `view.rotate*`, `view.twoPage`, `view.presentation`, `view.darkPages` (Task 26), `view.toggleRail` (Task 24), `tools.find` (Task 25), `file.print` (Task 27), `file.saveToLibrary` (Task 30). Until its task lands, each one's `enabled()` returns false.

- [ ] **Step 1: Write the failing tests**
```ts
// menus.test.ts
test('menu structure, labels and shortcuts', () => {
  expect(buildMenus(fakeCommands()).map((m) => [m.label, m.items.map((i) => i.kind === 'separator' ? '—' : `${i.label}${i.shortcut ? ' ' + i.shortcut : ''}`)])).toEqual([
    ['File', ["Open in Chrome's viewer", '—', 'Download Ctrl+S', 'Copy link', '—', 'Print Ctrl+P', '—', 'Save to library Ctrl+Alt+S']],
    ['View', ['Fit width Ctrl+0', 'Fit page', 'Zoom in Ctrl+=', 'Zoom out Ctrl+−', '—', 'Rotate clockwise Ctrl+]', 'Rotate counter-clockwise Ctrl+[', '—', 'Two-page view', 'Presentation mode', 'Dark pages', '—', 'Thumbnails and outline F4']],
    ['Tools', ['Find Ctrl+F', 'Go to page Ctrl+G']],
    ['Help', ['Keyboard shortcuts ?', 'About sickofpdfs']],
  ]);
});
test('linkForCopy', () => {
  expect(linkForCopy('https://www.jstor.org/stable/pdf/1.pdf?utm_source=x&refreqid=y#page=2')).toBe('https://www.jstor.org/stable/pdf/1.pdf');
  expect(linkForCopy('file:///C:/a%20b.pdf')).toBe('file:///C:/a%20b.pdf');
});
// e2e/viewer-chrome.spec.ts
test('header and toolbar match the Drive viewer', async ({ openViewer, server }) => {
  const page = await openViewer(server.url('/f/paper-50.pdf'));
  expect(await box(page, 'header')).toMatchObject({ height: 64 });
  expect(await css(page, '[role=toolbar][aria-label=Document]')).toMatchObject({ height: '48px', backgroundColor: 'rgb(51, 53, 55)' });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('paper-50.pdf');
  await expect(page.getByRole('textbox', { name: 'Page' })).toHaveValue('1');
  await expect(page.getByText('/ 50')).toBeVisible();
  await expect(page).toHaveScreenshot('viewer-chrome.png', { clip: { x: 0, y: 0, width: 1366, height: 128 } });
});
test('Ctrl+G then 37 Enter goes to page 37; 999 reverts', async () => { /* page 37 top at viewport top ±2 px; input value 37; 999 → previous value, aria-invalid true for 1 s */ });
test('Ctrl+S downloads the original bytes under the file name', async ({ openViewer, server }) => {
  const page = await openViewer(server.url('/f/paper-50.pdf'));
  const [d] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Control+s')]);
  expect(d.suggestedFilename()).toBe('paper-50.pdf');
  expect(await sha256File(await d.path())).toBe(await sha256File('test-assets/paper-50.pdf'));
});
test('File → Copy link puts the cleaned link on the clipboard', async () => { /* clipboard-read permission; value === linkForCopy(source) */ });
test("File → Open in Chrome's viewer leaves for Chrome's viewer", async () => { /* waitForURL(source) */ });
test('? opens the shortcut sheet listing every registered shortcut', async () => { /* rows === commands with keys */ });
test('About shows the version and the last first-page time', async () => { /* dialog contains chrome.runtime.getManifest().version and text matching /First page drawn in \d+ ms/ */ });
test('page indicator follows scrolling', async () => { /* scrollTo(12) → input value "13" */ });
test('no axe violations (WCAG 2.2 AA) in the viewer chrome', async ({ openViewer, server }) => {
  const page = await openViewer(server.url('/f/paper-50.pdf'));
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).exclude('.sop-text-layer').analyze();
  expect(r.violations).toEqual([]);
});
```

- [ ] **Step 2: Run them and confirm they fail.** Run: `pnpm vitest run apps/extension/src/viewer/chrome apps/extension/src/viewer/actions && pnpm e2e e2e/viewer-chrome.spec.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**
  - **Header** (64 px, `data-theme="dark"`, background `var(--gm3-sys-color-surface-container-low)`), left to right:
    - "Back to page" (`arrow_back`) when `back` is set;
    - `FileTypeIcon kind="pdf" size={24}`;
    - an `<h1>` with the file name in `var(--type-viewer-title)`;
    - below it, `MenuBar` with File, View, Tools and Help;
    - on the right, the status-chip slot (Task 30).
  - **Toolbar** (`PillToolbar` with label "Document", x = 16, inside a 48 px row):
    - "Page", then `TextField` (label "Page", width 33), then "/ N";
    - `ToolbarSeparator`;
    - download (`download`, Ctrl+S) and print (`print`, Ctrl+P);
    - `ToolbarSeparator`;
    - zoom out (`remove`), a zoom `DropdownMenu` trigger showing "{round(scale·100)}%" with items Fit width, Fit page, ─, 50%, 75%, 100%, 125%, 150%, 200%, 300%, 400%, and zoom in (`add`).
  - **Keys:** `installShortcuts` from `createCommands`. Ctrl+P, Ctrl+S, Ctrl+F and Ctrl+G call `preventDefault`, so Chrome's own dialogs never open.
  - **`file.openInChrome`** sends `takeover:open-in-chrome` with `source`.
  - **About** shows `chrome.runtime.getManifest().version` and `Math.round(performance.getEntriesByName('sop:first-page')[0].startTime)`.

- [ ] **Step 4: Run them again and confirm they pass.** Run: `pnpm vitest run apps/extension/src/viewer && pnpm e2e e2e/viewer-chrome.spec.ts`. Expected: PASS. The first run writes the screenshot baseline; commit it.

- [ ] **Step 5: Commit**
```bash
git add apps/extension e2e
git commit -m "feat(viewer): Drive-style header, menus, pill toolbar, go to page, download and copy link"
```

### Task 24: Thumbnails and outline rail, links inside PDFs, collapsed jump history

**Files:**
- Create: `packages/viewer/src/react/{ThumbnailRail.tsx,OutlinePanel.tsx,LinkLayer.tsx}`, `packages/viewer/src/navigation/{jump-history.ts,jump-history.test.ts}`, `scripts/fixtures/make-links.mjs`, `e2e/navigate.spec.ts`
- Modify: `apps/extension/src/viewer/App.tsx`, `apps/extension/src/viewer/commands.ts` (`view.toggleRail` = F4), `scripts/fixtures/build.mjs` (`links.pdf`: pdf-lib page with a GoTo link to page 3, a URI link to `https://example.org/` and a `javascript:` URI link)

**Interfaces:**
- Consumes: `getOutline`, `getLinks`, `LinkTarget` (Task 15); `RenderScheduler` previews (Task 21).
- Produces:
```ts
export interface ViewPosition { pageIndex: number; offset: number /* 0–1 of page height */; scale: number }
export interface JumpHistory { jumpTo(target: LinkTarget & { kind: 'page' }, from: ViewPosition): void; dispose(): void }
export function createJumpHistory(win: Pick<Window, 'history' | 'addEventListener' | 'removeEventListener'>, restore: (p: ViewPosition) => void, go: (t: LinkTarget & { kind: 'page' }) => void): JumpHistory;
export function ThumbnailRail(p: { scheduler: RenderScheduler; pages: PageSize[]; store: ViewerStore; onSelect(i: number): void }): JSX.Element;
export function OutlinePanel(p: { items: OutlineItem[]; onSelect(t: LinkTarget): void }): JSX.Element;  // role="tree"
export function LinkLayer(p: { links: PdfLink[]; box: PageBox; onInternal(t: LinkTarget & { kind: 'page' }): void }): JSX.Element;
```

- [ ] **Step 1: Write the failing tests**
```ts
// jump-history.test.ts (fake History)
test('the first jump pushes one entry; later jumps replace it; Back restores the original position', () => {
  const h = createJumpHistory(fakeWin, restore, go);
  h.jumpTo(P(5), POS0); h.jumpTo(P(9), posAt(5)); h.jumpTo(P(2), posAt(9));
  expect(fakeWin.history.length).toBe(2);
  fakeWin.back(); expect(restore).toHaveBeenLastCalledWith(POS0);
});
// e2e/navigate.spec.ts
test('internal links jump and Back returns in one press', async ({ openViewer, server }) => {
  const page = await openViewer(server.url('/f/classifier/learning/arxiv-1706.03762-attention.pdf'));
  const before = await page.evaluate(() => history.length);
  for (let i = 0; i < 3; i++) await page.locator('.sop-link[data-kind=page]').nth(i).click();
  expect(await page.evaluate(() => history.length)).toBe(before + 1);
  await page.goBack(); expect(await hooks(page).eval((h) => h.viewer.currentPage())).toBe(0);
});
test('external links are real anchors with rel=noopener; javascript: links are not rendered', async ({ openViewer, server }) => {
  const page = await openViewer(server.url('/f/links.pdf'));
  await expect(page.locator('a.sop-link[href="https://example.org/"]')).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(page.locator('a.sop-link[href^="javascript:"]')).toHaveCount(0);
});
test('F4 toggles the rail; the thumbnail for the current page has the 2px #a8c7fa outline; a click goes to the page', async ({ openViewer, server }) => {
  const page = await openViewer(server.url('/f/paper-50.pdf'));               // 1366 px wide: the rail starts open
  expect(await css(page, '[data-thumb-index="0"]')).toMatchObject({ outlineWidth: '2px', outlineColor: 'rgb(168, 199, 250)', outlineOffset: '2px' });
  await page.locator('[data-thumb-index="9"]').click(); expect(await hooks(page).eval((h) => h.viewer.currentPage())).toBe(9);
  await page.keyboard.press('F4'); await expect(page.getByRole('navigation', { name: 'Thumbnails' })).toBeHidden();
  await page.keyboard.press('F4'); await expect(page.getByRole('navigation', { name: 'Thumbnails' })).toBeVisible();
});
test('outline: tree keyboard (ArrowDown/Right/Enter) jumps to the target page', async ({ openViewer, server }) => { /* textbook-thinkpython2.pdf: focus the tree, ArrowDown ×2, ArrowRight expands, Enter → currentPage() equals that item's target pageIndex */ });
test('rail collapses below 1100 px viewport width', async () => { /* setViewportSize(1000, 768) → rail hidden, F4 overlays it */ });
```

- [ ] **Step 2: Run them and confirm they fail.** Run: `pnpm vitest run packages/viewer/src/navigation && pnpm e2e e2e/navigate.spec.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**
  - **Rail** (`var(--rail-w)`):
    - a toolbar with two 40×40 toggles, "Thumbnails" (`photo_library`, background `var(--gm3-sys-color-surface-container-highest)` when selected) and "Outline" (`toc`), hidden when the PDF has no outline;
    - thumbnails are previews from the scheduler at 73 px width, each with a page number in a `var(--thumb-num-w)` column;
    - the current page gets `outline: 2px solid var(--viewer-focus); outline-offset: 2px`;
    - a "Hide navigation pane" pill (`left_panel_close`) at the bottom-left;
    - the rail is collapsed by default when `innerWidth < 1100`.
  - **`LinkLayer`:**
    - page targets are `<a class="sop-link" data-kind="page" href="#page=N">`, whose click calls `onInternal`;
    - URL targets are `<a href rel="noopener noreferrer">`, for `http:`, `https:` and `mailto:` only;
    - the layer lies above the text layer, with `pointer-events` only on the anchors.
  - **`createJumpHistory`:**
    - before the first jump, `replaceState({ sopBase: from })`, then `pushState({ sopJump: true })`;
    - later jumps call `replaceState({ sopJump: true })`;
    - `popstate` to a `sopBase` state calls `restore`.

    Thumbnail and outline clicks do not touch history. Internal links and find results do.

- [ ] **Step 4: Run them again and confirm they pass.** Run: `pnpm vitest run packages/viewer/src/navigation && pnpm e2e e2e/navigate.spec.ts`. Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add packages/viewer apps/extension e2e
git commit -m "feat(viewer): thumbnails and outline rail, PDF links, collapsed jump history"
```

### Task 25: Find (Ctrl+F)

**Files:**
- Create: `packages/viewer/src/find/{find-controller.ts,find-controller.test.ts}`, `packages/viewer/src/react/{FindBar.tsx,FindHighlights.tsx}`, `e2e/find.spec.ts`
- Modify: `apps/extension/src/viewer/commands.ts` (`tools.find`)

**Interfaces:**
- Consumes: `searchPage` (Task 15), `selectCharRanges` (Task 22), `JumpHistory` (Task 24).
- Produces:
```ts
export interface FindState { query: string; hits: SearchHit[]; current: number /* 0-based, −1 none */; complete: boolean }
export class FindController {
  constructor(backend: PdfBackend, doc: DocHandle, pageCount: number, startPage: () => number);
  setQuery(q: string): void;            // 150 ms debounce; searches from startPage(), wraps, streams hits; a new query cancels the old one
  next(): SearchHit | null; previous(): SearchHit | null;
  get state(): FindState; subscribe(cb: (s: FindState) => void): () => void; dispose(): void;
}
export function FindBar(p: { controller: FindController; onJump(h: SearchHit): void; onSelectMatch(h: SearchHit): void; onClose(): void }): JSX.Element;
```

- [ ] **Step 1: Write the failing tests**
```ts
test('hits are ordered by page then start, starting from the current page and wrapping', async () => { /* fake backend: page 3 current → state.hits[0].pageIndex === 3; after completion hits sorted by (page,start) */ });
test('a new query cancels the old search', async () => {
  const be = slowFakeBackend(); const fc = new FindController(be, DOC, 100, () => 0);
  fc.setQuery('alpha'); await sleep(200); fc.setQuery('beta'); await settled(fc);
  expect(be.queriesAfterFirst('beta')).not.toContain('alpha'); expect(fc.state.query).toBe('beta');
});
// e2e/find.spec.ts
test('Ctrl+F counts, Enter/Shift+Enter move, Alt+Enter selects the match, Esc closes', async ({ openViewer, server }) => {
  const page = await openViewer(server.url('/f/classifier/learning/arxiv-1706.03762-attention.pdf'));
  const expected = await hooks(page).eval(async (h) => { let n = 0; for (let i = 0; i < h.doc()!.open.pageCount; i++) n += (await h.backend.getPageText(h.doc()!.open.doc, i)).match(/attention/gi)?.length ?? 0; return n; });
  await page.keyboard.press('Control+f'); await expect(page.getByRole('searchbox', { name: 'Find in document' })).toBeFocused();
  await page.keyboard.type('attention'); await expect(page.getByText(`1 of ${expected}`)).toBeVisible();
  await page.keyboard.press('Enter'); await expect(page.getByText(`2 of ${expected}`)).toBeVisible();
  await page.keyboard.press('Shift+Enter'); await expect(page.getByText(`1 of ${expected}`)).toBeVisible();
  await page.keyboard.press('Alt+Enter');
  expect((await page.evaluate(() => getSelection()!.toString())).toLowerCase()).toBe('attention');
  await expect(page.getByRole('searchbox', { name: 'Find in document' })).toBeHidden();
});
test('no match shows "0 of 0"; Esc clears highlights', async ({ openViewer, server }) => {
  const page = await openViewer(server.url('/f/paper-50.pdf'));
  await page.keyboard.press('Control+f'); await page.keyboard.type('zzqx'); await expect(page.getByText('0 of 0')).toBeVisible();
  await page.keyboard.press('Escape'); await expect(page.locator('.sop-find-hit')).toHaveCount(0);
});
```

- [ ] **Step 2: Run them and confirm they fail.** Run: `pnpm vitest run packages/viewer/src/find && pnpm e2e e2e/find.spec.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**
  - `FindBar` is a dark surface (`var(--gm3-sys-color-surface-container)`, radius `var(--shape-menu)`) under the toolbar on the right. It holds a `TextField` (`type="search"`, label "Find in document"), the count "{current+1} of {total}", previous and next `IconButton`s (`keyboard_arrow_up`, `keyboard_arrow_down`) and close (`close`).
  - `FindHighlights` draws hit rects with `var(--find-hit)` and `var(--find-current)`. Add these tokens to `tokens.css`: `--find-hit: rgba(251,188,4,.4); --find-current: rgba(251,188,4,.8)`.
  - Every `next()` or `previous()` jump goes through `JumpHistory`.
  - Alt+Enter calls `selectCharRanges([{ pageIndex, start, end: start + count }])`, closes the bar and focuses the document.

- [ ] **Step 4: Run them again and confirm they pass.** Run: `pnpm vitest run packages/viewer/src/find && pnpm e2e e2e/find.spec.ts`. Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add packages packages/ui/src/tokens/tokens.css apps/extension e2e
git commit -m "feat(viewer): find with count, next/previous and Alt+Enter selection"
```

### Task 26: Rotate, two-page view, presentation mode, dark pages

**Files:**
- Create: `packages/viewer/src/view/{view-state.ts,view-state.test.ts}`, `apps/extension/src/viewer/presentation.ts`, `e2e/views.spec.ts`
- Modify: `packages/viewer/src/react/{PageList.tsx,PageView.tsx}`, `apps/extension/src/viewer/commands.ts`, `packages/ui/src/tokens/tokens.css` (`--dark-pages-filter: invert(1) hue-rotate(180deg)`)

**Interfaces:**
- Consumes: `ViewerStore`, `computeLayout` (Task 21); commands (Task 23).
- Produces:
```ts
export function rotate(r: Rotation, dir: 1 | -1): Rotation;                // 90° steps, view rotation only (the file is never changed)
export function enterPresentation(ctx: { store: ViewerStore; root: HTMLElement }): Promise<() => void>; // requestFullscreen; returns exit()
```

- [ ] **Step 1: Write the failing tests**
```ts
test('rotate cycles 0→90→180→270→0 and back', () => { expect(rotate(270, 1)).toBe(0); expect(rotate(0, -1)).toBe(270); });
// e2e/views.spec.ts
test('Ctrl+] rotates the view clockwise; selection still maps to chars', async () => { /* box width/height swap; dragSelect → expected range */ });
test('two-page view pairs pages and the indicator shows the left page', async ({ openViewer, server }) => {
  const page = await openViewer(server.url('/f/paper-50.pdf')); await clickMenu(page, 'View', 'Two-page view');
  const [b0, b1] = [await box(page, '[data-page-index="0"]'), await box(page, '[data-page-index="1"]')];
  expect(b1.y).toBe(b0.y); expect(b1.x).toBeCloseTo(b0.x + b0.width + 16, 0);
  await hooks(page).eval((h) => h.viewer.scrollTo(3)); await expect(page.getByRole('textbox', { name: 'Page' })).toHaveValue('3');
});
test('presentation mode: fullscreen, fit page, arrows and space step pages, Esc restores the previous zoom and scroll', async ({ openViewer, server }) => {
  const page = await openViewer(server.url('/f/classifier/learning/slides-cs50-2023-lecture0.pdf'));
  await clickMenu(page, 'View', 'Presentation mode');
  expect(await page.evaluate(() => !!document.fullscreenElement)).toBe(true);
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('Space'); expect(await hooks(page).eval((h) => h.viewer.currentPage())).toBe(2);
  await page.keyboard.press('Escape'); expect(await page.evaluate(() => !!document.fullscreenElement)).toBe(false);
});
test('dark pages invert the page canvases only', async () => { /* white page pixel luminance < 40 after toggle; the header is unchanged; toggling again restores */ });
```

- [ ] **Step 2: Run them and confirm they fail.** Run: `pnpm vitest run packages/viewer/src/view && pnpm e2e e2e/views.spec.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**
  - **Rotation and spreads:** `viewRotation` and `spread` feed `computeLayout` and `TileRequest.viewRotation`; the text and link layers rotate with their page.
  - **Presentation:**
    - hides the header, toolbar and rail;
    - the page area becomes `var(--gm3-sys-color-scrim)`, with zoom fit-page and a single page;
    - ArrowRight, PageDown, Space and a click go forward; ArrowLeft, PageUp and Shift+Space go back;
    - `fullscreenchange` to null exits and restores the snapshot.
  - **Dark pages:** apply `filter: var(--dark-pages-filter)` to page canvases and thumbnails. The setting is per tab in Phase 1, and Settings persists it in Phase 3.

- [ ] **Step 4: Run them again and confirm they pass.** Run: `pnpm vitest run packages/viewer/src/view && pnpm e2e e2e/views.spec.ts`. Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add packages apps/extension e2e
git commit -m "feat(viewer): rotate, two-page view, presentation mode and dark pages"
```

### Task 27: Print (Ctrl+P) through a PDFium-rendered print copy

**Files:**
- Create: `apps/extension/src/viewer/print/{print.ts,print.css,PrintProgressDialog.tsx}`, `e2e/print.spec.ts`
- Modify: `apps/extension/src/viewer/commands.ts` (`file.print`)

**Interfaces:**
- Consumes: `renderTile` (Task 15), `PageSize` (Task 15), `Dialog` (Task 14).
- Produces (the Phase 2 plan adds marks to the copy):
```ts
export interface PrintCopy { root: HTMLElement; dispose(): void }
export function preparePrintCopy(backend: PdfBackend, doc: DocHandle, pages: PageSize[], o: { dpi: 200; signal: AbortSignal; onProgress(done: number, total: number): void }): Promise<PrintCopy>;
export function printDocument(ctx: ViewerContext): Promise<void>;   // dialog → prepare → window.print() → dispose on afterprint
```

- [ ] **Step 1: Write the failing test**
```ts
test('Ctrl+P prints one sheet per page with the right size and orientation', async ({ context, openViewer, server }) => {
  const page = await openViewer(server.url('/f/mixed.pdf'));
  await page.addInitScript(() => { (window as any).print = () => { (window as any).__printed = true; }; });
  await page.evaluate(() => { (window as any).print = () => { (window as any).__printed = true; }; });
  await page.keyboard.press('Control+p');
  await expect(page.getByText('Preparing to print…')).toBeVisible();
  await page.waitForFunction(() => (window as any).__printed === true);
  const pdf = await PDFDocument.load(await page.pdf({ preferCSSPageSize: true }));
  expect(pdf.getPageCount()).toBe(5);
  expect(pdf.getPages().map((p) => [Math.round(p.getWidth()), Math.round(p.getHeight())])).toEqual([[612, 792], [842, 595], [792, 612], [960, 540], [420, 595]]);
  await page.evaluate(() => dispatchEvent(new Event('afterprint')));
  await expect(page.locator('#sop-print-root')).toHaveCount(0);
});
test('browser-menu print without preparation shows the hint page', async ({ openViewer, server }) => {
  const pdf = await PDFDocument.load(await (await openViewer(server.url('/f/paper-50.pdf'))).pdf());
  expect(pdf.getPageCount()).toBe(1); // "Use Ctrl+P or File → Print to print this PDF."
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run: `pnpm e2e e2e/print.spec.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**
  - **Rendering:** render each page upright at `200/72` device px per pt (`viewRotation` 0, with annotations) to a canvas, then `toBlob('image/png')`, then an `<img>` sized `width: {w/72}in; height: {h/72}in` inside `#sop-print-root`. Wait for `img.decode()` on all of them, then call `window.print()`.
  - **`print.css`:**
    - `@media print` hides `#sop-app` and shows `#sop-print-root`;
    - images use `break-after: page`;
    - landscape pages get `page: sop-landscape` with `@page sop-landscape { size: landscape; margin: 0 }`, and the default is `@page { margin: 0 }`;
    - `#sop-print-hint` holds "Use Ctrl+P or File → Print to print this PDF." and shows only when no print root exists.
  - **Progress:** the dialog says "Preparing to print… {done} / {total}" with Cancel (aborts and disposes).

- [ ] **Step 4: Run it again and confirm it passes.** Run: `pnpm e2e e2e/print.spec.ts`. Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add apps/extension e2e
git commit -m "feat(viewer): print via a PDFium-rendered print copy"
```

### Task 28: Local store: offscreen owner, SQLite worker, normative schema v1, `StoreClient`, change events

**Files:**
- Create: `packages/core/src/{hlc.ts,hlc.test.ts}`, `packages/core/src/model/{anchor.ts,rows.ts}`
- Create: `apps/extension/src/store/{schema.ts,migrate.ts,schema.test.ts,store-api.ts,store-api.test.ts,protocol.ts,store-worker.ts,store-worker.browser.test.ts,client.ts,transport.ts,change-bus.ts}`
- Create: `apps/extension/src/background/{offscreen.ts,store-broker.ts}`, `e2e/store.spec.ts`
- Modify: `apps/extension/src/entrypoints/offscreen/main.ts`, `apps/extension/src/entrypoints/background.ts`, `apps/extension/package.json` (exact `@sqlite.org/sqlite-wasm` 3.54.1-build1), `apps/extension/src/viewer/test-hooks.ts`

**Interfaces:**
- Consumes: `STORE_TRANSPORT` (Task 10); `canonicalLocation`, `locationId`, `stampedTextSimilarity`, `ALIAS_THRESHOLD`, `Sha256`, `DocumentId` (Tasks 18–19).
- Produces:
```ts
// packages/core/src/hlc.ts
export type HlcStamp = string;   // `${ms.toString().padStart(13,'0')}-${counter.toString(16).padStart(4,'0')}-${deviceId}`
export class Hlc { constructor(deviceId: string, now?: () => number); tick(): HlcStamp; receive(remote: HlcStamp): HlcStamp }
export function compareHlc(a: HlcStamp, b: HlcStamp): number;
// packages/core/src/model/anchor.ts (normative anchor JSON; Phase 2 writes it)
export type NormRect = [x0: number, y0: number, x1: number, y1: number];   // 0–1 of the crop box, unrotated, origin top-left
export interface CharPos { page: number; index: number }                    // PDFium char index on that page
export interface TextQuote { quote: string; prefix: string; suffix: string } // prefix/suffix up to 32 chars
export interface FigureFingerprint { label: string | null; captionQuote: (TextQuote & { position: CharPos }) | null; imageSha256: string | null; dHash: string; detector: 'tagged' | 'objects' | 'caption' | 'manual' | 'layout-model'; detectorVersion: string }
export type Anchor =
  | { kind: 'text'; quote: TextQuote; start: CharPos; end: CharPos; rects: { page: number; rects: NormRect[] }[] }
  | { kind: 'area'; page: number; rect: NormRect; dHash: string }
  | { kind: 'figure'; page: number; rect: NormRect; figure: FigureFingerprint; sub?: { rect?: NormRect; point?: [number, number] } }
  | { kind: 'point'; page: number; point: [number, number] }
  | { kind: 'page'; page: number }
  | { kind: 'document' };
// packages/core/src/model/rows.ts
export interface DocumentRow { id: DocumentId; pageCount: number; byteSize: number; title: string | null; authors: string[]; year: number | null; doi: string | null; arxivId: string | null; pdfId: string | null; kind: 'paper' | 'book' | 'slides' | 'other'; hasText: boolean; encrypted: boolean; indexText: boolean; blobStored: boolean; starred: boolean; saveReasons: string[]; createdAt: number; updatedAt: number; deletedAt: number | null; rev: number; hlc: HlcStamp }
export interface LocationRow { id: LocationId; documentId: DocumentId; kind: LocationKind; canonical: string; raw: string; viaPage: string | null; firstSeen: number; lastSeen: number }
export interface PageHit { documentId: DocumentId; pageIndex: number; snippet: string; rank: number }
export interface StoreStats { documents: number; aliases: number; locations: number; pageText: number; history: number; outbox: number }
// apps/extension/src/store/store-api.ts
export interface SaveDocumentInput { id: DocumentId; byteSize: number; pageCount: number; title: string | null; authors: string[]; pdfId: string | null; hasText: boolean; encrypted: boolean; blobStored: boolean; saveReasons: string[]; location: { kind: LocationKind; raw: string; viaPage: string | null } | null; openedAt: number }
export interface TouchLocationInput { documentId: DocumentId; kind: LocationKind; raw: string; viaPage: string | null; at: number }
export interface StoreApi {
  schemaVersion(): Promise<number>;
  stats(): Promise<StoreStats>;
  resolveFingerprint(sha256: Sha256): Promise<DocumentId | null>;          // documents.id or aliases.sha256
  getDocument(id: DocumentId): Promise<DocumentRow | null>;
  countDocumentsWithPageCount(pageCount: number): Promise<number>;
  findStampAlias(pageCount: number, pageTexts: readonly string[]): Promise<{ documentId: DocumentId; similarity: number } | null>; // reads only
  addAlias(sha256: Sha256, documentId: DocumentId, similarity: number): Promise<void>;
  saveDocument(input: SaveDocumentInput): Promise<{ row: DocumentRow; created: boolean }>;   // documents + history + location, one transaction, idempotent
  putPageText(documentId: DocumentId, pages: readonly { pageIndex: number; text: string }[]): Promise<void>;
  touchLocation(input: TouchLocationInput): Promise<LocationRow>;
  listLocations(documentId: DocumentId): Promise<LocationRow[]>;
  recordOpen(documentId: DocumentId, at: number): Promise<void>;
  forgetDocument(documentId: DocumentId): Promise<void>;                    // hard delete, cascades
  searchPages(query: string, limit: number): Promise<PageHit[]>;
}
export type Sqlite3Database = import('@sqlite.org/sqlite-wasm').Database;   // the oo1 DB (OpfsSAHPoolDb in the worker, :memory: in Node tests)
export function createStoreApi(db: Sqlite3Database, deps: { now(): number; hlc: Hlc; publish(c: StoreChange): void }): StoreApi;
export function migrate(db: Sqlite3Database): number;
// change-bus.ts / client.ts / transport.ts
export const CHANGES_CHANNEL = 'sop-changes';
export interface StoreChange { table: 'documents' | 'aliases' | 'locations' | 'page_text' | 'history'; ids: string[]; op: 'upsert' | 'delete' }
export interface StoreClient extends StoreApi { onChange(cb: (c: StoreChange) => void): () => void; close(): void }
export function connectStore(o?: { timeoutMs?: number /* 3000 */ }): Promise<StoreClient>;
export function openStorePort(): Promise<MessagePort>;   // SW-brokered (STORE_TRANSPORT = sw-brokered-port)
export const DB_DIRECTORY = '.sop-db', DB_FILE = '/library.sqlite3';
// background
export function ensureOffscreen(): Promise<void>;        // getContexts(OFFSCREEN_DOCUMENT) check + createDocument(reason WORKERS), one shared promise
export function installStoreBroker(): void;              // SW 'message' {type:'store:connect'} + ports[0] → ensureOffscreen → offscreen client.postMessage(…, [port])
// SopTestHooks gains: store: StoreClient | null
```

- [ ] **Step 1: Write the schema (normative v1) in `schema.ts` as `SCHEMA_V1`**
```sql
-- sickofpdfs schema v1. Times are Unix ms. Synced rows carry rev (base revision) and hlc. Drafts, FTS and caches never sync.
CREATE TABLE documents (
  id TEXT PRIMARY KEY CHECK (length(id) = 64),            -- SHA-256 hex of the first copy's bytes
  page_count INTEGER NOT NULL CHECK (page_count >= 0),
  byte_size INTEGER NOT NULL,
  title TEXT, authors TEXT NOT NULL DEFAULT '[]', year INTEGER, doi TEXT, arxiv_id TEXT,
  pdf_id TEXT,                                              -- trailer /ID[0] hex
  kind TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('paper','book','slides','other')),
  has_text INTEGER NOT NULL CHECK (has_text IN (0,1)),
  encrypted INTEGER NOT NULL DEFAULT 0 CHECK (encrypted IN (0,1)),
  index_text INTEGER NOT NULL DEFAULT 1 CHECK (index_text IN (0,1)),
  blob_stored INTEGER NOT NULL DEFAULT 0 CHECK (blob_stored IN (0,1)),   -- OPFS pdf/<id[0..2]>/<id>.pdf exists
  starred INTEGER NOT NULL DEFAULT 0 CHECK (starred IN (0,1)),
  save_reasons TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER,
  rev INTEGER NOT NULL DEFAULT 0, hlc TEXT NOT NULL);
CREATE TABLE aliases (
  sha256 TEXT PRIMARY KEY CHECK (length(sha256) = 64),
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  similarity REAL NOT NULL CHECK (similarity >= 0.995 AND similarity <= 1),
  created_at INTEGER NOT NULL, rev INTEGER NOT NULL DEFAULT 0, hlc TEXT NOT NULL);
CREATE INDEX aliases_document ON aliases(document_id);
CREATE TABLE locations (
  id TEXT PRIMARY KEY CHECK (length(id) = 64),              -- sha256(kind || ':' || canonical)
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('url','file')),
  canonical TEXT NOT NULL, raw TEXT NOT NULL,               -- raw = cleanLink(url) or the file URL
  via_page TEXT,                                            -- canonical link of the page that led here (Referer or embedding page)
  first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, rev INTEGER NOT NULL DEFAULT 0, hlc TEXT NOT NULL);
CREATE INDEX locations_document ON locations(document_id);
CREATE TABLE page_text (
  rowid INTEGER PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_index INTEGER NOT NULL, text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'pdfium',                    -- 'pdfium' | 'ocr:<engine>@<version>' (Release 3)
  UNIQUE (document_id, page_index));
CREATE VIRTUAL TABLE page_text_fts USING fts5(text, content='page_text', content_rowid='rowid', tokenize="unicode61 remove_diacritics 2");
CREATE TABLE marks (
  id TEXT PRIMARY KEY,                                      -- UUIDv4, assigned once
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  style TEXT NOT NULL CHECK (style IN ('highlight','underline','bold','strike','area')),
  color INTEGER CHECK (color BETWEEN 1 AND 5),              -- highlight/underline/strike only
  anchor TEXT NOT NULL,                                     -- JSON Anchor: 'text' | 'area' | 'figure'
  page_index INTEGER NOT NULL, sort_key REAL NOT NULL,      -- first page; top of the first rect (0–1)
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, rev INTEGER NOT NULL DEFAULT 0, hlc TEXT NOT NULL);
CREATE INDEX marks_order ON marks(document_id, page_index, sort_key);
CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  anchor TEXT NOT NULL,                                     -- JSON Anchor, its own copy (any kind)
  page_index INTEGER, sort_key REAL,                        -- NULL for document threads
  placement TEXT NOT NULL DEFAULT 'placed' CHECK (placement IN ('placed','unplaced')),  -- 'unplaced' = "Couldn't place"
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, rev INTEGER NOT NULL DEFAULT 0, hlc TEXT NOT NULL);
CREATE INDEX threads_order ON threads(document_id, page_index, sort_key);
CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  author TEXT NOT NULL CHECK (author IN ('me','claude')),
  body TEXT NOT NULL,                                       -- Markdown
  draft_of_tab TEXT,                                        -- non-NULL = unsent draft owned by that tab; never synced
  meta TEXT NOT NULL DEFAULT '{}',                          -- Claude: model, citations, web sources (Phase 4)
  created_at INTEGER NOT NULL, edited_at INTEGER, deleted_at INTEGER, rev INTEGER NOT NULL DEFAULT 0, hlc TEXT NOT NULL);
CREATE INDEX comments_thread ON comments(thread_id, created_at);
CREATE TABLE history (
  document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  first_opened INTEGER NOT NULL, last_opened INTEGER NOT NULL, open_count INTEGER NOT NULL DEFAULT 1,
  reading_ms INTEGER NOT NULL DEFAULT 0,
  last_position TEXT,                                       -- JSON { page, offset (0–1), zoom }
  pages_visited BLOB NOT NULL DEFAULT x'',                  -- bitset, bit i = page i
  rev INTEGER NOT NULL DEFAULT 0, hlc TEXT NOT NULL);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 0, hlc TEXT NOT NULL);
CREATE TABLE page_figures (                                 -- derived cache (Phase 2 detector); never synced or backed up
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_index INTEGER NOT NULL, detector_version TEXT NOT NULL, figures TEXT NOT NULL,
  PRIMARY KEY (document_id, page_index));
CREATE TABLE outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL, row_id TEXT NOT NULL, op TEXT NOT NULL CHECK (op IN ('upsert','delete')),
  base_rev INTEGER NOT NULL, hlc TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE VIRTUAL TABLE documents_fts USING fts5(document_id UNINDEXED, title, authors, tokenize="unicode61 remove_diacritics 2");
CREATE VIRTUAL TABLE comments_fts USING fts5(comment_id UNINDEXED, document_id UNINDEXED, body, tokenize="unicode61 remove_diacritics 2");
```
  `migrate` behaves as follows:
  - pragmas `foreign_keys=ON`, `journal_mode=DELETE`, `synchronous=FULL`;
  - when `user_version` is 0, it runs `SCHEMA_V1` plus the generated triggers in one transaction, then sets `user_version = 1`.

  Generated triggers:
  - `SYNCED_TABLES = ['documents', 'aliases', 'locations', 'marks', 'threads', 'comments', 'history', 'settings']`;
  - `outboxTriggers(table, pk)` emits AFTER INSERT, UPDATE and DELETE triggers. They insert `(table, pk, 'upsert' | 'delete', OLD.rev or 0, NEW.hlc or OLD.hlc, CAST(unixepoch('subsec') * 1000 AS INTEGER))`. For `comments`, the trigger has `WHEN NEW.draft_of_tab IS NULL`.
  - FTS sync triggers: `page_text` → `page_text_fts` (the external-content insert/delete/update trio); `documents` → `documents_fts`; `comments` (non-draft only) → `comments_fts`.

- [ ] **Step 2: Write the failing tests**
```ts
// hlc.test.ts
test('tick is monotonic under a frozen or backwards clock; receive moves past the remote', () => {
  let t = 1000; const h = new Hlc('devA', () => t);
  const a = h.tick(); t = 900; const b = h.tick(); expect(compareHlc(b, a)).toBe(1);
  expect(compareHlc(h.receive('0000000005000-0000-devB'), '0000000005000-0000-devB')).toBe(1);
});
// schema.test.ts (Node, @sqlite.org/sqlite-wasm in-memory)
test('migrate creates v1 and is idempotent', () => {
  expect(migrate(db)).toBe(1); expect(migrate(db)).toBe(1);
  expect(tables(db)).toEqual(expect.arrayContaining(['documents', 'aliases', 'locations', 'page_text', 'page_text_fts', 'marks', 'threads', 'comments', 'history', 'settings', 'page_figures', 'outbox', 'documents_fts', 'comments_fts']));
});
test('constraints', () => {
  expect(() => insertAlias(db, { similarity: 0.9 })).toThrow(/CHECK/);
  expect(() => insertMark(db, { style: 'glow' })).toThrow(/CHECK/);
  expect(() => insertMark(db, { color: 6 })).toThrow(/CHECK/);
});
test('outbox: base_rev follows rev; drafts, page text and caches never enter it', () => {
  insertDoc(db, D1); updateDoc(db, D1, { rev: 1 }); updateDoc(db, D1, { rev: 2 });
  expect(outbox(db, 'documents')).toEqual([['upsert', 0], ['upsert', 0], ['upsert', 1]]);
  insertComment(db, { draft_of_tab: 't1' }); expect(outbox(db, 'comments')).toEqual([]);
  sendDraft(db); expect(outbox(db, 'comments')).toEqual([['upsert', 0]]);
  insertPageText(db); insertFigures(db); expect(outboxTables(db)).not.toContain('page_text');
});
test('FTS stays in step and delete cascades', () => { /* MATCH finds inserted page text; forget → page_text, locations, aliases, history gone; FTS empty */ });
// store-api.test.ts (Node, in-memory)
test('saveDocument writes document + history + location in one transaction and is idempotent', async () => {
  const r1 = await api.saveDocument(INPUT); const r2 = await api.saveDocument(INPUT);
  expect([r1.created, r2.created]).toEqual([true, false]);
  expect(await api.stats()).toMatchObject({ documents: 1, history: 1, locations: 1 });
  expect(publish).toHaveBeenCalledWith({ table: 'documents', ids: [INPUT.id], op: 'upsert' });
});
test('Review Focus 5: concurrent saveDocument for one id → one row', async () => {
  const rs = await Promise.all([api.saveDocument(INPUT), api.saveDocument(INPUT)]);
  expect(rs.filter((r) => r.created)).toHaveLength(1); expect((await api.stats()).documents).toBe(1);
});
test('resolveFingerprint covers documents and aliases', async () => {
  await api.saveDocument(INPUT); await api.addAlias(SHA2, INPUT.id, 0.998);
  expect([await api.resolveFingerprint(INPUT.id), await api.resolveFingerprint(SHA2), await api.resolveFingerprint(SHA3)]).toEqual([INPUT.id, INPUT.id, null]);
});
test('findStampAlias: stamped variant matches, other text and other page counts do not, and it writes nothing', async () => { /* stats unchanged */ });
test('touchLocation canonicalises, keeps first_seen and re-points to a new document', async () => {
  const l = await api.touchLocation({ documentId: D1, kind: 'url', raw: 'http://www.jstor.org/stable/pdf/1234.pdf?utm_source=x', viaPage: null, at: 1 });
  expect(l).toMatchObject({ id: '40ea1921427eaadca817d8e9a12e07dcbc9b4e336569adcdbfc273158dd81626', canonical: 'https://jstor.org/stable/pdf/1234.pdf', firstSeen: 1 });
});
test('searchPages ranks with bm25 and returns <b> snippets; forgotten documents vanish', async () => {
  await api.saveDocument(INPUT); await api.putPageText(INPUT.id, [{ pageIndex: 0, text: 'household wealth and income' }, { pageIndex: 1, text: 'wealth' }]);
  const hits = await api.searchPages('household wealth', 10);
  expect(hits[0]).toMatchObject({ documentId: INPUT.id, pageIndex: 0 }); expect(hits[0].snippet).toContain('<b>household</b>');
  await api.forgetDocument(INPUT.id); expect(await api.searchPages('household', 10)).toEqual([]);
});
// store-worker.browser.test.ts (Vitest browser: real OPFS sahpool on localhost)
test('data survives a worker restart', async () => { /* spawn, save, terminate, respawn, getDocument → row */ });
// e2e/store.spec.ts
test('viewer connects through the SW broker', async ({ openViewer, server }) => {
  expect(await hooks(await openViewer(server.url('/f/paper-50.pdf'))).eval((h) => h.store!.schemaVersion())).toBe(1);
});
test('Review Focus 5: the offscreen document is re-created and the call is replayed', async ({ openViewer, server, sw }) => {
  const page = await openViewer(server.url('/f/paper-50.pdf'));
  await sw.evaluate(() => chrome.offscreen.closeDocument());
  const t0 = Date.now(); expect(await hooks(page).eval((h) => h.store!.schemaVersion())).toBe(1); expect(Date.now() - t0).toBeLessThan(5000);
});
test('a change in one tab reaches another tab within 500 ms', async () => { /* tab B onChange receives { table: 'documents' } */ });
```

- [ ] **Step 3: Run them and confirm they fail.** Run: `pnpm vitest run packages/core/src/hlc.test.ts apps/extension/src/store && pnpm e2e e2e/store.spec.ts`. Expected: FAIL.

- [ ] **Step 4: Implement**
  - **`store-worker.ts`:**
    - `sqlite3InitModule()`, then `installOpfsSAHPoolVfs({ name: 'sop', directory: DB_DIRECTORY, initialCapacity: 8 })`, then `new pool.OpfsSAHPoolDb(DB_FILE)`, then `migrate`;
    - the `deviceId` comes from `openLocalOnlyStore().ensureMeta('deviceId')` (Task 29). In this task, inject a random id;
    - it serves `protocol.ts` requests `{ id, method, args }` → `{ id, ok, value | error }` on every attached port, one at a time (single owner, serialised);
    - it posts `StoreChange` events on `BroadcastChannel(CHANGES_CHANNEL)`.
  - **Offscreen `main.ts`:** spawns the worker and forwards `{ type: 'store:port' }` ports from `navigator.serviceWorker.onmessage` to it.
  - **Background:** `installStoreBroker` and `ensureOffscreen` (justification "Owns the local library database").
  - **`connectStore`:**
    - `openStorePort` = a new `MessageChannel`, with `port2` sent through `(await navigator.serviceWorker.ready).active!.postMessage({ type: 'store:connect' }, [port2])`;
    - on a 3000 ms timeout it reconnects once and replays the pending requests;
    - `onChange` subscribes to `CHANGES_CHANNEL`.
  - **Incognito:** the viewer calls `connectStore()` unless it is incognito (Task 30).

- [ ] **Step 5: Run them again and confirm they pass.** Run: `pnpm vitest run packages/core/src/hlc.test.ts apps/extension/src/store && pnpm e2e e2e/store.spec.ts`. Expected: PASS.

- [ ] **Step 6: Commit**
```bash
git add packages/core apps/extension e2e pnpm-lock.yaml
git commit -m "feat(store): offscreen SQLite owner, schema v1, StoreClient over a brokered MessagePort"
```

### Task 29: OPFS blob store and the local-only (secrets) store

**Files:**
- Create: `apps/extension/src/store/{blob-store.ts,blob-store.browser.test.ts,local-only.ts,local-only.browser.test.ts}`, `e2e/secrets.spec.ts`
- Modify: `apps/extension/src/store/store-worker.ts` (device id from `ensureMeta('deviceId')`), `apps/extension/src/viewer/test-hooks.ts`

**Interfaces:**
- Consumes: `createSha256`, `Sha256` (Task 18).
- Produces:
```ts
export function blobPath(sha256: Sha256): string;                    // 'pdf/ab/<sha>.pdf'
export class BlobHashMismatchError extends Error {}
export interface BlobStore {
  put(data: Blob | ReadableStream<Uint8Array>, expected?: Sha256): Promise<{ sha256: Sha256; size: number; created: boolean }>;
  get(sha256: Sha256): Promise<File | null>; has(sha256: Sha256): Promise<boolean>; delete(sha256: Sha256): Promise<void>;
}
export function openBlobStore(): Promise<BlobStore>;
export type SecretName = 'anthropic_api_key' | 'cloud_token';
export type MetaKey = 'deviceId' | 'filterSalt';
export interface LocalOnlyStore {   // IndexedDB "sop-local" v1: secrets, meta, never_save, filter_reports, handles
  getSecret(n: SecretName): Promise<string | null>; setSecret(n: SecretName, v: string): Promise<void>; deleteSecret(n: SecretName): Promise<void>;
  getMeta(k: MetaKey): Promise<string | null>; ensureMeta(k: MetaKey): Promise<string>;   // random 128-bit hex when missing
}
export function openLocalOnlyStore(): Promise<LocalOnlyStore>;
// SopTestHooks gains: blobStore: BlobStore | null; localOnly: LocalOnlyStore | null
```

- [ ] **Step 1: Write the failing tests**
```ts
// blob-store.browser.test.ts (real OPFS)
test('put streams, hashes and dedupes', async () => {
  const bytes = randomBytes(3 << 20); const s = await openBlobStore();
  const a = await s.put(new Blob([bytes])); expect(a).toMatchObject({ sha256: await sha256Hex(bytes), size: 3 << 20, created: true });
  expect((await s.put(new Blob([bytes]))).created).toBe(false);
  expect(new Uint8Array(await (await s.get(a.sha256))!.arrayBuffer())).toEqual(bytes);
  expect(blobPath(a.sha256)).toBe(`pdf/${a.sha256.slice(0, 2)}/${a.sha256}.pdf`);
});
test('wrong expected hash throws and leaves no file or temp', async () => { /* BlobHashMismatchError; pdf/ and tmp/ empty */ });
test('a 200 MB stream stays within 64 MB of JS heap growth', async () => { /* performance.memory.usedJSHeapSize delta */ });
// local-only.browser.test.ts
test('object stores and secrets round-trip', async () => {
  const l = await openLocalOnlyStore(); await l.setSecret('anthropic_api_key', 'sk-ant-test-0123456789');
  expect(await l.getSecret('anthropic_api_key')).toBe('sk-ant-test-0123456789');
  expect(await objectStoreNames('sop-local')).toEqual(['filter_reports', 'handles', 'meta', 'never_save', 'secrets']);
  expect(await l.ensureMeta('deviceId')).toMatch(/^[0-9a-f]{32}$/); expect(await l.ensureMeta('deviceId')).toBe(await l.getMeta('deviceId'));
});
// e2e/secrets.spec.ts
test('the secret never reaches the SQLite files', async ({ openViewer, server, sw }) => {
  const page = await openViewer(server.url('/f/paper-50.pdf')); const h = hooks(page);
  await h.eval((x) => x.localOnly!.setSecret('anthropic_api_key', 'sk-ant-test-0123456789'));
  await h.eval((x) => x.store!.saveDocument(SAMPLE_INPUT));
  await sw.evaluate(() => chrome.offscreen.closeDocument());          // releases the sahpool access handles
  expect(await grepOpfs(page, '.sop-db', 'sk-ant-test-0123456789')).toBe(false);
});
test('web pages and content scripts cannot open the extension store', async ({ context, server }) => {
  const p = await context.newPage(); await p.goto(server.url('/h/plain-page'));
  expect(await p.evaluate(async () => (await indexedDB.databases()).map((d) => d.name))).not.toContain('sop-local');
});
```

- [ ] **Step 2: Run them and confirm they fail.** Run: `pnpm vitest run --project browser apps/extension/src/store && pnpm e2e e2e/secrets.spec.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**
  - **`put`:**
    1. Stream into `tmp/<uuid>.part` through `createWritable()`, with `hasher.update` on every chunk.
    2. On a mismatch against `expected`, remove the temp file and throw.
    3. If the target exists, remove the temp file and return `created: false`.
    4. Otherwise call `tmpHandle.move(dirHandle('pdf/<ab>'), '<sha>.pdf')`.
  - **`local-only.ts`** uses plain `indexedDB.open('sop-local', 1)`, whose `onupgradeneeded` creates the five stores. Backup, export and sync code (Phases 3 and 5) must never import this module. Phase 3's backup test checks every backup for the key.

- [ ] **Step 4: Run them again and confirm they pass.** Run: `pnpm vitest run --project browser apps/extension/src/store && pnpm e2e e2e/secrets.spec.ts`. Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add apps/extension e2e
git commit -m "feat(store): OPFS blob store with streaming SHA-256; local-only secrets store"
```

### Task 30: The save decision: stand-in filter, identity resolution, status chip, Ctrl+Alt+S, Incognito view-only

**Files:**
- Create: `packages/core/src/filter/{types.ts,stand-in.ts,stand-in.test.ts}`, `packages/core/src/save/{save-machine.ts,save-machine.test.ts}`
- Create: `apps/extension/src/viewer/identity/{resolve-identity.ts,resolve-identity.test.ts}`, `apps/extension/src/viewer/save/{save-controller.ts,save-controller.test.ts,StatusChip.tsx,SaveAskDialog.tsx}`, `apps/extension/src/viewer/incognito.ts`, `e2e/save.spec.ts`
- Modify: `apps/extension/src/viewer/{App.tsx,commands.ts,test-hooks.ts}` (`file.saveToLibrary` = Ctrl+Alt+S; the chip goes in the header slot)

**Interfaces:**
- Consumes: `StoreClient` (Task 28), `BlobStore` (Task 29), `OpenedDocument` (Task 20), `getPageText` (Task 15), `canonicalLink` (Task 18), `getRequestInfo` through `takeover:prepare-fetch` (its reply carries `referer`, used for `viaPage`).
- Produces (Phase 2 calls `firstMark()`; Phase 3 swaps the filter):
```ts
export type FilterVerdict = 'learning' | 'not-learning' | 'unsure';
export interface FilterInput { url: string | null; fileName: string; pageCount: number; pageSizes: PageSize[]; metadata: PdfMetadata; sampleText: string[] }
export interface FilterDecision { verdict: FilterVerdict; reasons: string[] }
export function standInFilter(input: FilterInput): FilterDecision;   // { verdict: 'unsure', reasons: ['No filter yet: your first mark saves it'] }
export type SaveState =
  | { kind: 'checking' } | { kind: 'saved'; documentId: DocumentId; undoable: boolean }
  | { kind: 'unsure'; reasons: string[] } | { kind: 'not-learning'; reasons: string[] }
  | { kind: 'asking' } | { kind: 'memory-only' } | { kind: 'incognito' };
export type SaveEvent =
  | { type: 'identified'; documentId: DocumentId } | { type: 'classified'; decision: FilterDecision }
  | { type: 'save-requested' } | { type: 'first-mark' } | { type: 'saved'; documentId: DocumentId; undoable: boolean }
  | { type: 'ask-answered'; save: boolean } | { type: 'undo-requested' } | { type: 'undone' } | { type: 'undo-expired' } | { type: 'incognito' };
export type SaveEffect = { kind: 'save'; undoable: boolean } | { kind: 'forget' } | { kind: 'ask' };
export function reduceSave(s: SaveState, e: SaveEvent): { state: SaveState; effect: SaveEffect | null };
export type IdentityResult = { kind: 'known'; documentId: DocumentId; via: 'fingerprint' | 'alias' } | { kind: 'unknown' };
export function resolveIdentity(i: { sha256: Sha256; pageCount: number; pageTexts(): Promise<string[]>; location: Omit<TouchLocationInput, 'documentId'> }, store: StoreApi): Promise<IdentityResult>;
export interface SaveController { readonly state: SaveState; subscribe(cb: (s: SaveState) => void): () => void; requestSave(): Promise<void>; firstMark(): Promise<void>; undo(): Promise<void>; answerAsk(save: boolean): Promise<void> }
export function createSaveController(d: { opened: OpenedDocument; backend: PdfBackend; store: StoreClient | null; blobs: BlobStore | null; filter: (i: FilterInput) => FilterDecision; incognito: boolean; location: { kind: LocationKind; raw: string; viaPage: string | null } | null; now(): number }): SaveController;
export function isIncognito(): boolean;                              // chrome.extension.inIncognitoContext
// SopTestHooks gains: save: { state(): SaveState; documentId(): DocumentId | null; firstMark(): Promise<void> }
```

- [ ] **Step 1: Write the failing unit tests**
```ts
// save-machine.test.ts: the transition table
test.each([
  [{ kind: 'checking' }, { type: 'identified', documentId: D }, { kind: 'saved', documentId: D, undoable: false }, null],
  [{ kind: 'checking' }, { type: 'classified', decision: UNSURE }, { kind: 'unsure', reasons: UNSURE.reasons }, null],
  [{ kind: 'checking' }, { type: 'classified', decision: LEARNING }, { kind: 'checking' }, { kind: 'save', undoable: false }],
  [{ kind: 'checking' }, { type: 'classified', decision: NOT }, { kind: 'not-learning', reasons: NOT.reasons }, null],
  [{ kind: 'unsure', reasons: [] }, { type: 'first-mark' }, { kind: 'unsure', reasons: [] }, { kind: 'save', undoable: true }],
  [{ kind: 'unsure', reasons: [] }, { type: 'save-requested' }, { kind: 'unsure', reasons: [] }, { kind: 'save', undoable: false }],
  [{ kind: 'not-learning', reasons: [] }, { type: 'first-mark' }, { kind: 'asking' }, { kind: 'ask' }],
  [{ kind: 'asking' }, { type: 'ask-answered', save: true }, { kind: 'asking' }, { kind: 'save', undoable: false }],
  [{ kind: 'asking' }, { type: 'ask-answered', save: false }, { kind: 'memory-only' }, null],
  [{ kind: 'memory-only' }, { type: 'first-mark' }, { kind: 'memory-only' }, null],
  [{ kind: 'memory-only' }, { type: 'save-requested' }, { kind: 'memory-only' }, { kind: 'save', undoable: false }],
  [{ kind: 'saved', documentId: D, undoable: true }, { type: 'undo-requested' }, { kind: 'saved', documentId: D, undoable: true }, { kind: 'forget' }],
  [{ kind: 'saved', documentId: D, undoable: true }, { type: 'undone' }, { kind: 'unsure', reasons: STAND_IN_REASONS }, null],
  [{ kind: 'saved', documentId: D, undoable: true }, { type: 'undo-expired' }, { kind: 'saved', documentId: D, undoable: false }, null],
  [{ kind: 'saved', documentId: D, undoable: false }, { type: 'first-mark' }, { kind: 'saved', documentId: D, undoable: false }, null],
  [{ kind: 'incognito' }, { type: 'save-requested' }, { kind: 'incognito' }, null],
  [{ kind: 'incognito' }, { type: 'first-mark' }, { kind: 'incognito' }, null],
])('reduceSave %#', (s, e, state, effect) => expect(reduceSave(s as SaveState, e as SaveEvent)).toEqual({ state, effect }));
// resolve-identity.test.ts (recording fake store)
test('unknown PDFs cause reads only', async () => {
  const s = recordingStore({ known: [], sameCount: 0 });
  expect(await resolveIdentity(INPUT, s)).toEqual({ kind: 'unknown' });
  expect(s.calls.every((c) => ['resolveFingerprint', 'countDocumentsWithPageCount', 'findStampAlias'].includes(c))).toBe(true);
});
test('a stamped re-download becomes an alias, then touches its location and records the open', async () => { /* calls include addAlias, touchLocation, recordOpen */ });
test('page texts are extracted only when a same-page-count document exists', async () => { /* pageTexts not called when count is 0 */ });
// save-controller.test.ts
test('save effect: blob first, then document, then page text in batches of 50', async () => { /* call order on fakes; 120 pages → 3 putPageText calls */ });
test('incognito never touches store or blobs and shows the incognito state', async () => { /* store/blobs null; state.kind === 'incognito' */ });
test('Undo after a first-mark save forgets the document and deletes the blob; Undo expires after 10 s', async () => { /* firstMark → saved, undoable; undo → forgetDocument(id) and blobs.delete(sha256) called, state unsure; a second run with fake timers: +10,000 ms → undoable false */ });
```

- [ ] **Step 2: Write the failing e2e tests**
```ts
test('an unknown PDF shows "Not sure: Save?" and writes nothing (privacy)', async ({ openViewer, server }) => {
  const page = await openViewer(server.url('/f/paper-50.pdf'));
  await expect(page.getByRole('button', { name: 'Not sure: Save?' })).toBeVisible();
  expect(await hooks(page).eval((h) => h.store!.stats())).toEqual({ documents: 0, aliases: 0, locations: 0, pageText: 0, history: 0, outbox: 0 });
  expect(await opfsList(page, 'pdf')).toEqual([]);
});
test('clicking the chip saves: blob, rows and searchable text', async ({ openViewer, server }) => {
  const page = await openViewer(server.url('/f/paper-50.pdf')); await page.getByRole('button', { name: 'Not sure: Save?' }).click();
  await expect(page.getByRole('button', { name: 'Saved to library' })).toBeVisible();
  const h = hooks(page);
  expect(await h.eval((x) => x.store!.stats())).toMatchObject({ documents: 1, locations: 1, history: 1, pageText: 50 });
  expect((await h.eval((x) => x.store!.searchPages('household wealth', 5)))[0].pageIndex).toBe(0);
  expect(await h.eval((x) => x.blobStore!.has(x.save.documentId()!))).toBe(true);
});
test('reopening the same link shows "Saved to library" with the same document id', async ({ openViewer, server }) => {
  const a = await openViewer(server.url('/f/paper-50.pdf')); await a.getByRole('button', { name: 'Not sure: Save?' }).click();
  const id = await hooks(a).eval((h) => h.save.documentId());
  const b = await openViewer(server.url('/f/paper-50.pdf'));
  await expect(b.getByRole('button', { name: 'Saved to library' })).toBeVisible();
  expect(await hooks(b).eval((h) => h.save.documentId())).toBe(id);
  expect((await hooks(b).eval((h) => h.store!.stats())).documents).toBe(1);
});
test('JSTOR-style stamps: one link served three times with different stamps → one document, two aliases', async ({ openViewer, server }) => {
  server.serveSequence('/jstor/stable/pdf/12345.pdf', [
    await makeStampedPdf({ ip: '158.143.197.12', date: 'Tue, 31 Oct 2026 10:41:07 UTC' }),
    await makeStampedPdf({ ip: '81.2.69.160', date: 'Wed, 1 Nov 2026 09:02:11 UTC' }),
    await makeStampedPdf({ ip: '10.20.30.40', date: 'Thu, 2 Nov 2026 18:00:00 UTC' }),
  ]);
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const page = await openViewer(server.url('/jstor/stable/pdf/12345.pdf'));
    if (i === 0) await page.getByRole('button', { name: 'Not sure: Save?' }).click();
    await expect(page.getByRole('button', { name: 'Saved to library' })).toBeVisible();
    ids.push(await hooks(page).eval((h) => h.save.documentId()!));
    if (i === 2) expect(await hooks(page).eval((h) => h.store!.stats())).toMatchObject({ documents: 1, aliases: 2 });
  }
  expect(new Set(ids).size).toBe(1);
});
test('a different paper with the same page count is not an alias', async () => { /* makeStampedPdf(…, 'other-body') → "Not sure: Save?" */ });
test('a moved and renamed file keeps its identity and gains a location', async ({ openViewer }) => {
  /* save file:///…/dir with spaces/Week 3 – café #2.PDF; copy to …/other/renamed.pdf; open → "Saved to library", same id, listLocations().length === 2 */
});
test('first mark on an unsure PDF saves with Undo; Undo forgets it', async ({ openViewer, server }) => {
  const page = await openViewer(server.url('/f/paper-50.pdf')); await hooks(page).eval((h) => h.save.firstMark());
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('button', { name: 'Not sure: Save?' })).toBeVisible();
  expect((await hooks(page).eval((h) => h.store!.stats())).documents).toBe(0);
});
test('Ctrl+Alt+S saves while reading but not while typing in the find box', async ({ openViewer, server }) => {
  const page = await openViewer(server.url('/f/paper-50.pdf'));
  await page.keyboard.press('Control+f'); await page.keyboard.press('Control+Alt+s');
  await expect(page.getByRole('button', { name: 'Not sure: Save?' })).toBeVisible();
  await page.keyboard.press('Escape'); await page.keyboard.press('Control+Alt+s');
  await expect(page.getByRole('button', { name: 'Saved to library' })).toBeVisible();
});
test('Review Focus 5: two tabs save the same new PDF at once → one document, one blob', async ({ openViewer, server }) => {
  const [a, b] = [await openViewer(server.url('/f/paper-50.pdf')), await openViewer(server.url('/f/paper-50.pdf'))];
  await Promise.all([a, b].map((p) => p.getByRole('button', { name: 'Not sure: Save?' }).click()));
  expect(await hooks(a).eval((h) => h.store!.stats())).toMatchObject({ documents: 1, locations: 1 });
  expect((await opfsList(a, 'pdf')).length).toBe(1);
});
test('Review Focus 5: closing the offscreen document mid-save still saves', async ({ openViewer, server, sw }) => {
  const page = await openViewer(server.url('/f/paper-50.pdf'));
  await Promise.all([page.getByRole('button', { name: 'Not sure: Save?' }).click(), sw.evaluate(() => chrome.offscreen.closeDocument())]);
  await expect(page.getByRole('button', { name: 'Saved to library' })).toBeVisible({ timeout: 10_000 });
  expect((await hooks(page).eval((h) => h.store!.stats())).documents).toBe(1);
});
```

- [ ] **Step 3: Run them and confirm they fail.** Run: `pnpm vitest run packages/core/src/filter packages/core/src/save apps/extension/src/viewer/identity apps/extension/src/viewer/save && pnpm e2e e2e/save.spec.ts`. Expected: FAIL.

- [ ] **Step 4: Implement**
  - **Open flow** (in `App.tsx`, after `openDocument` is ready):
    1. If `isIncognito()`, dispatch `incognito`. Otherwise `connectStore()` and `openBlobStore()`.
    2. `resolveIdentity(...)`. When the result is known: `identified`, `touchLocation` and `recordOpen`. When unknown: `classified(standInFilter(...))`.
    3. The location is `{ kind: source.startsWith('file:') ? 'file' : 'url', raw: cleanLink(source) or the file URL, viaPage: canonicalLink(back ?? referer) or null }`.
  - **Save effect:**
    1. `blobs.put(loaded.blob, loaded.sha256)`.
    2. `store.saveDocument({ id: sha256, byteSize, pageCount, title: metadata.title, authors: [], pdfId: metadata.pdfId, hasText: (any page text non-empty), encrypted, blobStored: true, saveReasons: decision.reasons, location, openedAt })`. Phase 3 adds full metadata extraction.
    3. `putPageText` in batches of 50 pages (it reuses texts already extracted for the alias check).
    4. Dispatch `saved`.
  - **Forget effect:** `store.forgetDocument(id)` then `blobs.delete(sha256)`.
  - **Chip copy, in the header slot:**

    | State | Label | Notes |
    | --- | --- | --- |
    | `saved` | "Saved to library" | icon `library_add_check`, tone `saved`; tooltip from the save reasons, or "Already in your library" |
    | `saved` + `undoable` | "Saved to library" | plus a `TextButton` "Undo" for 10 s |
    | `unsure` | "Not sure: Save?" | icon `library_add`, tone `attention`; tooltip = the reasons |
    | `not-learning` | `Not saved: ${reasons[0]}` | |
    | `memory-only` | "Not saved: notes kept until you close this tab" | |
    | `incognito` | "Incognito: view only" | disabled |
    | `checking` | (no chip) | |

    `SaveAskDialog` reads "Save this PDF to keep your notes?" with buttons "Save" and "No".

- [ ] **Step 5: Run them again and confirm they pass.** Run: `pnpm vitest run packages/core apps/extension/src/viewer && pnpm e2e e2e/save.spec.ts`. Expected: PASS.

- [ ] **Step 6: Commit**
```bash
git add packages/core apps/extension e2e
git commit -m "feat(viewer): save decision with stand-in filter, identity and aliases, status chip, Incognito view-only"
```

### Task 31: Form-PDF bounce to Chrome's viewer

**Files:**
- Create: `apps/extension/src/viewer/forms/{form-bounce.ts,form-bounce.test.ts,FormBanner.tsx}`, `e2e/forms.spec.ts`
- Modify: `apps/extension/src/viewer/App.tsx`, `e2e/support/server.ts` (`/h/form.pdf` = HMRC SA100, `/h/form-once.pdf`, `/h/hyperref.pdf` = NBER)

**Interfaces:**
- Consumes: `getFormInfo` and `hasFillableFields` (Task 15); `SaveController` (Task 30); `takeover:open-in-chrome` (Task 17); `takeover:prepare-fetch` (Task 16).
- Produces:
```ts
export type FormBounceAction = 'stay' | 'bounce' | 'stay-with-banner';
export function decideFormBounce(i: { fillable: boolean; source: string | null; refetchable: boolean }): FormBounceAction;
export function probeRefetch(source: string): Promise<boolean>;   // http(s): GET Range bytes=0-1023 → 200/206 and starts with %PDF-; file: XHR ok
export function runFormBounce(ctx: { opened: OpenedDocument; backend: PdfBackend; save: SaveController; source: string | null }): Promise<FormBounceAction>;
```

- [ ] **Step 1: Write the failing tests**
```ts
test.each([
  [{ fillable: false, source: 'https://a/x.pdf', refetchable: true }, 'stay'],
  [{ fillable: true, source: 'https://a/x.pdf', refetchable: true }, 'bounce'],
  [{ fillable: true, source: 'https://a/x.pdf', refetchable: false }, 'stay-with-banner'],
  [{ fillable: true, source: null, refetchable: false }, 'stay-with-banner'],          // opened from a File
])('decideFormBounce %#', (i, a) => expect(decideFormBounce(i)).toBe(a));
// e2e/forms.spec.ts
test('a real form (HMRC SA100) reopens in Chrome\'s viewer and stays there', async ({ context, server }) => {
  const page = await context.newPage(); await page.goto(server.url('/h/form.pdf'));
  await expect(page.getByText('This PDF has fillable fields. Opening it in Chrome\'s viewer so you can fill it in…')).toBeVisible();
  await page.waitForURL(server.url('/h/form.pdf')); await page.waitForTimeout(2000); expect(page.url()).toBe(server.url('/h/form.pdf'));
});
test('a hyperref AcroForm paper stays in our viewer', async ({ openViewer, server }) => {
  const page = await openViewer(server.url('/h/hyperref.pdf')); await page.waitForTimeout(2000);
  expect(page.url()).toMatch(/viewer\.html/);
});
test('a form that cannot be fetched again stays, with a banner', async ({ openViewer, server }) => {
  await expect((await openViewer(server.url('/h/form-once.pdf'))).getByText("This PDF has fillable fields. Chrome's viewer can't reopen it from this link, so it stays here.")).toBeVisible();
});
test('a local form file bounces to its file URL', async () => { /* file:// copy of the HMRC fixture */ });
```

- [ ] **Step 2: Run them and confirm they fail.** Run: `pnpm vitest run apps/extension/src/viewer/forms && pnpm e2e e2e/forms.spec.ts`. Expected: FAIL.

- [ ] **Step 3: Implement `runFormBounce`**

  It runs after the save decision settles; the spec's order is "classified first and saved if they are learning PDFs".
  1. Check `hasFillableFields(await backend.getFormInfo(doc))`.
  2. For http(s), send `takeover:prepare-fetch`, then `probeRefetch`.
  3. On `bounce`: show the notice for 1500 ms, then send `takeover:open-in-chrome`.
  4. On `stay-with-banner`: show `FormBanner` (`Banner` with dismiss).

- [ ] **Step 4: Run them again and confirm they pass.** Run: `pnpm vitest run apps/extension/src/viewer/forms && pnpm e2e e2e/forms.spec.ts`. Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add apps/extension e2e
git commit -m "feat(viewer): fillable-form PDFs reopen in Chrome's viewer via a one-time allow rule"
```

### Task 32: Phase 1 gate: the Windows checklist and the gate list

**Files:**
- Create: `docs/checklists/phase1-windows.md`, `docs/checklists/phase1-gate.md`
- Modify: root `package.json` (add `"gate:phase1": "SOP_GATE=1 pnpm fixtures && SOP_GATE=1 pnpm e2e"`)

**Interfaces:**
- Consumes: the Windows hand-offs W-B1 to W-B3 (Task 8); every Phase 1 test.
- Produces: the signed checklist and the gate results that open Phase 2.

- [ ] **Step 1: Write `docs/checklists/phase1-windows.md`**

  The user runs it on their PC with the Phase 1 build (Load unpacked, `apps/extension/.output/chrome-mv3`) and fills a "Result / notes" column for every item:
  - **W1 Double-click chain.** Settings → Apps → Default apps → `.pdf` → Google Chrome. Double-click `Downloads\paper-50.pdf` in File Explorer. Our viewer opens in the same tab; the address starts with `chrome-extension://<EXTENSION_ID>/viewer.html`.
  - **W2 File-access toggle.** With "Allow access to file URLs" off, a double-click shows our "Allow access to file URLs" dialog. "Open extension settings" opens the Details page. Switching the toggle on reloads the extension and closes its tabs. A second double-click opens the viewer.
  - **W3 Spaces and non-ASCII.** `Documents\Week 3 – Économie #2.PDF`, `Documents\Читання\论文.pdf` and `Documents\100% notes.pdf` all open. Save one, rename it and move it to another folder; reopening shows "Saved to library".
  - **W4 OneDrive placeholders.** Mark a PDF in OneDrive "Free up space" (cloud icon). A double-click downloads it and opens the viewer. Note the seconds it takes.
  - **W5 ZIP.** Open a PDF inside a `.zip` from Explorer (Windows extracts it to Temp). The viewer opens. Save it, then open another copy of the same file: "Saved to library".
  - **W6 Backup-folder permission after restart (W-B1).** Use the Phase 0 spike build's `backup-folder` page: pick a folder, restart Chrome, reopen the page. Note `queryPermission` and whether the "Allow on every visit" prompt appears.
  - **W7 Writing into Google Drive for desktop (W-B2).** Pick `G:\My Drive\sickofpdfs-test`. `backup-probe.txt` appears on drive.google.com within 2 minutes.
  - **W8 OneDrive folder (W-B3).** The same as W7 for `OneDrive\sickofpdfs-test`.
  - **W9 Speed at 150% scaling.** Help → About shows "First page drawn in N ms" for `paper-50.pdf`, which must be under 1200 (1 s + 20%). Scroll `scan-600.pdf` quickly with the wheel for 10 s: no blank page lasts noticeably long. The `sop:blank:*` maximum in DevTools → Performance must be under 180 ms.
  - **W10 Keys on your layout.** Ctrl+= and Ctrl++ zoom in, Ctrl+− zooms out, Ctrl+0 fits the width, and Ctrl+wheel and touchpad pinch zoom the page, never the browser. Ctrl+F finds. Ctrl+P prints. Ctrl+S downloads.
  - **W11 Moodle.** A Moodle page with an embedded PDF opens it in the full tab with "Back to page". Back returns to the page and does not bounce again.
  - **W12 Forms.** The HMRC SA100 from gov.uk opens in Chrome's viewer and is fillable.
  - **W13 Incognito.** Allow the extension in Incognito and open a PDF link there. The chip reads "Incognito: view only". In a normal window, the same link still shows "Not sure: Save?".

- [ ] **Step 2: Write `docs/checklists/phase1-gate.md`**

  The automated gates, all green on CI and locally:
  - `pnpm typecheck`;
  - `pnpm lint` (including `sop/no-raw-design-values`);
  - `pnpm test` and `pnpm test:browser`;
  - `pnpm e2e`, with the network gate on every test;
  - the screenshot baselines unchanged, or approved;
  - the axe scan clean;
  - the CI-threshold perf smoke.

  On the reference laptop (pinned Windows, stable Chrome, 150% scaling, 20% tolerance): `pnpm gate:phase1`. It must report first page ≤ 1200 ms and a worst blank ≤ 180 ms.

  Critics: four fresh critic agents (visual, experience, code and security, student) review the spec, the build and the screenshots. The gate needs zero critical and zero major findings. The visual critic compares the viewer with `docs/research/drive-refs/live-09…16` and `crop-34/35`.

  The user signs `phase1-windows.md`. The demo is screenshots of the viewer, menus, rail, find, presentation, the chip states and the error card, plus a screen recording of W1 and W11.

  Not yet gated (they belong to later phases): the crash test (Phase 2), keyboard layouts UK/US/DE/PL (Phase 2), the filter sets (Phase 3).

- [ ] **Step 3: Run the gate.** Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:browser && pnpm e2e`. Expected: PASS. Then `pnpm gate:phase1` on the reference laptop; record the numbers in `phase1-gate.md`.

- [ ] **Step 4: Commit**
```bash
git add docs/checklists package.json
git commit -m "docs: Phase 1 Windows checklist and gate list"
```

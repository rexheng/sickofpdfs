# 03 — Platform & Claude plumbing (Chrome MV3 extension only, Windows 11 + Chrome)

Research date: 2026-10-31. Scope changed mid-research to **Chrome MV3 extension only**: there is no desktop app.

How to read the tags:
- **[V]** means verified this session against a primary source (docs page, upstream source code, or the npm package contents), and the source is named.
- **[U]** means unverified: an inference, a third-party report, or something that has to be tested on the user's Windows PC.

> **Dropped desktop track:** I verified Electron 45.2.1 (Node 24.22.1), electron-builder 26.18.0 (stable) / 27.0.0-alpha, and the Windows default-apps rules: apps cannot set defaults silently, and the `ms-settings:defaultapps?registeredAppUser=` deep link exists. None of it applies any more, except the fact (used below) that Windows lets the *user* make Chrome the `.pdf` default.

---

## 0. Recommendations at a glance

| Area | v1 recommendation |
|---|---|
| PDF takeover | Copy the **mozilla/pdf.js `extensions/chromium` design**: dynamic `declarativeNetRequest` redirect rules on response headers (Chrome 128+), a `webNavigation` fallback for `file://`, and a content script for `<embed>`/`<object>`. Skip POST-loaded PDFs. |
| Local double-click | The user sets **Chrome as the Windows `.pdf` default** and enables **"Allow access to file URLs"**. The DNR `file://` rule then redirects to our viewer. |
| Library storage | **PDF bytes as content-addressed files in OPFS** (`/pdf/ab/<sha256>.pdf`). **Metadata, page text and notes in SQLite-Wasm 3.54.1 with FTS5** on the `opfs-sahpool` VFS, run in a dedicated Worker owned by **one offscreen document**, which acts as the single DB owner. Declare `unlimitedStorage`. |
| Backup (v1) | **Auto-backup to a user-chosen folder via the File System Access API.** Point it at a Google Drive for desktop / OneDrive folder. Back up on every save, plus a manual "Export library" zip. Drive API sync is v2. |
| Search | SQLite FTS5 (`bm25`, `snippet`, `highlight`). Fallback: Dexie 4.4.7 + MiniSearch 7.2.0 over notes only. |
| @Claude | Call the Messages API **from the viewer tab** (not the service worker) with `@anthropic-ai/sdk` 1.3.0 and `dangerouslyAllowBrowser: true`. Send the document as a per-page custom-content `document` block with citations and `cache_control`. Stream the reply. Store the key in extension IndexedDB. |
| Claude sees the library | Ranked simplest first: (1) backup folder + Claude Desktop **Filesystem** extension → (2) the same folder inside Google Drive for desktop + Claude's **Google Drive connector** → (3) Drive API sync of Google Docs → (4) remote MCP on Cloudflare Workers + D1/R2 with OAuth. |
| Delivery | Start with **Load unpacked plus a fixed manifest `"key"`**. Move to a Chrome Web Store **unlisted** listing when you want auto-updates or a stable OAuth client. |
| Hotkey | In our viewer page, a `keydown` handler for Ctrl+Alt+M with an AltGr guard. `chrome.commands` cannot use Ctrl+Alt. |

---

## 1. PDF takeover in MV3 (how pdf.js does it)

Source: `mozilla/pdf.js` master @ 743102c (2026-10-30): `extensions/chromium/{manifest.json,pdfHandler.js,contentscript.js,extension-router.js,preserve-referer.js}` and `web/chromecom.js`. **[V]**

### 1.1 Mechanism
- **MV3 manifest [V]:** permissions `declarativeNetRequestWithHostAccess`, `webRequest` (non-blocking, used only to remember Referer and the request method), `webNavigation`, `tabs`, `storage`, `alarms`; `host_permissions: ["<all_urls>"]`. The viewer page is listed in `web_accessible_resources` because it is the redirect target.
- **CSP [V]:** `"extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"`. pdf.js needs `wasm-unsafe-eval` for its decoders. pdfjs-dist 6.4.299 ships `wasm/openjpeg.wasm`, `jbig2.wasm`, `qcms_bg.wasm` and `quickjs-eval.wasm`; point the `wasmUrl` getDocument option at that folder. **[V: package contents, `types/src/display/api.d.ts`]**
- **Dynamic DNR rules, registered once per session from the service worker [V].** They persist, so redirects work even while the service worker is asleep. Highest priority first:
  1. URLs containing `pdfjs.action=download` → `allow` (escape hatch).
  2. `^file://.*\.pdf$` (main_frame, sub_frame) → redirect to the viewer. This only fires when file access is allowed.
  3. A sub_frame with `Content-Disposition: attachment*` → `allow`, so attachments in iframes are respected.
  4. A main_frame with `=download` in the URL **and** CD attachment → `allow` (the Google Drive download case).
  5. `Content-Type: application/pdf` or `application/pdf;*`, excluding POST → redirect.
  6. `application/octet-stream` with `.pdf` in the URL → redirect.
  7. CD filename `*.pdf` with a Content-Type that is not octet-stream → redirect. This uses `excludedResponseHeaders` to simulate AND.
- **Redirect target [V]:** `regexSubstitution: VIEWER_URL + "?DNR:\\0"`. DNR cannot URL-encode, so the viewer parses everything after `?DNR:`.
- **`responseHeaders` conditions need Chrome 128+ [V].** pdf.js feature-detects with a session-rule probe, because Chrome 123–127 silently ignore the condition and would redirect *everything*.
- **Main-frame Content-Disposition [V]:** in the main frame, pdf.js shows the viewer **even when CD is `attachment`**, unless the URL contains `=download`. pdf.js's reasoning: "most often users want to view a PDF, and servers are often misconfigured."
- **POST-loaded PDFs [V]:** excluded (`excludedRequestMethods: ["post"]`). The viewer cannot replay the POST body, so these stay in Chrome's built-in viewer (pdf.js issue #4483, still open).
- **`<embed>`/`<object>` [V]:** a content script at `document_start` in all frames uses a CSS-animation trick (`pdfjs-detected-object-or-embed`) to detect PDF embeds and swap in the viewer. It skips Chrome's own internal embed (`about:blank` src since Chrome 76).
- **Sniffed PDFs [V]:** when there is no Content-Type but `document.contentType === "application/pdf"`, the content script overlays a closed-shadow-root iframe of the viewer. A direct navigation crashed Chrome before version 129.
- **Referer [V]:** `preserve-referer.js` records the original Referer (webRequest `onSendHeaders`, `extraHeaders`) and reattaches it to the viewer's re-fetch, because some hosts check Referer.
- **Transport in the viewer [V]:** pdf.js uses `fetch` only for http(s) (`isValidFetchUrl` → `PDFFetchStream`). For `file:` it uses the XHR-based `PDFNetworkStream`. `fetch()` cannot read `file://`.
- **Re-fetch caveats [U]:** the viewer re-requests the URL with a GET from the extension origin. PDFs behind short-lived signed URLs, one-time tokens or POST forms may fail. Also unverified: whether login cookies are sent for every site under current third-party-cookie rules.

### 1.2 `file://` and the "Allow access to file URLs" toggle
- **Without the toggle [V]:** DNR does not see `file://` requests. pdf.js falls back to `webNavigation.onBeforeNavigate` with `urlPrefix: "file://"` and suffix `.pdf`/`.PDF`, sends the tab to the viewer, and the viewer shows a dialog. The dialog links to `chrome://extensions/?id=…` (opened via the service worker, because pages cannot navigate to `chrome://`) and also offers an `<input type=file>` fallback.
- **Toggling reloads the extension [V]:** turning file access on **reloads the extension, and Chrome closes the extension's tabs** (comment in `chromecom.js`). Do this during onboarding, not mid-reading.
- **Detection [V]:** `chrome.extension.isAllowedFileSchemeAccess()`.
- **Embedding guard [V]:** pdf.js only lets local files load when the embedder is `file:` or `chrome-extension:`.

### 1.3 Chrome as the Windows default PDF app (end to end)
1. **[V: several how-to guides, including pureinfotech and Illinois State IT]** Windows 11 lists Google Chrome as a handler for `.pdf`. The user picks it under Settings → Apps → Default apps → `.pdf`, or via "Open with → Choose another app → Always". Windows forbids programmatic changes (UCPD.sys) **[V: MS Learn "Windows app defaults platform", 2026-09-26]**, so this must be a user step in onboarding. **[U]** Chrome has also experimented with its own "make Chrome your default PDF viewer" prompt (windowsreport).
2. **[U, standard Chrome behaviour]** Double-clicking a PDF launches Chrome with the path, which opens as `file:///C:/…/x.pdf`.
3. **[V: pdf.js rule #2]** With file access on, our dynamic DNR rule redirects to `viewer.html?DNR:file:///C:/…`. The viewer reads the file with XHR. Rule matching is case-insensitive by default, so `.PDF` also matches **[U]**.
4. **End-to-end status [U]:** not tested on Windows in this session. **Test this first on the user's PC.** Cases to cover: paths with spaces and non-ASCII characters, OneDrive "online-only" files, and PDFs opened from inside a ZIP (Explorer extracts them to Temp).

### 1.4 Skeleton (adapted from pdf.js, Apache-2.0)
```js
// background.js (MV3 service worker)
const VIEWER = chrome.runtime.getURL("viewer.html");
const redirect = { type: "redirect", redirect: { regexSubstitution: VIEWER + "?DNR:\\0" } };
const rules = [
  { condition: { urlFilter: "pdfjs.action=download", resourceTypes: ["main_frame","sub_frame"] }, action: { type: "allow" } },
  { condition: { regexFilter: "^file://.*\\.pdf$", resourceTypes: ["main_frame","sub_frame"] }, action: redirect },
  { condition: { urlFilter: "*", resourceTypes: ["sub_frame"],
      responseHeaders: [{ header: "content-disposition", values: ["attachment*"] }] }, action: { type: "allow" } },
  { condition: { regexFilter: "^.*$", excludedRequestMethods: ["post"], resourceTypes: ["main_frame","sub_frame"],
      responseHeaders: [{ header: "content-type", values: ["application/pdf","application/pdf;*"] }] }, action: redirect },
].map((r, i, a) => ({ ...r, id: i + 1, priority: a.length - i }));
chrome.runtime.onInstalled.addListener(async () => {
  const old = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: old.map(r => r.id), addRules: rules });
});
// viewer.ts: recover the original URL
const href = location.href, i = href.indexOf("?DNR:");
const src = i >= 0 ? href.slice(i + 5) : new URLSearchParams(location.search).get("file");
```

---

## 2. Local files and moved files

| Capability | Status |
|---|---|
| Read a `file://` URL from an extension page | XHR works when "Allow access to file URLs" is on **[V: pdf.js transport and dialog]**. `fetch()` rejects the `file:` scheme **[V: pdf.js only uses fetch for http(s)]**. |
| `showOpenFilePicker` / `showDirectoryPicker` / `showSaveFilePicker` | They work in extension **tabs and popup windows**. They need a user gesture **[V: Chrome Enterprise policy page]**. They **fail in the service worker**, which has no window **[V: crbug 40240444]**. The **action popup closes when the picker opens** (reported for Chrome 154 on macOS) **[V: issue 570122817]**, so always use a full tab. |
| Write back in place | Possible only with a `FileSystemFileHandle` obtained from the picker or from drag-and-drop. Call `requestPermission({mode:"readwrite"})`, then `createWritable()`; `createWritable` throws `NotAllowedError` without the grant **[V: MDN]**. A PDF opened via a `file://` URL comes with **no handle**, so it cannot be overwritten silently. The only option is "Save as…" via `showSaveFilePicker`, where the user re-picks the file. |
| Persist handles | Handles are structured-cloneable into IndexedDB **[V: WICG spec / Chrome docs]**. After a restart `queryPermission()` usually reports `"prompt"`, and `requestPermission()` needs a click. |
| "Allow on every visit" | Shipped in Chrome 122. The three-way prompt appears when a stored handle is re-requested; installed PWAs persist grants automatically **[V: Chrome blog, persistent permissions]**. **Whether `chrome-extension://` origins get the three-way prompt is undocumented [U].** Extension developers report re-prompts every session (WICG issue #289, chromium-extensions thread). Plan for a "Reconnect folder" button. |
| Drag and drop | Dropping onto our viewer gives a `File`. `DataTransferItem.getAsFileSystemHandle()` also gives a handle that can be written back **[U: Chromium API; ponyfill README confirms the method]**. |
| Moved or renamed files | Identify documents by **SHA-256 of the bytes**, plus pdf.js `fingerprints[0]` as a secondary key **[V: pdf.js `get fingerprints()`; the first element is always defined]**. A moved file hashes the same, so its notes reattach. A stored `FileSystemFileHandle` probably throws `NotFoundError` after a move **[U]**. Our OPFS copy is the source of truth anyway. |

---

## 3. Storage inside the extension

### 3.1 Quotas and limits
- **`unlimitedStorage` [V: Chrome "storage and cookies" doc]:** "affects both extension and web storage APIs and exempts extensions from both quota restrictions and eviction."
- **Default quota without it [V: web.dev, 2024-09]:** an origin may use up to 60% of disk, and the browser up to 80% total.
- **Clearing browsing data [V]:** does not clear extension storage.
- **`chrome.storage` [V: API reference, 2026-10-29]:**
  - `local`: 10 MB, unlimited with the permission.
  - `session`: 10 MB, in memory.
  - `sync`: **100 KB total, 8 KB per item, 512 items, 120 writes/min, 1,800 writes/h.** That is settings only, not notes.
  - `local`, `sync` and `managed` are **exposed to content scripts by default**. `setAccessLevel()` changes that.
- **OPFS vs IndexedDB for PDF copies:**
  - OPFS stores real files with streaming reads and writes, and `getFile()` hands a `Blob` straight to pdf.js. This is the better fit for hundreds of MB to several GB.
  - `createSyncAccessHandle` works **only in dedicated workers** and only for OPFS files. It takes an exclusive lock in `readwrite` mode **[V: MDN]**.
  - `createWritable()` is available in windows and workers **[V: MDN, "available in Web Workers"]**.
  - IndexedDB Blobs also work, but large blobs make backups and exports awkward.

### 3.2 Uninstall, reinstall, reload
- **[V]** `chrome.storage.local` "is cleared when the extension is removed" (API reference).
- **[U, strongly indicated]** IndexedDB, OPFS and Cache Storage of the `chrome-extension://<id>` origin are also deleted on uninstall. User reports of lost IndexedDB after a reinstall support this; Chrome's docs don't state it outright. **Treat uninstall as total data loss.**
- **[U]** Reloading or updating keeps the data. `chrome.storage.session` *is* cleared on reload and update **[V]**.
- **Load unpacked trap [V: Chrome OAuth doc, "Preserving a single ID is essential"]:** without a manifest `"key"`, the extension ID derives from the folder path. Moving the folder means a new ID, a new origin, and an apparently empty library.

### 3.3 Backup / sync options
| Option | Facts | Verdict |
|---|---|---|
| **(a) FSA auto-backup folder** | The user picks a folder once (e.g. `…\My Drive\PDF Library` under Google Drive for desktop, or `OneDrive\…`). The handle is stored in IndexedDB. After every save, write `library.json` (notes, threads, metadata) and copy new PDFs as `pdf/<sha>.pdf`, plus `notes/<title>.md` for humans and Claude. Weaknesses: the re-permission prompt each session **[U for extension origins]**, so backups pause until the user clicks "Reconnect", which must be visible in the UI. Writes need an open extension page or the offscreen doc; the service worker can't prompt. Writing into Drive-for-desktop's `G:` virtual drive is **[U]**, so test it; a OneDrive folder under `C:\Users` should behave like any local folder **[U]**. | **v1 pick**: zero OAuth, zero server, and it feeds §5b options 1 and 2. |
| **(b) Drive API via `chrome.identity`** | Setup **[V: Chrome OAuth how-to + identity reference]**: (1) stable ID via `"key"`; (2) Google Cloud project, enable Drive API; (3) OAuth consent screen (External; add yourself as test user); (4) create an OAuth client of type **Chrome Extension** with the extension ID as Item ID; (5) manifest `"oauth2": {client_id, scopes:["https://www.googleapis.com/auth/drive.file"]}` and the `"identity"` permission; (6) `chrome.identity.getAuthToken({interactive:true})`. `drive.file` is **non-sensitive** and needs only basic verification **[V: Drive scopes guide]**. In **Testing** mode Google issues refresh tokens that **expire in 7 days** (except for basic profile scopes) **[V: Google OAuth2 doc]**. How that affects Chrome-managed `getAuthToken` tokens is **[U]**; expect a weekly re-consent while in Testing. `getAuthToken` may need the user signed in to Chrome; `launchWebAuthFlow` with `https://<id>.chromiumapp.org/*` is the alternative **[V: identity reference]**. Upload large PDFs from a tab with resumable uploads: the service worker gets killed if a `fetch` response takes over 30 s **[V: SW lifecycle doc]**. | **v2**: robust background sync, more setup. |
| **(c) `chrome.storage.sync`** | 100 KB total and 8 KB per item **[V]**. | Settings only (theme, hotkey, default model). |

Also call `navigator.storage.persist()` at startup. It is belt-and-braces; `unlimitedStorage` already exempts the extension from eviction **[V]**.

---

## 4. Full-text search

| Option | Facts | Fit |
|---|---|---|
| **SQLite-Wasm `@sqlite.org/sqlite-wasm` 3.54.1-build1** | **FTS5 is compiled in** (the `sqlite3.wasm` strings include the FTS5 error messages) **[V: package contents]**. OPFS persistence works **only in a Worker** **[V: sqlite.org persistence doc]**. The `opfs` VFS needs COOP/COEP (SharedArrayBuffer). **`opfs-sahpool` does not need COOP/COEP**, is the fastest OPFS option, does **not support multiple simultaneous connections** (so multi-tab use needs one owner), and its files are not human-readable in OPFS **[V: same doc]**. The Worker1/Promiser1 wrapper APIs have been deprecated since 2026-04-15 **[V: README]**; use the `oo1` API inside your own worker. | **Recommended**: `bm25`/`snippet`/`highlight`, external-content tables and triggers **[V: sqlite.org/fts5]**; scales to GBs. |
| MiniSearch 7.2.0 / FlexSearch 0.8.212 on IndexedDB **[V: npm versions]** | Pure JS with no worker constraints, usable from the service worker. MiniSearch keeps the whole index in memory and serializes it as JSON. Fine for notes; heavy for full PDF text across hundreds of documents **[U: estimate]**. | Fallback, or notes-only search. |

**Worker placement (important):**
- An MV3 service worker cannot host the DB, because the OPFS sync handle needs a **dedicated** worker. I found no statement in Chrome's docs that service workers can spawn workers, so treat it as not possible **[U]**.
- An **offscreen document** with reason `WORKERS` can spawn workers. Only **one offscreen document per extension** can exist, and it can only use `chrome.runtime` **[V: offscreen reference, 2026-10-29]**.
- That singleton is the natural **single DB owner**. Viewer tabs and the service worker talk to it via `chrome.runtime` messages, which also solves the `opfs-sahpool` single-connection limit.
- Offscreen docs have no documented lifetime limit except `AUDIO_PLAYBACK` **[V]**. Whether one survives every service-worker termination is **[U]**: test it, and make the DB client re-create it on demand (`chrome.offscreen.hasDocument()` exists since Chrome 150 **[V]**).

```js
// background.js: ensure the DB host exists
async function ensureDb() {
  if (await chrome.offscreen.hasDocument?.()) return;
  await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["WORKERS"], justification: "SQLite FTS index" });
}
// offscreen.js: new Worker("db-worker.js", { type: "module" }); relay chrome.runtime messages <-> worker.postMessage
// db-worker.js
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
const sqlite3 = await sqlite3InitModule();
const pool = await sqlite3.installOpfsSAHPoolVfs({ name: "lib" });
const db = new pool.OpfsSAHPoolDb("/library.sqlite3");
db.exec(`
  PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=ON;
  CREATE TABLE IF NOT EXISTS doc(id INTEGER PRIMARY KEY, sha256 TEXT UNIQUE, fp TEXT, title TEXT, src_url TEXT, pages INT, added INT);
  CREATE TABLE IF NOT EXISTS page(rowid INTEGER PRIMARY KEY, doc_id INT REFERENCES doc(id), n INT, text TEXT, UNIQUE(doc_id,n));
  CREATE TABLE IF NOT EXISTS note(rowid INTEGER PRIMARY KEY, uid TEXT UNIQUE, doc_id INT, page INT, rects TEXT,
    quote TEXT, body TEXT, author TEXT, parent_uid TEXT, created INT, updated INT, deleted INT);
  CREATE VIRTUAL TABLE IF NOT EXISTS page_fts USING fts5(text, content='page', content_rowid='rowid', tokenize="unicode61 remove_diacritics 2");
  CREATE VIRTUAL TABLE IF NOT EXISTS note_fts USING fts5(quote, body, content='note', content_rowid='rowid', tokenize="unicode61 remove_diacritics 2");
  CREATE TRIGGER IF NOT EXISTS page_ai AFTER INSERT ON page BEGIN INSERT INTO page_fts(rowid,text) VALUES(new.rowid,new.text); END;
  CREATE TRIGGER IF NOT EXISTS page_ad AFTER DELETE ON page BEGIN INSERT INTO page_fts(page_fts,rowid,text) VALUES('delete',old.rowid,old.text); END;
  -- same AI/AD/AU trio for note_fts (see sqlite.org/fts5 §4.4.3)
`);
// query: SELECT doc_id, n, snippet(page_fts,0,'<b>','</b>','…',24) FROM page_fts JOIN page ON page.rowid=page_fts.rowid
//        WHERE page_fts MATCH ? ORDER BY bm25(page_fts) LIMIT 50;
```

The CSP needs `'wasm-unsafe-eval'`, as in pdf.js **[V]**. Page text comes from pdf.js `page.getTextContent()` at import time **[V: API exists]**. Scanned PDFs have no text layer; OCR is out of scope.

**OPFS file store:**
```js
async function savePdf(bytes /* ArrayBuffer */) {
  const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(b => b.toString(16).padStart(2,"0")).join("");
  const root = await navigator.storage.getDirectory();
  const dir = await (await root.getDirectoryHandle("pdf", { create: true })).getDirectoryHandle(sha.slice(0,2), { create: true });
  const fh = await dir.getFileHandle(`${sha}.pdf`, { create: true });
  if ((await fh.getFile()).size !== bytes.byteLength) { const w = await fh.createWritable(); await w.write(bytes); await w.close(); }
  return sha; // dedup key
}
```
`crypto.subtle.digest` needs the whole buffer in memory. For files of several hundred MB, use a streaming hasher such as hash-wasm **[U]**.

**FSA backup skeleton:**
```js
// library.html (a tab), on a button click:
const dir = await showDirectoryPicker({ id: "backup", mode: "readwrite" });
await idbSet("backupDir", dir);
// later, after each save:
async function backup(json) {
  const dir = await idbGet("backupDir"); if (!dir) return "none";
  if ((await dir.queryPermission({ mode: "readwrite" })) !== "granted") return "needs-click"; // show "Reconnect backup" banner
  const f = await dir.getFileHandle("library.json", { create: true });
  const w = await f.createWritable(); await w.write(JSON.stringify(json)); await w.close();
  return "ok";
}
// the banner button calls dir.requestPermission({ mode: "readwrite" }) (needs a user gesture)
```

---

## 5. Claude without a desktop app

Model facts come from the claude-api skill (cached 2026-10-06) and the platform docs.

| Model | ID | Price in/out per MTok |
|---|---|---|
| Opus 5.5 (default) | `claude-opus-5-5` | $4 / $20; cache read $0.20; effort defaults to `medium`; thinking cannot be disabled |
| Sonnet 5.5 | `claude-sonnet-5-5` | $2 / $10 |
| Haiku 5.5 | `claude-haiku-5-5` | $0.10 / $0.50 (≤100K-token prompts) |

The model should be a user setting with Opus 5.5 as the default. Choosing a cheaper model is the user's decision.

### 5a. @Claude in comment threads (direct API call)
- **SDK [V: npm]:** `@anthropic-ai/sdk` **1.3.0**. It sends `anthropic-version: 2026-10-21` **[V: package source]**. Under that version `temperature`, `top_p` and `top_k` return 400 (skill: api-version migration), so don't send them.
- **CORS [V: SDK source `client.js`]:** `new Anthropic({ apiKey, dangerouslyAllowBrowser: true })` adds `anthropic-dangerous-direct-browser-access: true`. Without the flag the SDK throws in any `window` context. Also declare `host_permissions: ["https://api.anthropic.com/*"]`; extension pages with host permissions are not subject to CORS **[U for this host]**.
- **Where to call [V: SW lifecycle doc]:** from the **viewer tab**. The service worker is terminated if a `fetch()` response takes more than 30 s to arrive, or after 30 s idle, and long generations stream for minutes.
- **Key storage:**
  - `chrome.storage.local` is plain on disk and readable by content scripts by default **[V]**. Our extension *does* run content scripts on every page, for embed detection.
  - Store the key in **extension-origin IndexedDB** instead: content scripts use the page's origin and can't reach it **[U: standard origin model]**. Or call `chrome.storage.local.setAccessLevel({accessLevel:"TRUSTED_CONTEXTS"})` **[V: doc says setAccessLevel applies]**.
  - Recommend a Console spend limit and a dedicated workspace for this key.
- **Document as context, cheapest first:**
  1. **Extracted text as a custom-content document**: one text block per page, `citations:{enabled:true}`. Citations come back as `content_block_location` with `start_block_index` (= page − 1) and exclusive end, which become clickable page links **[V: Citations doc]**. `cited_text` doesn't count toward output tokens **[V]**. Citations are **incompatible with `output_config.format`** (400) **[V]**.
  2. **Real PDF (figures matter)**: `document` with `source:{type:"file", file_id}` via the **Files API, GA, no beta header**: `client.files.upload(...)`, 500 MB per file, persists until deleted or `expires_in_seconds` runs out (1 h – 90 days), **not ZDR-eligible**, content billed as input tokens on every use **[V: Files doc]**. A PDF costs ~1,500–3,000 text tokens per page *plus* page-image tokens. Limits are 600 pages per request (100 under a <1M-token context window) and a 128 MB request **[V: PDF doc]**. Store `file_id` in the doc row; never accept file IDs from elsewhere **[V]**.
- **Prompt caching [V: skill prompt-caching.md + Citations doc]:**
  - Caching is a prefix match, rendered in the order `tools` → `system` → `messages`.
  - Keep a **frozen system prompt**, then `messages[0]` = [document block with `cache_control`] + the thread question. Append later turns. Add top-level `cache_control:{type:"ephemeral"}` for the growing tail.
  - Minimum cacheable prefix on Opus 5.5 is 512 tokens. Writes cost 1.25× (5 min) or 2× (1 h); reads cost 0.05× on Opus 5.5.
  - A 1 h marker may precede 5 min entries, not the reverse.
  - When the user opens a thread composer, you can pre-warm with a non-streaming `max_tokens: 0` request carrying the same prefix.
  - Example: a 30-page paper at ~20k tokens costs ≈ $0.10 to write to cache, ≈ $0.004 per later read, ≈ $0.01 per 500-token reply **[U: arithmetic from list prices]**.
- **Refusal handling [V: skill + SDK types `BetaFallbacksParam = Array<…> | 'default'`]:** opt in to server-side fallbacks with `betas:["server-side-fallback-2026-07-01"], fallbacks:"default"`. I enabled this in the skeleton because the skill makes it the default for Opus 5.5 code; drop it if unwanted. Always check `stop_reason === "refusal"`.

```ts
// viewer tab (extension page)
import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic({ apiKey: await loadKeyFromIDB(), dangerouslyAllowBrowser: true });
const SYSTEM = "You are a study assistant inside a PDF reader. Answer the student's comment thread using the attached document. Cite pages."; // frozen

export async function askClaude(doc: { title: string; pages: string[] }, history: Anthropic.Beta.BetaMessageParam[],
                                question: string, onText: (t: string) => void, signal: AbortSignal) {
  const docBlock: Anthropic.Beta.BetaRequestDocumentBlock = {
    type: "document", title: doc.title, citations: { enabled: true },
    source: { type: "content", content: doc.pages.map((t, i) => ({ type: "text", text: `[p.${i + 1}]\n${t}` })) },
    cache_control: { type: "ephemeral", ttl: "1h" },
  };
  const messages: Anthropic.Beta.BetaMessageParam[] = history.length
    ? [...history, { role: "user", content: question }]
    : [{ role: "user", content: [docBlock, { type: "text", text: question }] }];
  const stream = client.beta.messages.stream({
    model: "claude-opus-5-5", max_tokens: 64000,
    betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
    output_config: { effort: "medium" },
    cache_control: { type: "ephemeral" },           // auto-cache the growing thread tail
    system: SYSTEM, messages,
  }, { signal });
  stream.on("text", onText);
  for await (const ev of stream) {
    if (ev.type === "content_block_delta" && ev.delta.type === "citations_delta") {/* map start_block_index -> page link */}
  }
  const msg = await stream.finalMessage();
  if (msg.stop_reason === "refusal") throw new Error("Claude declined");
  return msg; // persist msg.content (not just text) as the assistant turn
}
```
**[U]** Exact TS type names such as `BetaRequestDocumentBlock` and whether `cache_control` is accepted top-level on `beta.messages.stream`: write the code, then let `tsc` correct the names.

### 5b. Letting Claude Desktop / claude.ai see the library

Background:
- **claude.ai cannot reach anything on localhost.** Custom connectors are called "from Anthropic's cloud infrastructure, rather than from your local device", and the server must be reachable from Anthropic's IP ranges (`160.79.104.0/21`). Local MCP servers in Claude Desktop "aren't available in Cowork or claude.ai" **[V: support article 11175166; claude.com connector auth doc]**.
- **MCP tunnels** exist, but only as a research preview for **Enterprise** organizations **[V: claude.com docs]**. Not an option for a student.

Ranked by simplicity for one student:

1. **Backup folder + Claude Desktop "Filesystem" extension (Claude Desktop only).**
   - No code beyond §3.3(a). Point the Filesystem extension's allowed directory at the backup folder and Claude reads `notes/*.md` and the PDFs.
   - Facts: Filesystem is an Anthropic desktop extension based on `@modelcontextprotocol/server-filesystem`, configured with allowed directories **[U: third-party pages + GitHub issue; not official docs]**.
   - It does not work on claude.ai web or mobile.
2. **The same backup folder placed inside Google Drive for desktop + Claude's Google Drive connector (web, Desktop, mobile).**
   - The connector is "built and run by Google" and reads **Google Docs/Sheets/Slides, PDF, Word/Excel/PowerPoint, OpenDocument, PNG/JPEG** **[V: claude.com/docs/connectors/google/drive]**.
   - **Markdown and .txt are not in the documented list [U]**, so also write each document's notes as **.docx** (e.g. the `docx` npm lib) or rely on (3).
   - Docs exports cap at ~10 MB **[V]**.
   - There is no OAuth in our code. The dependency is that Drive for desktop syncs the folder.
3. **Direct Drive API sync (`chrome.identity`, `drive.file`) creating native Google Docs.**
   - Most reliable for the Drive connector, and needs no Drive for desktop. Cost is the OAuth setup and Testing-mode caveats in §3.3(b).
   - Convert by uploading `text/html` with metadata `mimeType: "application/vnd.google-apps.document"` **[U: standard Drive import; markdown import unverified]**.
4. **Remote MCP on Cloudflare Workers (+ D1 for notes/FTS, R2 for PDFs) as a custom connector.**
   - Richest option: real `search_library` / `get_annotations` / `add_note` tools, working in claude.ai, Desktop, mobile and Claude Code.
   - Template: `npm create cloudflare@latest -- remote-mcp-server-authless --template=cloudflare/ai/demos/remote-mcp-authless`, deploy with `npx wrangler@latest deploy`. It serves Streamable HTTP at `/mcp`. `createMcpHandler` is current; `McpAgent` is deprecated. Add OAuth with Workers OAuth Provider (`OAuthAuthorizationServer` + `OAuthResourceServer`) **[V: Cloudflare guide]**.
   - Claude supports `oauth_dcr`, `oauth_cimd` and `none` (authless) by default. The callback is `https://claude.ai/api/mcp/auth_callback` **[V: claude.com connector auth doc]**.
   - Authless would expose personal notes to anyone with the URL, so use OAuth.
   - Free plan: one custom connector **[U: third-party guide]**.
   - Needs: a Cloudflare account, an upload path from the extension, and ongoing maintenance.
   - MCP TS SDK if you write it yourself: `@modelcontextprotocol/server` **2.4.0** (v2 is "the stable release line", targeting the 2026-07-28 spec; v1 is `@modelcontextprotocol/sdk` 1.32.2) **[V: npm README]**.

**Suggestion:** ship (1) and (2) for free on top of the v1 backup folder. Do (3) or (4) only if the student wants Claude on the web to *write* notes back.

---

## 6. Extension delivery

| | Load unpacked | Chrome Web Store, **unlisted** |
|---|---|---|
| Install | Developer mode → Load unpacked → pick the build folder | Link-only listing; anyone with the link can install |
| Updates | Manual: rebuild, then click reload. Data survives reload **[U]** | Automatic |
| Cost / review | Free, instant | **One-time registration fee** **[V: register page; amount not stated there]**, $5 per long-standing reports **[U]**. Review "within a few days, but can take up to a few weeks"; new developers, new extensions and broad host permissions such as `<all_urls>` lengthen it **[V: review-process doc, 2021-12]**. The page doesn't say whether unlisted items are reviewed differently **[U]**. |
| Remote code | n/a | MV3 forbids remotely hosted code, and **WASM counts as code**: bundle `sqlite3.wasm` and the pdf.js wasm in the package, never fetch them **[V: remote-hosted-code doc]**. Obfuscation is banned; minification is allowed **[V]**. The pdf.js viewer ships on the Web Store with `wasm-unsafe-eval` CSP **[V: manifest]**. |
| Stable ID | **Required:** add `"key"`. Upload a zip once (unpublished) to the Dashboard → Package → "View public key", strip the line breaks, paste it as `"key"` **[V: Chrome OAuth how-to]**. | The ID is the store item ID. Keep the same `"key"` so dev and store builds share the ID, the OAuth client and the data origin. |

**Hotkeys:**
- Chrome rejects **Ctrl+Alt** combos in `chrome.commands`: "Key combinations that involve Ctrl+Alt are not permitted in order to avoid conflicts with the AltGr key." Shortcuts must include Ctrl or Alt, at most 4 suggested keys are allowed, and global commands are limited to Ctrl+Shift+[0-9] **[V: commands reference, 2026-10-29]**.
- So: handle **Ctrl+Alt+M with an in-page `keydown`** in our viewer, and offer a `chrome.commands` entry with a non-Ctrl+Alt suggestion (e.g. Alt+Shift+N) **[U: conflict-free]** that the user can rebind at `chrome://extensions/shortcuts`.
- **AltGr warning [V: Raymond Chen "AltGr = Ctrl+Alt"; Steinberg/MindManager reports]:** on German and other AltGr layouts, Ctrl+Alt+M **is** AltGr+M, which types **µ**. Skip the shortcut when focus is in an editable element, check `e.code === "KeyM"`, and make it rebindable.
```js
addEventListener("keydown", e => {
  const t = e.target; if (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
  if (e.ctrlKey && e.altKey && !e.shiftKey && e.code === "KeyM" && !e.getModifierState("AltGraph")) { e.preventDefault(); openNoteComposer(); }
}, true); // getModifierState("AltGraph") behaviour on Windows Chrome: [U], test it
```

**Manifest sketch:**
```json
{
  "manifest_version": 3, "name": "…", "version": "0.1.0", "minimum_chrome_version": "128",
  "key": "<public key from dashboard>",
  "permissions": ["declarativeNetRequestWithHostAccess", "webNavigation", "webRequest", "storage",
                  "unlimitedStorage", "offscreen", "tabs"],
  "optional_permissions": ["identity"],
  "host_permissions": ["<all_urls>"],
  "background": { "service_worker": "background.js", "type": "module" },
  "content_scripts": [{ "matches": ["http://*/*", "https://*/*", "file://*/*"], "run_at": "document_start",
                        "all_frames": true, "js": ["embed-detect.js"], "css": ["embed-detect.css"] }],
  "content_security_policy": { "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" },
  "web_accessible_resources": [{ "resources": ["viewer.html"], "matches": ["<all_urls>"] }],
  "commands": { "add-note": { "suggested_key": { "default": "Alt+Shift+N" }, "description": "Add note" } }
}
```

**Tooling versions [V: npm 2026-10-31]:**

| Package | Version |
|---|---|
| pdfjs-dist | 6.4.299 (Node ≥22.13) |
| @sqlite.org/sqlite-wasm | 3.54.1-build1 |
| @anthropic-ai/sdk | 1.3.0 |
| dexie | 4.4.7 |
| idb | 8.0.4 |
| minisearch | 7.2.0 |
| flexsearch | 0.8.212 |
| vite | 8.3.5 |
| wxt (MV3 framework) | 0.21.5 |
| @crxjs/vite-plugin | 3.0.0 |
| react | 19.3.1 |
| typescript | 7.0.2 |

**[U]** WXT vs CRXJS: pick one. WXT handles the manifest, multiple entrypoints and offscreen pages well.

---

## 7. Risks

1. **Uninstall wipes the library.** `chrome.storage.local` is verified; IndexedDB/OPFS are near-certain. Moving an unpacked folder without `"key"` "loses" it too. Mitigation: the backup folder plus a prominent "Export library" button, and onboarding text.
2. **Backups silently pause** if extension origins don't get persistent FSA grants. Mitigation: a visible "Backup paused — Reconnect" banner, and "last backup" time in the UI.
3. **The end-to-end double-click flow is untested on Windows.** Verify early: Chrome as default, the file-access toggle (which reloads the extension and closes its tabs), paths with spaces or Unicode, OneDrive placeholders.
4. **Re-fetch failures:** POST-loaded PDFs (unsupported), signed or expiring URLs, some cookie-gated hosts. These fall back to Chrome's viewer; offer "Import this PDF" via a file picker.
5. **DNR `responseHeaders` needs Chrome ≥128**, and older builds silently redirect everything. Feature-detect like pdf.js, or set `minimum_chrome_version: 128`.
6. **Single DB owner:** `opfs-sahpool` allows one connection. If the offscreen document dies or two owners race, expect errors or lock contention. Route everything through one owner and re-create the offscreen doc on demand.
7. **Service worker limits:** 30 s idle, 30 s for a fetch response, 5 min per event. Never stream Claude or upload big files from the service worker.
8. **API key in the browser:** it is the user's own key, but stored unencrypted on disk. Keep it out of `chrome.storage.local` (content scripts can read that by default), and use spend limits.
9. **Cost surprise:** sending whole PDFs as `document` blocks costs ~1.5–3k tokens per page plus images, so default to extracted text. The cache TTL is 5 min / 1 h. Every model switch invalidates the cache.
10. **AltGr / µ conflict** with Ctrl+Alt+M on AltGr layouts. Mitigate with the editable-field guard and a rebindable shortcut.
11. **Web Store review** may take weeks with `<all_urls>`. Keep Load unpacked as the dev path, and never fetch wasm or JS remotely.
12. **Google OAuth Testing mode:** refresh tokens last 7 days, so weekly re-consent may be needed if you do Drive API sync (v2).
13. **Drive connector formats:** `.md` is not documented as readable, so mirror notes as `.docx` or Google Docs for claude.ai.

---

## Sources (primary unless noted)

- **pdf.js:** source at github.com/mozilla/pdf.js @743102c, `extensions/chromium/*` and `web/chromecom.js`; pdfjs-dist 6.4.299 package (`build/pdf.mjs`, `types/src/display/api.d.ts`).
- **Chrome extension docs:**
  - commands: developer.chrome.com/docs/extensions/reference/api/commands (2026-10-29)
  - storage: developer.chrome.com/docs/extensions/reference/api/storage (2026-10-29); …/develop/concepts/storage-and-cookies
  - offscreen: …/reference/api/offscreen (2026-10-29)
  - SW lifecycle: …/develop/concepts/service-workers/lifecycle
  - identity: …/reference/api/identity (2026-10-29); OAuth how-to: …/how-to/integrate/oauth
  - remote hosted code: …/develop/migrate/remote-hosted-code
  - Web Store: developer.chrome.com/docs/webstore/register, …/review-process
- **File System Access:** developer.chrome.com/blog/persistent-permissions-for-the-file-system-access-api; MDN `FileSystemFileHandle.createSyncAccessHandle` and `createWritable`; crbug 40240444; issuetracker 570122817; WICG file-system-access issue #289.
- **Web storage:** web.dev/articles/storage-for-the-web.
- **SQLite:** sqlite.org/wasm/doc/trunk/persistence.md; sqlite.org/fts5.html; @sqlite.org/sqlite-wasm 3.54.1-build1 package.
- **Windows defaults:** learn.microsoft.com/windows/apps/develop/windows-integration/default-apps-platform (2026-09-26); Chrome-as-PDF-default how-tos (pureinfotech, Illinois State IT, windowsreport — third-party).
- **Claude platform:**
  - claude-api skill (models, caching, fallbacks)
  - platform.claude.com/docs/en/build-with-claude/{files,pdf-support,citations}.md
  - @anthropic-ai/sdk 1.3.0 package source (`client.js`, beta message types)
- **Claude connectors:**
  - support.claude.com/en/articles/11175166 (custom connectors originate from Anthropic cloud)
  - claude.com/docs/connectors/building/authentication
  - claude.com/docs/connectors/google/drive.md
  - claude.com docs on MCP tunnels (Enterprise research preview)
- **Cloudflare:** developers.cloudflare.com/agents/guides/remote-mcp-server/.
- **Google:** developers.google.com/workspace/drive/api/guides/api-specific-auth; developers.google.com/identity/protocols/oauth2.
- **AltGr:** devblogs.microsoft.com/oldnewthing/20120423-00 (Raymond Chen); Steinberg and MindManager forum reports (third-party).
- **MCP SDK:** npm `@modelcontextprotocol/server` 2.4.0 README; ts.sdk.modelcontextprotocol.io/v2.

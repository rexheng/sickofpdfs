# Spec review 1: sickofpdfs Design Spec v1

Reviewer: independent design critic (did not write the spec). Date: 2026-10-31.
Spec reviewed: `/home/user/sickofpdfs/docs/superpowers/specs/2026-10-31-sickofpdfs-design.md` (cited as `spec:NNN`).
Requirements log: `scratchpad/requirements.md` (cited as `req N`).
Research: `/home/user/sickofpdfs/docs/research/0N-*.md` (cited as `01:NNN` … `05:NNN`).
Statements marked **[reviewer knowledge]** come from my own knowledge of Chrome, PDF and library behaviour, not from the research files. A build agent should verify them in Phase 0.

Totals: **3 critical, 18 major, 27 minor.**

---

## Requirements coverage

| # | Requirement (user's order) | Status | Notes |
|---|---|---|---|
| 1 | Desktop app on Windows, default PDF reader, opens PDFs clicked online | Superseded by 11. **Half covered.** | "Any PDF link" is false: POST-loaded, embedded (`<object>`/`<iframe>`, as Moodle uses) and expiring-link PDFs are not handled (M8). |
| 2 | Seamless commenting, Ctrl+Alt+M | Covered | At risk from C3 (notes lost on unsaved PDFs) and M10 (shortcut contexts). |
| 3 | Integrated with Claude ("Claude Docs for any PDF") | Covered | @Claude plus a remote MCP connector. |
| 4 | Save PDFs + history → knowledge base, easy retrieval | Covered | Some library pieces ("suggested readings", "Courses") are undefined (m8). |
| 5 | Only learning PDFs; **never analyse receipts** | **Half covered** | Every PDF, receipts included, is text-mined in memory, and scans are OCR'd (spec:210). The spec reads "never analyse" as "never store". Confirm with the user (m17). The privacy rule has holes (C2). |
| 6 | Looks like Drive; the bar is Foxit / Google's PDF viewer | Look: covered (softened by 14). **Bar: half covered** | Print, forms, passwords, links, rotate, zoom keys and large-file behaviour are missing (M9). |
| 7 | Reuse existing repos; no hand-made assets | Covered | The logo ("our mark sits in the logo slot", spec:350) is a hand-made asset with no stated source (m21). |
| 8 | Orchestrator only, subagent coders, harsh critics, screenshots, gauntlet | Covered | Several gates cannot be automated (M16). |
| 9 | Repo github.com/rexheng/sickofpdfs | Implicit (setup, spec:448) | Not in the decisions table. Public or private is unstated. The same repo deploys production (M2). |
| 10 | Persist across sessions; identity = canonical URL + content hash; robust anchoring; orphans shown; offline | Covered in outline, **underspecified** | See C1 and M3. |
| 11 | Pivot to Chrome extension only (http(s) + file://) | Covered | |
| 12 | Content-based identity (hash + /ID); location = "last seen at"; library keeps its own copy | Covered | The spec uses /ID to group *versions*, not to identify a document, and that use is risky (C1). |
| 13 | Hosted on the user's own Cloudflare (sync, backup, web library, remote MCP) | Covered | Backup design is weak (M2). Web library auth is undefined (M13). |
| 14 | Drive = look and feel, not pixel-perfect; core = commenting | Covered | |
| 15 | Generalise beyond arXiv; scanned PDFs via local OCR; build on PDFium + Chromium BSD viewer code | **Half covered** | OCR has no decisions-table row and no build phase (M6, M14). Chromium-viewer reuse is vague ("where they fit"). The EmbedPDF build of PDFium differs from Chrome's (m12). |
| 16 | Highlight, underline, **bold**, strikethrough, comment; Docs-style toolbar; one shortcut each; no tool modes | **Half covered** | Bold is not defined in a buildable way (M4). |
| D | Claude "BOTH": local MCP (Desktop/Code) + @Claude | Re-mapped | A remote MCP works in Desktop and Code but only online. Acceptable, but not stated as a re-mapping. |
| D | Foxit: no global hotkey in v1 | Covered (spec:41) | |

The spec says "Every request so far is mapped to one decision below. Anything not in this table is out of scope for v1" (spec:24). Scanned PDFs and OCR (req 15), "generalise beyond arXiv" (req 15) and the Docs-style selection toolbar (req 16) have no row. Read literally, the spec puts its own walkthrough 3 (spec:49) out of scope.

---

## Critical

### C1. Document identity and "work" grouping are undefined and can silently attach notes to the wrong document
- **Section:** Library and knowledge base → Identity (spec:176–183); walkthroughs 8–9 (spec:54–55); Export and import (spec:168); Sync rules (spec:259).
- **Problem:**
  1. **Step 2 is unclear.** "Same link: the canonical URL" (spec:179) does not say whether new bytes at a known URL mean the *same document* or a *new version in the same work*. Walkthrough 9 implies a new version. Step 2's wording implies the same document.
  2. **Step 3 is undefined.** "near-identical text on the first pages" (spec:180) gives no metric, threshold or page count.
  3. **Step 3 will merge different documents.**
     - Lecture decks in one course share near-identical title slides ("EC1A1 – Lecture 3 – Dr X").
     - Book chapters often print the *book's* DOI on page 1.
     - Page 1 of many papers cites another paper's arXiv id or DOI.
     - /ID[0] is set by the producer. It survives "Save As" from a template, so a problem set made by editing last week's PDF inherits last week's /ID[0] **[reviewer knowledge: PDF 32000 §14.4]**.
     
     Once merged, "notes re-anchor onto the newest version": the old notes move to an unrelated document and land in "Couldn't place", or worse, fuzzy-match onto wrong text.
  4. **"Newest" is undefined** for /ID, DOI or text-similarity groups. A re-downloaded old copy could become the "newest". What the viewer shows when the user opens the older version is also unspecified.
  5. **Criterion 3 will mostly run through the fuzzy path.** JSTOR, ScienceDirect and many LMSs stamp a per-download cover page or footer, so a "re-downloaded copy" usually has a new hash **[reviewer knowledge]**. Criterion 3 (spec:15) therefore depends on the undefined step 3.
  6. **Ids collide with content identity.** The sync rules say "Every record has a random id" (spec:259), but documents are content-addressed in research (05:202 "Docs: `sha256`"). If two devices add the same PDF with random ids, they create two documents.
  7. **"Work" grouping is not a synced record and has no schema.** The research schema has no work table (05:661–686), and each device would group differently depending on which versions it has seen.
  8. **Export round-trips duplicate notes.** "Download with notes" writes a copy that likely keeps /ID[0] (EmbedPDF full rewrite, 01:60). Re-opening that copy groups it as a "new version" *and* imports its embedded annotations (spec:168), so every note appears twice.
- **Evidence:** spec:180 "the PDF's permanent ID (/ID first half), arXiv id, DOI, or near-identical text on the first pages. Versions group into one 'work' and notes re-anchor onto the newest version." Requirements 10 and 12 make identity the core promise. Research treats /ID as a *secondary key* for the same document, not a version-merge signal (03:100, 04:76).
- **Fix:**
  - Define identity as `sha256` (the document) plus an explicit, synced `work` record.
  - Auto-group only on an arXiv id read from the *URL or file name*, or on a DOI from XMP/Info metadata. Everything else (/ID, text similarity, same URL) produces a "Looks like a new version of X — link notes?" prompt.
  - Make re-anchoring a *copy* onto the new version, so the old version keeps its notes.
  - Dedupe imported annotations by `/NM` against our own ids.

### C2. The privacy rule is not true as written
- **Section:** Learning filter and privacy (spec:235); Viewer → Scanned PDFs (spec:127); history (spec:185); Claude integration (spec:275); Tech stack (spec:109–116).
- **Problem:** The rule says "Until a PDF is classified as learning it leaves no trace … Nothing about any PDF is sent anywhere unless it is saved to your library." At least seven paths contradict it or leave it undefined.
  1. **@Claude and the toolbar's "Ask Claude" (spec:135) are not restricted to saved PDFs.** On an unsaved or "not sure" PDF (a bank statement, a payslip), the whole document text goes to Anthropic (spec:275).
  2. **OCR output "is saved so it runs once per document"** (spec:127), but unsaved text "is dropped when the tab closes" (spec:235).
  3. **"Optional online lookups (arXiv, Crossref)"** (spec:185) have no stated timing. Run during classification, they leak reading activity for unsaved PDFs.
  4. **Bundled libraries fetch from CDNs by default.** EmbedPDF's wasm and fallback fonts default to jsDelivr (01:72, 01:98). tesseract.js fetches its worker, core and `traineddata` from CDNs and uses blob workers. onnxruntime-web (used by transformers.js and PaddleOCR) fetches its wasm from jsDelivr **[reviewer knowledge]**. Only MiniLM and the UI fonts are said to be bundled (spec:115, 350). Every unsaved PDF with a non-embedded font, and every OCR run, would make a network request. That breaks the privacy rule and Chrome's no-remote-code rule (03:318).
  5. **"Never for this file" and "never save it again"** (spec:240–241) store a hash of a non-learning PDF. That is a trace (research admits this exception, 04:356). The spec also does not say whether the list syncs to the cloud.
  6. **Chrome's own history keeps a trace.** It records `chrome-extension://…/viewer.html?DNR:<original URL or file path>` and, with Chrome Sync on, sends it to Google **[reviewer knowledge]**.
  7. **"The test set grows with every reported mistake"** (spec:422) means keeping copies of private PDFs that were wrongly saved.
- **Evidence:** spec:235 versus spec:127, 135, 185, 275. Research B.6 (04:356) states the rule but allows only "the opt-in, redacted LLM excerpt", which the spec dropped.
- **Fix:**
  - Replace the rule with an explicit table: each egress path (Anthropic, Cloudflare, arXiv/Crossref, PDF host re-fetch) and the condition that allows it.
  - Block @Claude, lookups and OCR caching on unsaved PDFs. @Claude on an unsaved PDF should need an explicit "Send this document to Claude?" confirmation.
  - Pin every wasm, font, model and OCR asset to `chrome.runtime.getURL`.
  - Add an automated gate: across the 44-PDF run, any network request other than the PDF fetch itself fails the build.

### C3. Notes on unsaved or "not sure" PDFs exist only in memory, so a crash, reload or tab close loses them
- **Section:** Learning filter → When the filter is wrong (spec:239–243); Ctrl+Alt+M flow (spec:140); success criterion 2 (spec:14).
- **Problem:** "Notes on an unsaved PDF are kept in memory, and closing the tab asks whether to save them" (spec:242). This contradicts "The draft saves every 300 ms, so a crash loses nothing" (spec:140). It is also not implementable as described:
  - `beforeunload` can only show Chrome's generic "Leave site?" dialog. It cannot offer Save/Discard, and it does not run on a renderer crash, a browser crash or an OS restart **[reviewer knowledge]**.
  - Reloading or updating the extension closes all of its tabs (03:56). Every Load-unpacked update, and the onboarding file-access toggle, wipes in-memory notes.
  
  This affects many readings, not a few. Research names a short, LaTeX-free seminar handout as the *most likely* false skip (04:412). Those are exactly the readings a student annotates.
- **Evidence:** spec:242; spec:140; 03:56; 04:412; 04:361–363 ("annotating is strong intent").
- **Fix:**
  - Treat the first note on a "not sure" PDF as a save, with an Undo chip.
  - For "not learning" PDFs, write notes to a local-only, never-synced, never-indexed "pending" table with a 7-day expiry, and disclose it in the privacy rule.
  - Add a gauntlet test: kill the renderer mid-note on an unsaved PDF and check the note survives.

---

## Major

### M1. Success criterion 8 ("loses nothing") contradicts the design
- **Section:** Success criteria (spec:20); Storage, sync and backup (spec:262–267); Hosting (spec:316, 323).
- **Problem:** The design itself loses data on reinstall in several cases:
  - PDFs marked "keep local", or with the global "keep PDF files local" toggle on (spec:263, 316).
  - PDFs whose upload is pending. Uploads only run "from an open library or viewer tab" (spec:262), so a PDF read for 10 seconds and closed never uploads until some tab is open again.
  - Outbox items blocked when D1's daily write cap is hit (05:116: "queries fail after the daily limit").
  - Anything changed during the up-to-a-day window before the stuck-sync alert (spec:267).
  
  Research recommends running the upload engine in the offscreen document, which is not limited to 30 seconds (05:230). The spec instead ties uploads to open tabs.
- **Evidence:** spec:20 "Resetting Chrome or reinstalling the extension loses nothing"; spec:267 "Anything not yet synced would be lost".
- **Fix:** Reword criterion 8 to "everything marked synced restores; the library shows a per-item unsynced count". Run sync and uploads in the offscreen document so they do not depend on open tabs.

### M2. The cloud copy is the only backup, and every push to main deploys and migrates it
- **Section:** Storage, sync and backup (spec:249, 265); Hosting → Deploys (spec:310); One-time setup (spec:430, 448).
- **Problem:**
  1. **Sync is not a backup.** A sync bug, a bad tombstone or a buggy trash-purge cron replicates the loss to the cloud. D1 Time Travel lasts 7 days, `wrangler d1 export` fails on databases with FTS tables, and R2 has no versioning (05:1001).
  2. **The second copy was dropped.** Research kept the FSA backup folder as a second copy (05:1001) and made it the v1 backup (03:130). The spec dropped it.
  3. **Build agents deploy to production.** "GitHub Actions on every push to main: database migrations, then `wrangler deploy`" (spec:310) means agents' merges run migrations against the user's live, only backup while the build is in progress. There is no staging environment. Research's reviewer gate is optional (05:464).
  4. **The setup claim is false.** "With no developer tools on your PC: GitHub Actions does the server deploy for you … The first deploy then runs by itself" (spec:430, 448) contradicts research:
     - Creating a new Worker needs an Admin-level token or a local `wrangler login` (05:492, 05:545).
     - Research has the user install Node and run wrangler locally (05:535).
     - The secrets list omits `ALLOWED_GITHUB_ID` and `SESSION_SECRET` (05:382) and the extension ID (05:366).
     - D1, KV and R2 must be created, and auto-provisioning writes ids back to `wrangler.jsonc` (05:385). In CI that write-back is lost.
- **Fix:**
  - Keep an independent backup: a scheduled "Export library" zip to a user-picked folder via FSA, or a nightly JSON snapshot of D1 into R2 with a 30-day retention.
  - Deploy production only from tagged releases, and give agents a separate staging Worker and databases.
  - Rewrite setup to match reality: a token with stated Admin scopes for the first deploy, every Worker secret listed, and resource creation handled by a scripted workflow step.

### M3. The sync protocol and data model are underspecified, and the spec and research disagree
- **Section:** Sync rules (spec:259–261); Hosting → Sync details (spec:312); What a note is made of (spec:131–133).
- **Problem:**
  1. **Ids.** "Every record has a random id" breaks content-addressed documents and locations (05:202–203).
  2. **Conflict detection.** "The newer change wins" uses an "updated time". Research's correctness comes from `base_rev` optimistic concurrency plus HLC clocks (05:205–212). With wall clocks, a laptop with a skewed clock silently wins.
  3. **Delete versus edit.** Unspecified. "Typed text is never thrown away" is false when a newer delete wins: research keeps the body only in the tombstone (05:211).
  4. **Which process runs sync** is not stated (the offscreen document in 05:230; open tabs per spec:262).
  5. **D1's daily write cap.** Since 2026-09-01, D1 *fails* writes after 100k rows per day (05:116). The spec says "Indexing just runs slower; no data is lost" (spec:323) but never requires the server-side metering and 429 that make that true (05:140). Without metering, a backfill also blocks note sync.
  6. **The schema is contested.** The spec models Mark / Thread / Comment, with threads on a mark, a page point, a page or the document. Research 05 has one `annotation` table whose `kind` CHECK allows only `highlight, underline, strike, note, ink, comment, reply` (05:712). It has **no bold**, no page-point or document-thread kind, and no work. A build agent copying the research schema would have the server reject bold marks.
  7. **Drafts.** Whether drafts sync (300 ms autosave) is unstated.
- **Fix:** Put one normative schema and protocol in the spec. Adopt research §3.2 (content-derived ids, `base_rev` + HLC, conflict-copy replies, tombstones keep the body, metering with 429 at about 85k rows), extended with `bold`, `area`, page-point and document threads, and `work`. State that drafts are local-only.

### M4. "Bold" is not buildable as specified
- **Section:** Marking text (spec:135); Export (spec:168); requirement 16.
- **Problem:**
  - **No PDF annotation type exists for bold.** EmbedPDF's annotation types (01:29) and the research schema (05:712) have none.
  - **"Thickening the letters' own pixels"** means morphological dilation on every rendered tile at every zoom and DPR. It also thickens underlines, rules and figure lines inside the box. It misbehaves on coloured or reversed text and on scans, and it costs time on the <50 ms mark budget.
  - **"Exports with its own appearance so Foxit and Acrobat show it too"** can only mean a non-standard annotation (for example a /Stamp or /FreeText carrying a raster or re-stroked appearance stream). Foxit and Acrobat will list it as a stamp, not as bold, and it may be unreadable at other zooms.
  - **Phase 0 does not test bold at all.**
- **Evidence:** spec:135 "bold is drawn by thickening the letters' own pixels, and it exports with its own appearance so Foxit and Acrobat show it too".
- **Fix:**
  - Specify bold's rendering: a second PDFium pass of the covered text objects with fill+stroke render mode, or a bounded dilation.
  - Specify its export subtype and appearance, and its `/Subj` "Bold" plus custom data.
  - Add bold to Phase 0, with a Foxit/Acrobat screenshot check.
  - If it fails, ask the user to accept a "strong" mark style (dark underline plus heavier highlight) in its place.

### M5. The DOM text layer built from PDFium glyph boxes is a from-scratch subsystem, and its risks are not budgeted
- **Section:** Viewer → Text layer (spec:125); Ctrl+Alt+M (spec:139); Speed budgets (spec:170).
- **Problem:**
  - **EmbedPDF has no DOM text layer.** Selection is glyph geometry from PDFium, and copy, keyboard selection and screen readers "go through the plugin … we have to build keyboard selection and accessibility ourselves" (01:109–110). Glyph-selection UX is untested (01:136).
  - **Building one is substantial work.** It needs span grouping, font sizing and scaleX fitting, rotated and vertical text, and reading order. Native selection follows DOM order, so two-column papers need correct ordering. Ligatures and PDFium's generated spaces and newlines break a 1:1 mapping back to "PDFium character ranges". The layer must also co-exist with EmbedPDF's own selection plugin.
  - **Phase 0 checks only that the layer "lines up"** (spec:408), not selection fidelity.
  - **The mark render path is unstated.** If marks render through PDFium annotations and tile re-render, the 50 ms mark budget is unlikely.
- **Fix:**
  - Make Phase 0 pass a selection-fidelity suite: two-column paper, rotated table, ligatures, inline maths, CJK and RTL samples, and copy-paste equality with Chrome's viewer.
  - State that marks draw as DOM/SVG overlays, and that PDFium annotations are written only on export.
  - Consider porting pdf.js's `text_layer.js` (Apache-2.0), fed with PDFium boxes, rather than inventing one.

### M6. OCR and scanned-PDF classification are infeasible or undefined as written
- **Section:** Scanned PDFs (spec:49, 127); Filter step 2 (spec:210); Risks (spec:426).
- **Problem:**
  1. **The time budget is impossible.** "Score from cheap signals in under 150 ms … text from the first and last 5 pages (for a scan, recognised by OCR in memory only)" (spec:210). OCR of 10 pages takes seconds per page with tesseract.js **[reviewer knowledge]**.
  2. **The researched scan path was dropped silently.** Research decides scans with URL score + DiT, gated at URL ≥ +2 and p ≥ 0.7, and OCRs only after the save (04:285–288, 04:331).
  3. **Asset bundling, CSP and blob workers** for tesseract.js, PaddleOCR and onnxruntime-web are unaddressed (see C2.4). Threaded ORT needs cross-origin isolation (`cross_origin_embedder_policy` / `_opener_policy` in the manifest) **[reviewer knowledge]**.
  4. **Languages** are unspecified (English only? French and German readings?).
  5. **Anchors on scans are undefined.** OCR words have no PDFium character indices, so the anchor model ("character position", "PDFium character ranges") does not apply. An OCR engine or version change silently shifts every anchor.
  6. **Worker placement** is unspecified. In a tab, OCR stops when the tab closes. A 600-page scanned textbook means tens of minutes of OCR.
  7. **No build phase** after Phase 0 schedules OCR (spec:398–406).
  8. **"Area notes always work"** (spec:426) refers to a feature that does not exist (M17).
- **Fix:**
  - Classify scans by URL + DiT as researched, and OCR only saved documents (visible pages first, in the offscreen document's worker).
  - Store an `ocr_engine@version` and an OCR character-index space in each anchor.
  - Bundle every OCR asset, choose the languages now, and give OCR a phase.

### M7. The single-owner local store has no workable transport for PDF bytes and page text
- **Section:** Architecture → Local store (spec:87); Storage (spec:253–254).
- **Problem:** "All tabs talk to it" and "the only owner … of saved PDF copies". The offscreen document "can only use `chrome.runtime`" (03:147). `chrome.runtime` messages are JSON-serialised, so ArrayBuffers and Blobs do not survive, and they are capped at about 64 MiB **[reviewer knowledge]**. A 300 MB textbook cannot reach the owner that way.
  
  Also unstated:
  - What happens when the offscreen document disappears (its lifetime is [U], 03:149).
  - How two tabs showing the same document stay consistent.
  - How SHA-256 is "computed while the file streams in". `crypto.subtle` needs the whole buffer (03:192), and file:// is read by XHR (03:51).
- **Fix:**
  - Use MessageChannel or BroadcastChannel with transferables between extension pages and the offscreen document, or let tabs write PDF bytes straight to OPFS (only SQLite needs one owner).
  - Specify re-creation on demand and a BroadcastChannel for cross-tab updates.
  - Use a streaming hasher (hash-wasm).

### M8. The takeover cannot cover "any PDF link", and the stated fallback is impossible
- **Section:** Success criterion 1 (spec:13); decisions table (spec:28–29); Risks (spec:421).
- **Problem:**
  - **Known gaps in coverage:**
    - POST-loaded PDFs are excluded (03:47).
    - Embedded PDFs need a separate content script (`<object>`/`<embed>`, sniffed types; 03:48–49). Moodle commonly embeds resources this way. The spec never mentions embeds.
    - Expiring, signed or one-time links fail on the viewer's second GET (03:52).
    - DNR response-header conditions need Chrome 128+ (03:45).
  - **The fallback cannot work.** "Fall back to Chrome's viewer with an 'Import this PDF' button" (spec:421) is impossible because extensions cannot inject UI into Chrome's built-in viewer **[reviewer knowledge]**.
  - **There is no escape hatch** ("Open in Chrome's viewer", like pdf.js's `pdfjs.action=download`, 03:37). Without one, form PDFs regress for *every* PDF, learning or not. Chrome's viewer fills and saves AcroForms; the spec never mentions forms. This hits the visa, tax and coursework cover-sheet forms a student must fill.
- **Fix:**
  - Rewrite criterion 1 with explicit exclusions.
  - Port the pdf.js embed/sniff content script.
  - Put the "Import this PDF" picker on *our* error page.
  - Add a permanent "Open in Chrome's viewer" (an allow-rule escape) and auto-route PDFs with form fields or XFA there.

### M9. Reader must-haves for "beat Foxit and Chrome's viewer" are missing
- **Section:** Viewer and commenting (spec:119–170); decisions table, "Beat Foxit and Google's viewer" (spec:37).
- **Problem:** Each of these is absent or only implied.
  - **Print.** Zero mentions. Ctrl+P on an extension page prints the virtualised DOM: blank pages and UI chrome. Drive's viewer has Print in the toolbar and the File menu (02:573, 02:594).
  - **Zoom keys and modes.** Ctrl+= / Ctrl+− / Ctrl+0 / Ctrl+wheel / pinch will zoom the extension page itself unless intercepted. Only "fit modes" from Chromium are mentioned (spec:123).
  - **Links inside PDFs.** Internal GoTo (TOC, citations, equation references) and external URIs or DOIs.
  - **Password-protected PDFs.** The prompt, classification after unlock, and whether the library copy stays encrypted and needs the password on every open.
  - **Forms** (see M8).
  - **Very large files.** EmbedPDF copies the whole file into a 2 GB wasm heap, "risky above about 1 GB" (01:116), with no range loading, so the first page waits for the full download. On top of that come a JS copy, an OPFS write and hashing. No size limit or UX is defined.
  - **Others:** rotate (Ctrl+[ / Ctrl+], 04:170), dark or inverted page mode, two-page and presentation modes for slides, plain "Download original" and Ctrl+S, copy-original-link, and any accessibility target (WCAG level, focus order, high contrast, card ARIA).
- **Fix:** Add a "Reader parity" table, using Chrome's PDF viewer features as the checklist. Give each item its shortcut, phase and E2E test, and set a file-size policy (for example, above 500 MB open read-only with a warning).

### M10. Shortcuts conflict with research guidance and have no contexts
- **Section:** Shortcuts (spec:148–166); success criterion 2 (spec:14).
- **Problem:**
  1. **Tab is hijacked.** "Move between annotations: Tab / Shift+Tab" is unconditional. Research limits it to "while an annotation is focused" (04:147, 04:123). Taking over Tab breaks keyboard focus navigation, which the Experience critic tests keyboard-only.
  2. **Ctrl+U is on research's never-bind list** (04:175). It can be intercepted, but without a selection Chrome opens view-source.
  3. **Ctrl+P, Ctrl+S, Ctrl+= / − / 0 and Ctrl+Z / Y are undefined** (see M9). Delete is "with Undo", but no undo key is given.
  4. **"No mouse is needed" (criterion 2) is false.** Creating a text selection from the keyboard needs caret browsing (F7, itself reserved, 04:175) or a custom keyboard-selection mode. Native Shift+arrows only extend an existing selection.
  5. **AltGr on the user's layout is untested.** The user is UK-based (LSE, sort codes), and the UK Windows layout is an AltGr layout. The research guard `!e.getModifierState("AltGraph")` is [U] on Windows Chrome (03:328–329). If Chrome reports AltGraph for Left Ctrl+Left Alt on that layout, Ctrl+Alt+M never fires.
  6. **Single-key shortcuts while typing.** H, 1–5, Delete and ? must also be suppressed while typing, but the spec only says this for Ctrl+Alt (spec:148).
  7. **Ctrl+B / Ctrl+U inside the note editor.** Bold the note's Markdown, or the PDF? Unspecified.
  8. **Alt+Shift+5.** Alt+Shift is the Windows input-language switch for users with two layouts (04:20, 04:173). Match on `e.code`, not on `%`.
- **Fix:**
  - Add a "context" column (page selection / annotation focused / editor / anywhere) to the shortcut table.
  - Restrict Tab to a focused annotation and define undo.
  - Define a keyboard selection method (caret mode, or find-then-extend).
  - Put a UK / US / German / Polish layout matrix on the user's Windows PC in the Phase 1 checklist.

### M11. The filter rules in the spec differ from the tested prototype, and the test gate is self-fulfilling
- **Section:** Learning filter (spec:205–245); success criterion 4 (spec:16).
- **Problem:**
  - **The rules changed, so the result no longer applies.** "43 correct decisions, 1 'ask me'" (spec:205) was measured with research's rules. The spec restates them differently:
    - It vetoes on *any single* sensitive id with no override. The prototype vetoes only on ≥2 ids or a card number, and only while positive evidence is <8 (04:283, 04:314).
    - It drops the DiT no-text path (04:285–288).
    - It replaces DiT with OCR, which is infeasible in the budget (M6).
  - **Undefined rules:**
    - "A valid card number" is undefined. Luhn alone passes about 10% of random 16-digit strings, so data tables and IDs in papers will trigger it without an IIN and length check **[reviewer knowledge]**.
    - Precedence between "blocks saving" and "arXiv id + References forces saving" is undefined when both fire.
  - **The fixtures are not in the repo.** `docs/research/classifier-fixtures/` holds only `manifest.json` (verified). The 44 PDFs live in a /tmp scratchpad (04:372–374), are fetched from third-party URLs (some already 410/403, 04:401), and have unclear licences (an individual's published receipts). CI cannot run "the 44-PDF test set … on every build" (spec:245).
  - **The gate is self-fulfilling.** The weights were hand-tuned on the same 44 files (04:411), so passing that set says little.
- **Fix:**
  - Make `score_proto.py` normative: port it 1:1 with its expected outputs.
  - Define precedence as user rule > hard block (with the pos ≥ 8 override) > force-save > score.
  - Commit the fixtures with a licence manifest, or a pinned mirror.
  - Gate on a held-out set as well as the tuning set.

### M12. @Claude cost and scale are understated, with no strategy for long documents
- **Section:** Claude integration §1 (spec:275–279).
- **Problem:**
  - **The first-question cost is understated.** "About $0.10 for the first question … about 1 cent per follow-up", with the document "cached for an hour". A 1-hour cache write costs 2× input (03:238), so a 20k-token paper is about $0.16 before output. Research's $0.10 was the 5-minute 1.25× rate (03:241).
  - **The follow-up cost is understated.** Opus 5.5 thinking cannot be disabled (03:218), so the follow-up figure leaves out thinking tokens at $20 per million.
  - **Long documents break the approach.** "Claude receives the document's text page by page" for a 600-page textbook means several hundred thousand tokens: several dollars per cache write, repeated every idle hour, beyond the PDF page limits (03:234) and possibly the context window. Haiku's price applies only to prompts ≤100K tokens (03:220).
  - **Smaller gaps:**
    - No spend cap or pre-send estimate.
    - API-key storage is ambiguous. `chrome.storage.local` is readable by content scripts by default, and this extension runs content scripts on every page (03:114, 03:229–230).
    - Whether @Claude works in the web library, where there is no key, is unstated.
- **Fix:**
  - Specify a context policy: whole document up to N tokens; above that, the cited or nearby pages plus local-FTS retrieval.
  - Show a cost estimate above a threshold.
  - Correct the figures.
  - Mandate `setAccessLevel({accessLevel: "TRUSTED_CONTEXTS"})` or extension IndexedDB for the key.

### M13. Web library auth and behaviour are undefined on a public URL that holds the whole library
- **Section:** Hosting (spec:302–310); Library "+ New" (spec:201).
- **Problem:** The spec says only "the same React library and viewer, served as static files by the Worker" (spec:309). It does not say:
  - How a browser session authenticates. Research uses a `__Host-sess` cookie plus a CSRF check (`Sec-Fetch-Site` + `X-SOP`, 05:260).
  - That the web library is online-only, with a "Saving… / Offline — not saved" state (05:337).
  - Whether uploads there run the filter, OCR and text extraction (05:339).
  - Whether @Claude works there.
  - How the viewer abstracts storage (`LibraryRepo`: Local vs Remote, 05:333).
  - What happens with large PDFs on the web (05:335).
- **Fix:** Add a "Web library" subsection covering these points, and treat cookie, CSRF and Origin checks as a gated security requirement.

### M14. The phase plan omits whole features and orders dependencies wrongly
- **Section:** Build phases (spec:394–408).
- **Problem:**
  - **The local store has no phase.** SQLite in the offscreen document is built nowhere, yet Phase 2's gate "no lost text" and the 300 ms draft autosave need it. So does persistence across reopen, which needs Phase 3's fingerprints.
  - **No phase owns these features:**
    - Production OCR (spec:127).
    - "Download with notes" and annotation import (spec:168).
    - Find, go-to-page, thumbnails and outline (spec:160–161).
    - Settings and shortcut rebinding (spec:148).
    - Dark mode (spec:365).
    - Export library zip (spec:265).
    - Courses and Home suggestions (spec:193–197).
  - **Late discoveries.** Phase 0 covers only engine risks, so other unknowns surface late: bold (M4), the Foxit/Acrobat thread round-trip (01:57, 01:134 [U]), large-buffer messaging (M7), AltGr (M10), CIMD/DCR with claude.ai (05:1007), and FTS rows-written counting on D1 (05:136 [U]).
- **Fix:**
  - Add a feature-to-phase matrix covering every section.
  - Move the local store and hash identity into Phase 1 or early Phase 2.
  - Widen Phase 0 to cover the listed unknowns, including a one-day cloud spike.

### M15. The v1 scope is too large for one plan
- **Section:** Whole spec.
- **Problem:** v1 bundles at least 14 hard subsystems:
  - a PDFium-wasm viewer with a custom DOM text layer
  - in-browser OCR with two candidate engines
  - four mark types, one with no PDF equivalent (bold)
  - Docs-style margin threads
  - PDF export and import of threaded annotations
  - an ML-assisted classifier
  - an offscreen SQLite FTS store
  - fuzzy versioning and re-anchoring
  - a seven-page Drive-clone library with dark mode
  - a sync protocol
  - an OAuth authorization server
  - an MCP server
  - a web library
  - @Claude streaming with citations
  
  Each passes four critics with a three-round re-plan rule. Research itself ranked threads, cloud sync and AI chat as "deliberately not in v1" (04:87).
- **Fix — suggested cut line:**
  - **v1** = takeover, viewer with reader parity (M9), text layer, highlight/underline/strike, Ctrl+Alt+M with threads and margin cards, local store, hash + URL identity (no auto version grouping), filter (heuristics + MiniLM), library (My library, Recent, Notes, search), Markdown export, Export-library zip plus FSA auto-backup (03:130), and @Claude (self-contained and cheap to build).
  - **v1.1** = Cloudflare sync, restore, web library and MCP connector.
  - **v1.2** = OCR, bold, version grouping, PDF export/import of threads, Courses and Home suggestions.

### M16. Several success criteria and walkthroughs cannot be checked automatically
- **Section:** Success criteria (spec:13–20); "Each one becomes an automated end-to-end test" (spec:45); Gates (spec:378).
- **Problem:**

  | Criterion | Automatable? | Why |
  |---|---|---|
  | 1 | Partly | Links via a local server serving varied headers: yes. File Explorer double-click: Windows-manual only (spec:392). "<1 s first page" has no hardware, network or file-size definition and will be flaky on shared CI runners. |
  | 2 | Mostly | Via Playwright. "No mouse" cannot be tested as written (M10). |
  | 3 | Yes | Once identity is defined (C1). |
  | 4 | Yes, but self-fulfilling | Tuning set only (M11). |
  | 5 | Partly | Needs a live API key, cost and non-deterministic output in CI. A recorded-stream mock covers the UI only. |
  | 6 | Partly | The claude.ai UI is manual. The MCP protocol and OAuth (CIMD) can be scripted with an MCP client; no sync-latency target is given. |
  | 7 | No | "As judged by the visual critic" is subjective. The library-shell references come only from GIFs and third-party clones, because the signed-in shell could not be captured (02:19). |
  | 8 | Yes | With wrangler/miniflare and a persistent-profile reset, once reworded (M1). |
  
  - **Walkthroughs.** Walkthroughs 2 and 7 cannot be automated E2E tests.
  - **file:// in CI.** E2E tests need "Allow access to file URLs" pre-seeded in the profile's Preferences.
  - **Speed budgets** "tested on every build" will flap on CI and block the gauntlet.
- **Fix:** Rewrite each criterion with measurable conditions (fixture, machine class, network shaping) and mark manual ones explicitly. Run perf gates on a fixed reference runner with tolerance bands.

### M17. Area and figure comments are referenced but not designed
- **Section:** What a note is made of (spec:131–133); Ctrl+Alt+M step 4 (spec:142); Risks (spec:426).
- **Problem:** The Risks table says "area notes always work" (spec:426), but marks are text-only and threads attach to "one mark, page point, page or document". There is no way to comment on a figure, a chart, an equation rendered as an image, or a scan before or after OCR fails.
  
  Research specifies a point note at the pointer and an Alt+drag area note (04:104–106), and area highlights for scans (01:120). The spec also contradicts itself: "a note for the page" (spec:50) versus "a note on the page under the pointer" (spec:142).
- **Fix:** Add an `area` mark (page + rectangle, no text anchor) with Alt+drag and a toolbar button, exported as /Square, and define point notes explicitly.

### M18. API key and token exposure through content scripts
- **Section:** Claude integration (spec:279); Hosting → Extension sign-in (spec:308).
- **Problem:** "Stored only in the extension's private storage, which web pages cannot read" is ambiguous. `chrome.storage.local` is exposed to content scripts by default (03:114), and the extension injects a content script into every frame of every page for embed detection (03:342). The same applies to the sync refresh token (05:315). A compromised renderer for any web page could then read the Anthropic key and the cloud token.
- **Fix:** Mandate extension-origin IndexedDB, or `chrome.storage.local.setAccessLevel({accessLevel: "TRUSTED_CONTEXTS"})` at startup. Add a code-critic check that no secret is ever read in a content script.

---

## Minor

1. **Connector tool list is inconsistent** (spec:285–292 vs spec:314). Hosting says Claude can "add or edit its own comments", but the tool table has no edit tool. The names also differ from research's eight tools (`list_documents`, `read_pages`, `get_annotations`, `recent_activity`, `update_comment`; 05:847–982). **Fix:** adopt research's eight tools, or state the deliberate subset.
2. **Esc and empty-note semantics differ from research** (spec:140). "Esc or clicking away keeps any typed text" does not say saved or draft. "An empty note removes its highlight" conflicts with research, where clearing an existing note keeps the highlight (04:117). **Fix:** state that Esc saves non-empty text, that an empty *new* note cancels the highlight, and that an emptied *existing* note keeps the highlight.
3. **Overlapping marks are undefined** (spec:131, 135). Can one range carry highlight + underline? What does "applying the same style again removes it" do on a partial overlap? Do colours and the 1–5 keys apply to underline, bold and strike? **Fix:** define the stacking and toggle rules with examples.
4. **Re-anchoring order is unsafe** (spec:133). "Exact position" must be accepted only if the quote matches there. Fuzzy matching needs a minimum score and a minimum quote length, or short quotes ("p < 0.05") land on the wrong text. **Fix:** state the thresholds; anything below goes to "Couldn't place".
5. **"Forget this PDF" scope is unclear** (spec:241). Does it purge the cloud (R2 blob, D1 text, tombstones keyed by sha)? Does the "never save" hash list sync? **Fix:** say "Forget" also runs "Remove from cloud" (05:224); keep the never-list local and salted.
6. **The viewer URL leaks paths into Chrome history** (C2.6). **Fix:** disclose it in the privacy text; consider the `?file=` token form with an opaque id for file:// paths.
7. **Library pages are undefined in places** (spec:193, 197, 187). "Suggested readings from your current courses", "current" courses, Moodle course-name detection, and the paper/textbook/slides/notes type all have no definition. The module-code regex is LSE-specific (04:230). **Fix:** define each, or cut Home suggestions from v1.
8. **The manifest key needs a paid account** (spec:255). Research generates it via the Chrome Web Store dashboard (03:319), which needs a paid developer registration. **Fix:** generate the key pair locally (openssl), commit only the public key, and bake the derived ID into the Worker's `EXTENSION_ID` and DCR allowlist.
9. **TypeScript 7** (spec:108) is the native-port line. Tooling that uses the TypeScript JS API (typescript-eslint typed rules, the custom design-token lint) may not work on it **[reviewer knowledge]**. **Fix:** verify in Phase 0 or pin TS 6.x for tooling.
10. **Google Sans Text is not a licensed family** (spec:350, "All three are open-licensed (OFL)"). It is only the opsz-17 end of OFL Google Sans (02:54–55, 02:108–113). **Fix:** say "aliased from Google Sans opsz 17".
11. **Rendering parity with Chrome is overstated** (spec:121, 123). "Pages are drawn by PDFium, the engine inside Chrome's own viewer" overstates parity: EmbedPDF uses AGG, not Skia, and has no system fonts (01:72). Non-embedded CJK fonts need 42 MB packages (01:105). "Used by … Drive" is unverified. **Fix:** state the differences and the CJK font policy.
12. **History pollution and URL parsing** (spec:166). Pushing every jump to browser history makes Back take many presses to leave the PDF. `pushState` fragments can corrupt the `?DNR:<url>` parse (03:44). **Fix:** collapse consecutive jumps and keep state in `history.state`, not the URL.
13. **Same document in two tabs** (drafts, card positions, conflicting local writes) is unspecified. **Fix:** use BroadcastChannel and a single draft owner.
14. **Incognito behaviour** is unspecified (extension allowed in incognito? save to library from incognito?). **Fix:** viewer only, never save, in incognito.
15. **"Never analyse receipts" (req 5) versus in-memory text mining and OCR of every PDF.** **Fix:** confirm the interpretation with the user and quote it in the spec.
16. **"The server also refuses anything else"** (spec:316) is only a check on a client-set flag (05:663). **Fix:** say so; don't call it a guarantee.
17. **Visual references are weak where it matters.** The library-shell references are GIF and third-party clone images (02:19). Light Docs-style cards on the dark `#1b1b1b` viewer canvas are unreconciled. The layout at 125–150% Windows scaling is not defined: with a 256 px rail, a 282 px card column and a page, about 1280 CSS px is left. **Fix:** define the card colours on the dark canvas and breakpoints for narrow widths.
18. **Logo provenance** (spec:350, "our mark") conflicts with req 7. **Fix:** derive it from a Material Symbol glyph and record that.
19. **Export claims are untested.** Foxit and Acrobat showing threads is [U] (01:57, 01:134). The spec states it as fact (spec:168). **Fix:** make it a Phase 0 check.
20. **The pdf.js fallback is not a drop-in** (spec:123). pdf.js cannot write `/IRT` replies, `/NM`, underline or strike (01:30, 01:67). The fallback needs its own export path (pdf-lib). **Fix:** say so in Risks.
21. **EmbedPDF v2 export is slow and destructive.** It is a full rewrite with a byte-by-byte copy, slow on large files, and it invalidates signatures (01:60, 01:125). **Fix:** apply the incremental-save patch (01:82) before export ships.
22. **R2 integrity is not verified server-side for multipart uploads** (05:161), and the spec is silent. **Fix:** re-hash on the client after download and record the verified state.
23. **Sync can stop silently after a long break.** The refresh token expires after 30 days idle (05:296), and the stuck-sync alert only appears when the library is open (spec:267). **Fix:** show a badge on the extension icon.
24. **claude.ai Free allows one custom connector** (05:78), and the R2 checkout may need a card (spec:326). **Fix:** say what happens without R2 (notes and text only) and check the user's plan in setup.
25. **Cost-table claims are soft.** "Connector calls measured 2 to 3 ms" (spec:324) was measured in Node, without token validation (05:63). **Fix:** label it as an estimate to verify in workerd.
26. **"Ask Claude" toolbar button** behaviour is unspecified (spec:135): does it create a note with @Claude, and is there autocomplete? "@Claude anywhere in a note" also triggers on incidental mentions. **Fix:** fire only on a leading `@Claude` token chosen from autocomplete.
27. **Settings and rebinding have no home.** Settings is not in the library page list (spec:189–199), and where rebindings live (`chrome.storage.sync` 8 KB per item, 03:113) is unstated. **Fix:** add a Settings page and storage choice.

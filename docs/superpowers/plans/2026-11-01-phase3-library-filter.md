# Phase 3 plan: the learning filter and the library

Nov 1, 2026. Scope: spec sections "Library and knowledge base", "Learning filter and privacy", the Backups part of "Storage, sync and backup", and the Phase 3 row of "Build phases". Binding: contracts §5 (and §4's version ladder). Research: `docs/research/04-features-classifier.md` Part B, `docs/research/classifier-fixtures/`, `02-drive-visual-spec.md` §4.1–4.9.

## Goal and done when

The real filter replaces Phase 1's stand-in. Saved readings land in a Drive-style library you can browse, search and back up.

**Done when (the phase gate):**
1. **Zero false saves.** On the 44 research fixtures and a held-out set of at least 20 more (10 learning, 10 not), no non-learning PDF gets the verdict `learning`. All 22 research non-learning files come out `not-learning`. At most 1 of the 22 learning files is not auto-saved (today it is the MIT 14.01 handout, `unsure`).
2. A receipt or private PDF leaves no trace: no row, copy, search hit, log line or request. If you mark one up, the app asks right away: "Save this PDF to keep your notes?"
3. The library has Home, My library (list and grid), Recent, Starred, Notes, Trash and Settings. It is light, looks like Drive, and the visual critic signs it off.
4. Ctrl+K finds readings, pages and notes. Enter jumps to the passage.
5. History works: a reading reopens where you stopped, and shows time read and last opened.
6. A backup goes to the folder you pick, with 7 snapshots. Restore on a fresh profile brings everything back. No backup file holds the API key. You have signed the Windows hand-offs.
7. Ctrl+Shift+E exports a document's notes as Markdown.

## What already exists (build on it, do not duplicate)

- **Task 30:** `FilterInput`, `FilterDecision`, `standInFilter`, `reduceSave` (it already has `asking` for a first mark on `not-learning`), `createSaveController` (its `filter` is injectable), `StatusChip`, `SaveAskDialog`, and the forget effect (Undo). Forget this PDF reuses that effect.
- **Task 28/29:** schema v1 already has `history`, `documents_fts`, `comments_fts`, `page_text_fts`, `searchPages`, `recordOpen`, `forgetDocument`. `sop-local` and the import boundary (R14) exist.
- **Task 13/14:** tokens, icons, and the viewer-leaning components. The library needs light-theme parts they do not have (nav pill, search pill, table rows, grid cards, segmented toggle, filter chips, a light menu).
- **Task 12:** WXT entrypoints (there is no library entrypoint yet) and `viewer-url.ts`.

## Frontier check (Nov 2026, four searches)

- **Chrome's built-in AI (Prompt API, Gemini Nano) for the tie-breaker: no.** The API is open to extensions (Chrome 138 listed), but the docs still say it is "being developed". It needs 22 GB free disk and a GPU over 4 GB VRAM or 16 GB RAM with 4 cores. Chrome downloads the model by itself (the first use needs a click), and Chrome decides when to delete it. It is not available in Web Workers, handles en/ja/es/de/fr only, and in April 2026 Chrome was reported to put a 4 GB model on disks without asking. A filter must give the same answer on every machine and must not depend on a download. Gemini Nano's output also changes when Chrome updates, so "zero false saves" could not be pinned in a test. **Keep bundled MiniLM.** Later option, not now: if the model is already present, it may only move `unsure` toward "ask", never toward "save".
- **Backup folder permission.** Since Chrome 122 the folder prompt has "Allow on every visit", but the notes only cover web apps. P0-8 saw `prompt` after a restart in an extension page. Whether a picked folder stays `granted` is still W-B1. So the backup must work when permission is lost: badge, then one click.
- Nothing else changed that touches this phase.

## Rules for this phase

- **Registration files.** Several slices touch these: `store-api.ts`, `protocol.ts`, `migrate.ts`, `schema.ts`, `App.tsx`, `commands.ts`, `runtime.ts`, `eslint.config.mjs`, `viewer-url.ts`. A slice makes only a one-line registration there (an import, an entry). Its logic lives in its own new files. This keeps merges clean next to Phase 2.
- **Schema step 3** (contract §4) lands after Phase 2's step 2. A slice that needs it can build on a branch with a stub step 2.
- **Privacy default for new code:** nothing about an unsaved PDF is written, logged or sent. Anything that records reading must wait for `SaveState.kind === 'saved'`.
- **Tests.** Implementers commit none. The test packs T1–T3 below are written by spec-blind authors, file names `*.spec-blind.test.ts`.

## Slices

Each line set: **Owns** (files) · **Makes/uses** · **Depends** · tier · model · size.

### Round 1 slices (start NOW)

**S1. Hard blocks.** Finds card and ID numbers so a private document can never be auto-saved.
- Owns `packages/core/src/filter/{hard-blocks,validators}.ts`.
- Makes `detectHardBlocks(texts: readonly string[]): HardBlock[]` (kinds only; no matched text is kept). Card = 16 digits with a valid checksum and a known prefix. IBAN with its checksum. UK sort code near an 8-digit account. NI number, US SSN, UTR, passport MRZ line, boarding-pass code (`M1…`). It must not fire on arXiv ids, DOIs, ISBNs, page numbers or number-heavy tables.
- Depends: nothing. · **high** · sonnet · S.

**S2. Classifier core.** The pure scoring and rules, as in contract §5.
- Owns `packages/core/src/filter/{types,classify,signals,hosts,terms,nudge,rules,index}.ts` and `scripts/filter/report.mjs` (prints a per-fixture score table, like the research prototype).
- Makes `classify(input, rules)` and `nudge(d, sim)`. Rule order is the spec's: your choice, hard block, deny/allow lists, force save, score. Start at −1; 3 or more saves; 0 or less does not; between is `unsure` with `needsModel`. Hard block: a card alone, or any two others, unless positive evidence is 8 or more. A scan with no text is never saved by score: `unsure` from scholarly or course pages, else `not-learning` with rule `no-text`. Weights are the spec's table. Start from `score_proto.py`, and add what it lacked: hard blocks, force save, lists, labels, and the non-English headings from research B.9 (Résumé, Zusammenfassung, Literaturverzeichnis, Bibliographie).
- Reasons are fixed plain-words labels, never PDF text. The first reason of a `not-learning` verdict is a "looks like …" phrase for the chip ("looks like an invoice or receipt", "a bank statement", "a payslip", "a tax form", "a ticket or boarding pass", "a contract", "has card or bank numbers"). A `learning` verdict gives labels like "References section, DOI, 40 pages".
- Pure and synchronous, under 150 ms on the largest sample. `pageSizes` and `metadata` are used structurally, so core imports nothing from `viewer`. Do not retune on held-out files.
- Depends: S1's signature (stub until it lands). · **high** · sonnet · L.

**S3. Markdown export (part 1: pure).** `exportMarkdown` from contract §5.
- Owns `packages/core/src/export/{markdown,markdown-input}.ts`. Inputs are structural, so it needs no Phase 2 code.
- Front matter (title, authors, DOI or arXiv id, source link, `sickofpdfs: { documentId, format: 1 }`), safe YAML escaping, one `## Page N` per page, document notes first. Quote as blockquote; bold as `**…**`, strike as `~~…~~`, highlight and underline as labels; replies indented under the root; Claude's comments labelled "Claude". `cite:n` becomes "p. N" with a link back, `web:n` the source URL. Deleted rows and drafts are left out. It never emits raw HTML. Also `notesFileName(title, sha)`.
- **Part 2 (Round 3, needs Phase 2 `listAnnotations`):** owns `apps/extension/src/viewer/actions/export-notes.ts`; adds `file.exportNotes` (Ctrl+Shift+E, File menu) that downloads the `.md`.
- Depends: part 1 nothing. · **high** (T2) · sonnet · M.

**S4. Metadata and kind.** Good titles, authors, year, DOI or arXiv id, and a paper/book/slides/other guess.
- Owns `packages/core/src/metadata/{extract,kind,titles}.ts`.
- Makes `extractMetadata({ fileName, url, metadata, firstPageText, secondPageText? })` and `guessKind({ pageCount, pageSizes, firstPageText })`. Rejects junk titles ("Microsoft Word - x.docx", "untitled", a file name). Many fixtures have an empty Info title, so the title often comes from page 1. Asks no network.
- Depends: nothing. · **low** (gates and Gate 1 titles) · sonnet · M.

**S5. Backup core.** The pure parts of backup and restore.
- Owns `packages/core/src/backup/{format,rotate,merge}.ts`.
- Makes the `BackupManifest` and `LibraryDump` types, `parseManifest` (refuses a higher version: "Update sickofpdfs first"), `planSnapshots(names, today)` (keep the last 7), `planRestore(local, backup, compareHlc)` (merge by fingerprint and id, newer `hlc` wins, nothing local is deleted, locations merge `firstSeen` by min and `lastSeen` by max, drafts never come back), and the backup path helpers.
- Depends: contract §5 only (`compareHlc` stubbed until Task 28). · **high** (T3) · sonnet · M.

**S6. Held-out set and test-assets release plan.** The second test set, gathered blind.
- Owns `docs/research/classifier-fixtures/heldout/{manifest.json,LICENCES.md}`, `docs/research/classifier-fixtures/prototype-decisions.json`, `scripts/fixtures/{fetch-heldout.mjs}`; modifies `scripts/fixtures/fetch-classifier.mjs`.
- An agent that never sees S2's code or weights gathers at least 20 public PDFs: 10 learning, 10 or more not. Each is open-licensed, at most 15 MB, with its sha256. It must cover what the 44 miss: a tenancy agreement and other contracts; French and German academic papers; a short Word-made seminar handout (the likely false skip); a university fee invoice; a CV or job letter; a lab result or insurance letter; another bank statement; accounting or tax lecture notes full of invoice words; a paper that quotes an example IBAN; a money-heavy economics problem set; an annual report and a government report (label `edge`: reported, not gated; the research policy is that "ask" is right). Every file gets a licence line.
- Records the prototype's per-fixture verdicts (`score_proto.py`) as the baseline that any changed decision is reviewed against.
- The openly licensed files go to a GitHub release `test-assets-v1` with the licence list (the controller creates it after the owner's OK). The three owner-published receipts and anything with a person's name are not redistributed: they stay URL-fetched, sha256-checked. A held-out file that fails and is then fixed for moves into the research set, and the gatherer adds a replacement.
- Depends: nothing. · **high** (it is the gate's data) · sonnet · M.

**S7. Library shell, list and grid** (visual). The look of the whole library.
- Owns `packages/ui/src/library/**` (new light components; `@sop/ui/library` barrel, so `index.ts` is untouched), `apps/extension/src/library/{app,shell,routes,data,components}/**`, `apps/extension/src/library/pages/{MyLibrary,Recent,Starred,Trash}/**`, `apps/extension/src/entrypoints/library/{index.html,main.tsx}` and `background/open-library.ts` (the toolbar icon opens the library tab).
- Top bar 64 px, search pill 48 px, nav 256 px with 32 px pills, "+ New" 56 px with Upload PDF, Open file, Paste link; content card 16 px corners; filter chips; list rows 48 px with hover, selected and keyboard-focus states; sort header; grid cards 220×220 with first-page thumbnail; empty-library state; row menu (Open, Star, Rename title, Copy link, Move to Trash); Trash with Restore. Light only. Our mark (Material Symbol `menu_book` tile) sits in the logo slot.
- Reads data only through a `LibraryData` interface (the contract §5 queries), with an in-memory fake used for screenshots. The real `StoreClient` plugs in when S9 lands. Thumbnails come from a cache in OPFS made for saved documents only.
- Upload PDF and Open file: the library never writes the bytes of an unclassified PDF. The viewer reads the file (for example a blob link opened in a new tab). No leftover record after the viewer opens (Gate 1 checks). Paste link just opens the link in a tab; takeover does the rest.
- Depends: Task 13 (done); Task 14 for menus; Task 12 for the entrypoint file. Everything else starts NOW against the fake. · **visual** · opus · L.

### Round 2 slices (after Phase 1 Tasks 12, 14, 15, 28–30 and Phase 2's schema step)

**S8. Filter input sampler and fixture inputs.**
- Owns `apps/extension/src/viewer/filter/sample-input.ts` and `scripts/fixtures/extract-filter-inputs.mjs`.
- Makes `buildFilterInput(backend, doc, ctx): Promise<FilterInput>`: text of the first and last 5 pages, page sizes, metadata, form type, link and `viaPage`. It runs after the first page is drawn and never delays rendering. The extractor runs the same function in the Vitest browser project over every fixture and writes `test-assets/classifier-inputs/<name>.json` (gitignored), so tests use PDFium's text, not the research `pdftotext` text.
- Depends: Task 15. · **high** · sonnet · S.

**S9. Library store.** Everything the pages and search ask of the database.
- Owns `apps/extension/src/store/{library-api,fts-query,schema-v3,trash-purge}.ts`. Registration edits only elsewhere.
- Makes schema step 3 (`documents_fts` skips trashed documents; index on `history(last_opened)`). `listDocuments`, `search`, `listNotes`, `recordReading`, `setStarred`, `trashDocument`, `restoreDocument`, `purgeTrash` as in contract §5, plus `getReading`. `SaveDocumentInput` and `saveDocument` gain optional `year`, `doi`, `arxivId`, `kind`, `indexText`.
- Search: each term quoted, the last term a prefix (typing feels live), operators and quotes stripped, capped length, never a raw `MATCH`. Results are grouped readings, notes, pages. Trashed and unsaved documents never appear. Filters: starred, has notes, date read, type.
- Trash purge runs when the store starts and once a day. After 30 days a document is forgotten completely (D8), and a note's body is blanked but its tombstone stays (contract §2).
- Targets (smoke): with 2,000 documents and 200,000 pages, search under 200 ms and the first list page under 300 ms.
- Depends: Tasks 28–29; Phase 2 step 2. · **high** (T3 covers `fts-query`) · sonnet · L.

**S10. Tie-breaker (MiniLM).**
- Owns `apps/extension/src/viewer/filter/{tie-breaker,embed.worker,prototypes}.ts`, `apps/extension/scripts/fetch-minilm.mjs` (sha256-pinned download at build time into the gitignored `public/models/minilm/`).
- Makes `createTieBreaker(): { similarities(text): Promise<{ learning: number; notLearning: number }>; dispose(): void }`. It runs in a worker inside the viewer tab only (never in the store or offscreen), starts on demand, and is ended after use. No remote models, one thread (the extension pages are not cross-origin isolated), all wasm bundled. The prototype vectors are computed once and stored as constants; a build test checks them against the model.
- Network gate: an e2e opens an `unsure` PDF and sees zero requests beyond the PDF.
- Depends: Task 12. · **high** · sonnet · M.

**S11. The filter in the viewer.** Where the owner meets the filter.
- Owns `apps/extension/src/viewer/filter/{rules-source,async-filter}.ts`; modifies Task 30's `viewer/save/{save-controller,StatusChip,SaveAskDialog}.tsx` and `packages/core/src/save/save-machine.ts`; adds `viewer/save/{NotSureBanner,ForgetDialog}.tsx`; modifies `local-only/secrets-store.ts` (never-save and report functions, `setMeta`).
- Flow: identity first (a known fingerprint never re-classifies). Then the file choice (`isNeverSave`). Then sample, `classify`, and the tie-breaker plus `nudge` only when `needsModel`. `learning` saves with its reasons and S4's metadata. `unsure` shows "Not sure: Save?"; a first mark saves with Undo (spec). `not-learning` shows "Not saved: looks like a receipt" and **asks right away on the first mark** (owner rule). Yes saves and sets the file choice; No keeps notes in memory only.
- A quiet banner after 20 s on `unsure`: Save · Not now · Never for this file · Always for this site (a host or folder prefix goes to the allow list). "Forget this PDF" (Ctrl+Shift+Delete, File menu): removes everything, asks first if there are notes, can add "Never save this file". "Report a wrong decision" (File menu) keeps the label and a salted fingerprint only. Chip tooltips show the top reasons.
- Saving a hard-blocked PDF by choice shows a warning line and saves with text indexing off (default D9).
- Depends: Task 30; S2, S4, S8, S10 (by interface). · **high** · sonnet · L.

**S12. Online lookups (off by default).**
- Owns `apps/extension/src/lookups/{arxiv,crossref,queue,fill}.ts`.
- When the setting `lookups.online` is on and a saved PDF has a DOI or arXiv id, a queue in the offscreen document asks arXiv or Crossref with the id only. At most one arXiv call per 3 seconds; quiet back-off on failure. It fills only empty title, authors and year, and never overwrites. Nothing is sent for unsaved PDFs. The e2e network gate allows exactly those two hosts only while the setting is on.
- Depends: Tasks 28, 30. · **high** (network) · sonnet · S.

**S13. Backup writer.**
- Owns `apps/extension/src/backup/{writer,schedule,handle-store,badge,zip,target}.ts`, `apps/extension/src/store/backup-api.ts` (`exportLibrary`, `applyRestorePlan`), `apps/extension/src/library/settings/BackupSection.tsx`, `docs/checklists/phase3-windows.md`. Registers its folders in the ESLint list that bars `local-only` imports.
- Format v1 is contract §5. The writer runs in the offscreen document. Every file goes through `createWritable()`, and the manifest is written last. PDFs are copied once per fingerprint (skipped if the size matches). Notes are `.md` for each document with notes (S3). The newest 7 `library.json` snapshots are kept (D6). Forgotten or purged documents are removed from the folder at the next run. Never included: `sop-local`, `sop-device`, drafts, FTS, `page_text`, `page_figures`, `outbox`, unsaved PDFs.
- When: nightly (a catch-up on start if a night was missed) and after a session with new notes (at most every 10 minutes).
- The folder handle moves to its own IndexedDB `sop-handles` (store side). If permission is not `granted`, the action icon shows a badge and the library shows "Backup is waiting. Click to allow." One click re-grants. Settings shows last backup, size, and errors in plain words. "Export library" streams a zip (a pinned zip library, no whole-library buffering).
- Tests use an OPFS folder as the fake `BackupTarget` (it is a `FileSystemDirectoryHandle` too). The real picker cannot be driven headless (P0-8). `phase3-windows.md` repeats W-B1..B3 on the real Settings page: pick, restart Chrome, check state; a Google Drive for desktop folder; a OneDrive folder; plus "restore on a fresh Chrome profile".
- Depends: Tasks 28–29; S3, S5, S9. · **high** · sonnet · L.

### Round 3 slices (need Round 2)

**S14. Home, Notes and Settings pages** (visual).
- Owns `apps/extension/src/library/pages/{Home,Notes,Settings}/**`, `apps/extension/src/library/settings/sections.ts`, `apps/extension/src/shortcuts/overrides.ts`.
- Home: "Welcome", collapsible "Continue reading" and "Recent notes". Notes: every thread newest first, searchable, All/Mine/Claude, Trash view of notes, "Export notes". Settings is a list of sections from a registry (`SETTINGS_SECTIONS`) so Phase 4 can add its Claude section without editing this slice. Phase 3 sections: Library rules (allow and deny lists with suggestions such as moodle.lse.ac.uk that you switch on yourself; the never-save count), Shortcuts (rebind, a conflict check, a warning for Ctrl+Alt+letter), Online lookups switch (S12), Backup (S13), Restore (S17).
- Depends: S7, S9; S13 and S17 sections by file. · **visual** · opus · M.

**S15. Search palette and jump.**
- Owns `apps/extension/src/shared/palette/**`, `apps/extension/src/viewer/{open-saved,jump-to-hit}.ts`; registers `doc`, `note`, `q` in `viewer-url.ts`, and Ctrl+K in `commands.ts` and the library.
- A Drive-style palette on Ctrl+K in any viewer or library tab. Groups: Readings, Pages, Notes, and (in the viewer) Commands. Filter chips for starred, has notes, date, type. Snippets are split on the `<b>` markers and never go through `innerHTML`. Enter opens a reading at its resume spot, a page hit at the page with the first query term found (`PageTextProvider.search`), a note at its thread. In the same document it jumps in place with collapsed history. `?doc=` opens the saved copy from the blob store; a missing copy shows the error card.
- Depends: S9, S7 (search pill), Task 25. · **visual + high** · sonnet · M.

**S16. Reading history.**
- Owns `apps/extension/src/viewer/history/{reading-tracker,resume}.ts`.
- Counts reading time only while the tab is visible and focused and not idle for over 60 s. Saves last position (page, offset, zoom) after 5 s and on hide, and the pages visited. Reopening resumes there, unless the link has its own page or note; a quiet "Start from page 1" is offered. Before the PDF is saved, everything stays in memory and is written at save time (this is the "saving back-fills the history" rule). Nothing in Incognito or memory-only.
- Depends: Task 30, S9, S11. · **high** (nothing written before save) · sonnet · S.

**S17. Restore.**
- Owns `apps/extension/src/backup/{restore,reindex}.ts`, `apps/extension/src/library/settings/RestoreDialog.tsx`.
- Settings "Restore from backup": pick a folder (a click), validate the manifest, show what is in it ("12 readings, 340 notes, 9 PDFs"), merge with S13's `applyRestorePlan`, then copy PDFs into the blob store with their sha256 checked as written. Changes publish with `origin: 'restore'`, so open tabs redraw. Then page text is re-extracted in the background in the offscreen document with progress ("Indexing 3 of 12"). Running it twice changes nothing. A newer backup version is refused. A forgotten document stays gone.
- Depends: S5, S13, S9, Task 15. · **high** · sonnet · L.

## Rounds

| Round | Starts | Slices | NOW? |
| --- | --- | --- | --- |
| 1 | at once | S1, S2, S3 (part 1), S4, S5, S6, S7 (against the fake) | **yes, 7 slices** |
| 2 | Tasks 12, 14, 15, 28–30 and Phase 2's schema step are merged | S8, S9, S10, S11, S12, S13 | no |
| 3 | Round 2 merged | S14, S15, S16, S17, S3 part 2 | no |
| Gate | Round 3 merged | the held-out run, T1–T3, Gate 1–3, the Windows checklist, the four critics | no |

A test build goes to the owner after Round 2 (filter and chip) and again after Round 3 (the whole library). S1/S2 can finish before any Phase 1 code exists, so the filter can be checked on real files in days.

## Test packs (spec-blind authors, Round 1, in parallel with the code)

Authors get the spec, contracts §5 and the fixtures. They never see the code or the brief's examples.
- **T1, learning filter** (`packages/core/src/filter/*.spec-blind.test.ts`). Table-driven:
  - the 44 fixtures from the extracted inputs: all 22 non-learning `not-learning`; at least 21 of 22 learning `learning`, the rest `unsure`, none `not-learning`;
  - hard blocks (valid and invalid card numbers, IBAN, the two-of rule, the 8-point override with a paper quoting an example IBAN);
  - rule order, including "hard block beats the allow list";
  - scans, force save, and the privacy canary (a unique string put in the text never appears in the decision);
  - `nudge` can only change `unsure`;
  - a time check under 150 ms.
  - The held-out run uses the same file with S6's manifest and runs at the gate.
- **T2, Markdown export:** the mapping table (styles, replies, cite and web links, escaping, order, deleted rows).
- **T3, backup core and search query:** snapshot rotation, restore merge (idempotent, newer wins, nothing deleted, aliases), version refusal, and the FTS query builder (quotes, operators, prefix, unicode, over-long input).

## Gate 1: walkthrough tests to add (plain words)

1. **A journal paper link.** The chip says "Saved to library". The tooltip names reasons such as the References section. The library lists it with a proper title. Close it, reopen it: it opens where you stopped.
2. **A receipt.** The chip says "Not saved: looks like a receipt". There is no row, no copy, no search hit. A request log shows only the PDF. One click on the chip saves it. Forget this PDF removes everything again.
3. **Marking up a receipt.** You select text and comment. The app asks right away. "No" keeps the note until the tab closes and the library stays empty. "Yes" saves it.
4. **A "not sure" PDF.** After 20 seconds the banner appears. "Never for this file" holds when the file is reopened from another folder under another name. "Always for this site" saves the next PDF from that site.
5. **Filter sweep.** Open every non-learning fixture in the real extension: the library stays empty. Open every learning fixture: all but at most one are saved or asked.
6. **Library tour.** Switch list and grid. Sort by title and last opened. Star a reading and find it under Starred. Trash it, see it in Trash, restore it. Recent, Home "Continue reading" and the Notes page show the right items.
7. **Search.** Ctrl+K in the viewer and in the library. Type a phrase from a page, a title word and a word from your comment. Each group finds it. Enter lands on the passage. A trashed or forgotten reading does not appear. Filters narrow the list.
8. **Moved and renamed file.** One library entry, two places. (Phase 1 covers identity; this checks the library shows it once.)
9. **Backup.** Choose a folder (test folder). Make a note. A backup appears with the PDFs, the notes as Markdown and `library.json`. Run it on 8 days: 7 snapshots remain. No file holds the API key. Forgetting a PDF removes it at the next run.
10. **Restore.** On a fresh profile, restore. Readings, notes, marks and PDFs return and text becomes searchable. A second restore changes nothing. A backup from a newer version is refused with a plain message.
11. **Lost folder permission.** The action icon shows a badge. One click re-allows it and the backup completes.
12. **Lookups.** With the setting off, no request leaves. With it on, only the id goes to arXiv or Crossref, and only for a saved PDF.
13. **Export notes.** Ctrl+Shift+E gives Markdown with quotes, page numbers, replies and a working link back.

## Gate 2 additions (engine reference set)

Add a **decision snapshot** for all 44 fixtures plus S6's set: a hash of the filter input (sample text, page sizes, producer), the verdict, the score and the rule. It runs when engine, text-layer or filter code changes. A different text hash means the engine moved. A different verdict or score is shown as a before/after and is approved or rejected, never silently re-recorded.

## Gate 3 screens to add (next to the Drive references live-01…08 and crop-38)

Library: Home; My library list (plain, row hover, selected, keyboard focus); grid; empty first run; Recent; Starred; Notes; Trash with Restore; row menu; "+ New" menu; Settings (rules, shortcuts, backup connected, backup waiting for a click, last backup, restore summary, indexing progress); the "Update sickofpdfs first" message. Palette: results, no results, filters open. Viewer chrome: every chip state; "Not sure" banner; the Save ask; the Forget dialog; the backup badge on the icon.

## Contract additions

- `FilterInput` gains optional `formType?: 'none' | 'acroform' | 'xfa-full' | 'xfa-foreground'`, and uses `pageSizes` and `metadata` structurally (width and height; title, author, subject, keywords, creator, producer), so core does not import `viewer`.
- `ViewerParams` gains `q: string | null` (the first term to find) beside `doc` and `note`.
- `StoreApi`: `getReading(documentId): Promise<{ lastPosition: { page: number; offset: number; zoom: number } | null; readingMs: number; pagesVisited: number[]; openCount: number } | null>`; `listNotes` options gain `trashed?: boolean`; `SaveDocumentInput` gains optional `year`, `doi`, `arxivId`, `kind`, `indexText`; `exportLibrary(): Promise<LibraryDump>` and `applyRestorePlan(plan): Promise<void>` (S13, camelCase rows, drafts excluded).
- Synced `settings` keys: `filter.deny`, `filter.allow` (string arrays), `shortcuts.overrides`, `lookups.online` (default `false`), `library.layout` (`list` or `grid`).
- `sop-handles` (IndexedDB, store side) holds the backup folder handle and a small backup status record. It is never backed up or synced.
- `SETTINGS_SECTIONS` registry at `apps/extension/src/library/settings/sections.ts`, so Phase 4 adds a Claude section as a file.
- `createTieBreaker()` as in S10.

## Risks and decisions

- **A false save is a privacy failure.** Defences: asymmetric thresholds, hard blocks that beat the allow list, `learning` needs text, T1 plus the held-out set, the Gate 2 snapshot, the Gate 1 sweep, and a security read of S1, S2, S10, S11, S12, S13, S16 and S17.
- **Overfitting.** The weights were tuned on the 44 files. The held-out set is for the gate only. A fix made after a held-out failure must be general, and that file then moves to the research set.
- **Text differences.** Research used `pdftotext`; production uses PDFium. Any decision that differs from `prototype-decisions.json` is reviewed by hand (spec).
- **`unsure` plus a first mark saves** (spec). A receipt that scores `unsure` could be saved by a mark. The Gate 1 sweep and T1 require all 22 non-learning fixtures to be `not-learning`, not merely `unsure`.
- **Backup permission is unknown until W-B1..B3.** The design assumes it can be lost. Drive for desktop may sync Chrome's temporary swap files briefly; that is harmless but should be seen once.
- **Shared files with Phase 2** (store, App.tsx, commands.ts) are handled by registration-only edits and per-round merges.
- **Defaults I used that you can overrule:**
  - **D9.** You may save a hard-blocked PDF by choice. It shows a warning and keeps text indexing off. (Mission says private documents are never touched; the spec says one click saves a wrong call.)
  - **D10.** Online lookups are off until you switch them on (the non-negotiable says only traffic you turn on).
  - **D11.** No Chrome Prompt API; MiniLM stays.
  - **D12.** The test-assets release holds only openly licensed files; it needs your OK to create it on GitHub.

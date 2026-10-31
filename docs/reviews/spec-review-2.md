# Spec review 2: sickofpdfs Design Spec v1 (revised)

Reviewer: independent design critic, second pass. Date: 2026-10-31.
Spec reviewed: `/home/user/sickofpdfs/docs/superpowers/specs/2026-10-31-sickofpdfs-design.md` (cited as `spec:NNN`, revised line numbers).
First review: `scratchpad/reviews/spec-review-1.md` (C1–C3, M1–M18).
Research: `/home/user/sickofpdfs/docs/research/0N-*.md` (cited `01:NNN` … `05:NNN`); prototype `docs/research/scripts/score_proto.py` (cited `score_proto.py:NN`).
**[reviewer knowledge]** marks claims from my own knowledge of Chrome, PDF, Moodle, JSTOR and Cloudflare behaviour, not from the research files. A build agent should verify them.

Fixed user decisions, not findings: (a) three releases (R1 reader/marks incl. bold/comments/library/@Claude/local backup; R2 sync/web library/connector; R3 OCR/version linking/PDF export-import). (b) The filter may read text in memory; nothing is stored or sent for non-learning PDFs.

## Tally

| Status | Count | Items |
|---|---|---|
| Resolved | 12 | C3, M1, M5, M6, M7, M8, M9, M12, M13, M15, M17, M18 |
| Partly resolved | 9 | C1, C2, M2, M3, M4, M10, M11, M14, M16 |
| Not resolved | 0 | — |

New issues: **1 critical, 13 major, 19 minor.**

---

## Part 1: Review-1 findings, one by one

### C1. Document identity and grouping — **Partly resolved**
Content identity is now right: "A document is its fingerprint: the SHA-256 of the file's bytes" (spec:222), weak hints "only prompt" (spec:224), "A reading is a synced record that groups versions" (spec:225), and imports are "de-duplicated by their PDF ids" (spec:210). But rule 2 now auto-versions on "Same link, new bytes" and *copies* notes (spec:223). That makes C1.5 (per-download stamped PDFs) worse, not better: see **N1**. "Link" is still undefined (**N2**). Readings and copied notes have random ids, so C1.6 has moved from documents to readings (**N3**). Which version the library opens is still unstated (C1.4).

### C2. Privacy rule — **Partly resolved**
Most paths are closed. The egress table (spec:283–289) has "Only when you ask Claude; on a PDF not in your library, only after you confirm", lookups "Only for saved PDFs, and only the id", and "No code, fonts or models are downloaded; a build test fails on any other request". Local traces are listed (spec:291). Still open:
- The pending area stores marks and quotes from non-learning PDFs, which spec:291 does not list among the "Two exceptions" (**N10**).
- "A PDF you report as misjudged joins a private test set that stays on your computer" (spec:305) keeps whole copies of possibly private PDFs (**N10**).
- The backup folder is an egress path (Google Drive or OneDrive) that is missing from the table. Nothing excludes secrets or pending notes from it (**N9**).

### C3. Notes on unsaved PDFs live only in memory — **Resolved**
"Your first mark or note on a 'not sure' PDF saves it to the library, with an Undo chip" and "Marks on a PDF judged not learning go to a local pending area: kept 7 days" (spec:295–296). There is a crash gate: "kill the tab mid-note; the note must survive" (spec:445). The gate does not yet say it runs on an unsaved PDF, and it cannot until Phase 3 (**N12**). The privacy side effect is **N10**.

### M1. Criterion 8 "loses nothing" — **Resolved**
R2 now says "everything marked as synced restores after a reinstall (the library shows how many items are still unsynced)" (spec:24), and "Sync and uploads run in the hidden background page, so they never need an open tab" (spec:325). The new R1 criterion 8 has its own problems (**N8**).

### M2. Cloud copy is the only backup; agents deploy to production — **Partly resolved**
Fixed:
- An independent copy: "Your local backup folder from Release 1 keeps running as an independent second copy" (spec:381).
- Staging: "Build agents deploy only to a separate staging Worker with its own databases. Your production Worker updates only from tagged releases, after a database snapshot" (spec:375).
- A bootstrap workflow and the full secret list (spec:530–531).

Still wrong:
- The "nightly snapshot of the database goes to R2" cannot run as described (**N13**).
- Staging shares production's account-wide free quotas and has no OAuth app of its own (**N14**).
- How the Bootstrap workflow writes the created D1/R2 ids back into `wrangler.jsonc` (05:385) is still unstated. The "no developer tools on your PC" claim (spec:514) depends on it.

### M3. Sync protocol and data model underspecified — **Partly resolved**
The protocol behaviour is now stated: "revision it was based on and a hybrid clock", conflict copy "added to its thread as a reply", "An edit beats a delete", metering, and "Note drafts stay local" (spec:322–327). Still missing:
- **No normative schema or API.** spec:313 names tables only.
- **The research schema is not superseded.** It still allows only `highlight, underline, strike, note, ink, comment, reply` (05:712), with no bold, area, point or document thread, and no reading. A build agent copying 05 would reject bold and area marks on the server.
- **The metering threshold** is "near the free limit" (spec:326). Research says about 85k rows (05:140).
- **Random ids** for readings, locations and copied notes create duplicates (**N3**).

### M4. Bold not buildable — **Partly resolved**
There is now a mechanism, a Phase 0 test and a fallback that needs the user's OK: "Bold redraws the covered text heavier using PDFium's fill-and-stroke text mode … If Phase 0 shows it looks wrong, bold becomes a 'strong' style … and you are asked first" (spec:149). But that mechanism contradicts "Marks … draw as an SVG overlay. They are written into a PDF only when you export" (spec:151) and is not per-character (**N5**). The R3 export is still only "bold marks with their own appearance" (spec:210), with no subtype named.

### M5. Text layer from scratch — **Resolved**
"We port pdf.js's text-layer code (Apache-2.0) and feed it PDFium's glyph boxes … Phase 0 checks this with a selection test suite, including copy-paste matching Chrome's viewer" (spec:140). "Marks … draw as an SVG overlay" (spec:151). Leftovers (minor, not re-raised): CJK has dropped out of the suite, PDFium has no reading-order analysis, and how this layer co-exists with EmbedPDF's own selection plugin is unstated.

### M6. OCR infeasible or undefined — **Resolved**
OCR is now R3, "only for saved PDFs", runs "in the hidden background page", "English comes first, with French and German packs", and results are "stored per page with the engine name and version" (spec:212). Scans are "never OCR'd to decide" (spec:259), and Phase 7 exists (spec:479). The changed scan *classification* rule belongs under **N6**.

### M7. No transport for PDF bytes — **Resolved**
"Tabs write PDF files straight to private file storage and send database changes over a direct message channel" (spec:99). "Large data never travels through Chrome's extension messages" (spec:314). hash-wasm (spec:131). A broadcast channel keeps tabs in step (spec:315). Phase 0 tests "moving 300 MB files between tabs and the background page" (spec:486). One wording error: the offscreen page is recreated by the extension, not "Chrome" (spec:313; 03:149).

### M8. Takeover coverage and impossible fallback — **Resolved**
Criterion 1 now has exclusions: "PDFs loaded by a form post, and PDFs with fillable forms, stay in Chrome's viewer" (spec:15). Embeds are covered ("such as Moodle", spec:37). There is an escape hatch, "File → 'Open in Chrome's viewer', always available" (spec:180), and the error page offers "Import this PDF" (spec:504). The form-routing rule the fix introduced is undefined and conflicts with research (**N7**). Chrome 128 is still not stated (minor m12).

### M9. Reader must-haves missing — **Resolved**
A reading-basics table (spec:169–183) covers print, zoom keys, find, links, outline, rotate, two-page view, presentation mode, dark pages, passwords, forms, the escape hatch, Ctrl+S, a 1 GB policy and WCAG 2.2 AA. Residual minor items: m4 (1 GB untested) and m8 (password claim).

### M10. Shortcuts conflict and have no contexts — **Partly resolved**
Fixed:
- A "When" column (spec:187–206).
- Tab only when "A mark is focused" (spec:195).
- Undo/redo keys (spec:197).
- Keyboard selection via "Ctrl+F finds a phrase and Enter selects the match; Shift+arrow keys then extend it" (spec:142).
- "Ctrl+B and Ctrl+I format the note" (spec:162).
- "Ctrl+U only acts when text is selected" (spec:185).

The fix for Alt+Shift+5 was generalised to "Keys are matched by physical position" (spec:185). On German, one of the three layouts in the hand check, that swaps undo and redo (**N11**). "Undo / redo … Anywhere" overrides undo in the note editor, and "Enter selects the match" collides with Find's next-match (m7).

### M11. Filter differs from prototype; self-fulfilling gate — **Partly resolved**
Fixed:
- Precedence is now an ordered list (spec:254–259).
- A held-out set exists (spec:18, 305).
- The card rule has a prefix check (spec:255).

Still wrong:
- **"Rules and weights are ported exactly from the research prototype"** (spec:261) is false and cannot be done. The prototype that produced 43/44 has none of the hard rules, and the spec differs from both prototypes in at least six places (**N6**).
- **Test assets contradict the gate.** "only openly licensed files are published" (spec:305), yet every task must pass "the 44-PDF filter test" (spec:445). Many fixtures are not openly licensed: Boyd, Tong, Sutskever, CS231n, CS50, IPCC, NBER, CEP and the owner-published receipts. One ticket "contains owner's name" (manifest). CI cannot run the gate.
- **The held-out set is undefined:** who builds it, its size, its composition and where it lives.
- **The private set** "stays on your computer", so no build agent can run it.

### M12. @Claude cost and long documents — **Resolved**
"Documents up to about 100,000 tokens … go in whole; for longer ones … up to about 40,000 tokens" (spec:338). "$0.16 for the first question … 2 to 4 cents per follow-up, including Claude's thinking. An estimate appears before any request over $0.25" (spec:341). These match 03:218 and 03:238. The key location (spec:342) and the web library behaviour (spec:343) are stated. Residual minor item: m6.

### M13. Web library auth undefined — **Resolved**
"It signs in with the same GitHub login and holds a secure session cookie, with cross-site request checks on every change. It is online-only … PDFs uploaded there run the same filter" (spec:377). Residual minor item: "large PDFs load from R2 in ranges" contradicts the engine (m5).

### M14. Phase plan omits features — **Partly resolved**
Fixed:
- Local store and identity moved to Phase 1, and several homes stated (spec:488).
- Phase 0 widened, and openers for R2 and R3 added (spec:486).

Still missing:
- **No full feature-to-phase matrix.** Many features have no stated phase: rotate, two-page and presentation views, dark pages, the large-file policy, form routing, Incognito, the pending area, Trash, the Notes page, Home, library dark mode, WCAG, keyboard selection and the @Claude cost estimate.
- **Phase 0 does not test** FSA backup persistence (**N8**), form detection (**N7**) or the 1 GB limit (m4).
- **Gates and hand checks don't match the phases** (**N12**).

### M15. v1 scope too large — **Resolved** (user decision (a))
"It ships in three releases, each finished and critic-tested before the next" (spec:11).

### M16. Criteria not automatable — **Partly resolved**
Fixed:
- Hand checks are listed (spec:28, 459).
- "CI runs looser smoke versions so random slowness never blocks work" (spec:214).

Still open:
- **"The reference laptop"** (spec:15, 214) is undefined: CPU, RAM, network, the file, cold or warm start, and who owns the machine. Build agents run in the cloud.
- **Criterion 6** ("at least as well as in Chrome's viewer", spec:21) and **criterion 7** ("as judged by the visual critic", spec:22) are not automated tests, yet spec:28 says "Everything else is an automated test".
- **The @Claude E2E strategy** (live key or recorded stream) and **pre-seeding file:// access in CI** are unstated.

### M17. Area and figure comments — **Resolved**
"Alt+drag a rectangle around a figure" (spec:150). "An area anchor holds the page and rectangle" (spec:155). A thread "belongs to one mark, a point on a page, a page, or the whole document" (spec:156). Residual minor items: m3 (page note vs pointer note wording) and m19 (Alt+click, no keyboard path).

### M18. Secrets readable by content scripts — **Resolved**
"Your API key sits in the extension's private database, which content scripts and web pages cannot read" (spec:342). "the token stays in the extension's private database" (spec:374). The new exposure path is the backup folder (**N9**).

---

## Part 2: New issues introduced or exposed by the revision

### Critical

#### N1. Per-download-stamped PDFs fork every note on every open
- **Section:** Identity rules 2 (spec:223); walkthroughs 8–9 (spec:66–67); criterion 3 (spec:17).
- **Problem:** JSTOR prints "This content downloaded from <IP> on <date>" on every page, so every fetch has new bytes **[reviewer knowledge]**. Many publisher and LMS watermarks do the same; review 1 raised this as C1.5. The viewer re-fetches the link on every open, so each open of a JSTOR link becomes a "new version" under rule 2. "Your notes are copied onto the new version … the old version keeps its own notes." After ten opens over a term:
  - The reading has ten versions, ten stored PDF copies and, from Release 2, ten R2 uploads (spec:325: "once per fingerprint").
  - Every earlier note exists up to ten times. The Notes page ("Every note and thread across all readings", spec:241), Ctrl+K and `get_annotations` show the duplicates.
  - Edits and replies made on one copy never reach the others.

  Walkthrough 8 promises the opposite: "You move, rename or re-download a file. Same contents, same fingerprint, same notes" (spec:66). For stamped hosts, a re-download is not the same contents. This corrupts the core feature on the most common academic source, and the E2E suite (a local server serving fixed bytes) will not catch it.
- **Evidence:** spec:223, spec:66, spec:241; review 1 C1.5.
- **Fix:**
  - Add a *text alias* step before rule 2. If the new bytes have the same page count and their normalised page text matches the known version, treat the fingerprint as an alias of the same document, with the same notes and no copy. Normalise by stripping download-stamp lines (`downloaded from`, `This content downloaded`, `Downloaded by`, IP/date patterns) and comparing ≥ 99.5% of characters.
  - Model notes as belonging to the reading, with one anchor per version, rather than copying records. Then "the old version keeps its notes" does not mean duplicate records.
  - Add a fixture: the same URL served three times with different stamps must yield one set of notes and one library entry.
  - State which version the library opens: the newest by first-seen time, with a version picker.

### Major

#### N2. "Same link" never matches on Moodle, and "link" is undefined
- **Section:** Identity rule 2 (spec:223); locations (spec:227); Hosting "Links are cleaned" (spec:379).
- **Problem:**
  1. **Moodle changes the URL on every update.** It serves resources from `pluginfile.php/<ctx>/mod_resource/content/<revision>/<file>`, and `<revision>` increments when the teacher replaces the file **[reviewer knowledge]**. The DNR takeover sees only the final, post-redirect URL. On the user's own LMS, the walkthrough-9 case ("Your professor uploads a new version to the same link") never fires.
  2. **File paths are ambiguous.** It is unstated whether a local path counts as a "link". If it does, `Downloads\slides.pdf` overwritten by a different deck copies every note onto an unrelated document as "Couldn't place" orphans.
  3. **Normalisation is unstated:** query strings, fragments, tokens, http/https and EZproxy hosts.
  4. **Devices compare different strings.** The cloud stores links "cleaned of tokens" and file paths "reduced to file names" (spec:379), so devices compare different forms of the same link.
- **Fix:**
  - Specify `canonicalLink(url)` in `packages/core`, with test vectors.
  - Record the navigation chain (the initiating `mod/resource/view.php?id=` URL from `webNavigation`) as a location.
  - Strip Moodle's revision segment.
  - Exclude file paths from rule 2: a known path with new bytes gives the "Looks like a new version" prompt.
  - Compare on the same cleaned form that sync stores.

#### N3. Readings and copied notes duplicate across devices (Release 2)
- **Section:** Sync rules (spec:322); Identity rules 1, 4 (spec:222, 225).
- **Problem:** "Documents are keyed by fingerprint; other records have random ids" (spec:322). This contradicts spec:222, "Every device derives the same id, so sync never creates duplicates". Two cases:
  - **Readings:** two computers that open the same new PDF before syncing (common: the same Moodle reading at home and in the library) each create a reading with a different random id for one document. After sync there are two library entries.
  - **Copied notes:** rule 2's copy runs on each device that sees the new version, with fresh random ids, so the new version gets every note twice.
- **Fix:**
  - `reading_id` = the fingerprint of the first version seen. When two readings claim one document, keep the smaller id and record the other as an alias.
  - Copied-note id = `hash(source_note_id, target_fingerprint)`.
  - Location id = `hash(canonicalLink)`.
  - Add a two-device sync E2E test.

#### N4. Toggle and split rules can delete or orphan comment threads
- **Section:** Marks (spec:146–147); note model (spec:155–156); Ctrl+Alt+M flow (spec:161, 165).
- **Problem:** A mark has one "style, colour and anchor" (spec:155), and a thread "belongs to one mark" (spec:156). A comment *is* a highlight: "Ctrl+Alt+M creates a highlight" (spec:161). And "Applying a style that already covers the whole selection removes it from that selection, splitting the mark if needed" (spec:147). So:
  - Selecting a commented passage and pressing H removes the highlight that owns the thread.
  - Pressing H on part of it splits the mark, and nothing says which part keeps the thread.
  - Highlight plus underline are two marks, so "A selection over an existing mark opens that mark's thread" (spec:165) does not say which thread opens.

  This is the core feature, and a build agent would guess.
- **Fix:**
  - Give threads their own anchor, with style marks as decorations, so removing or splitting a style never deletes a thread.
  - On a split, the thread stays with the segment that holds the original start.
  - Removing a commented passage's last style leaves a comment-only anchor (for example, a dotted underline).
  - Define the open rule for overlaps (most recently created).
  - Add unit tests for each case.

#### N5. Bold rendering contradicts the overlay rule and cannot target part of a run
- **Section:** Marks (spec:149, 151); speed budgets (spec:214); Print (spec:173); Export (spec:210).
- **Problem:** "Bold redraws the covered text heavier using PDFium's fill-and-stroke text mode" (spec:149), but "Marks … draw as an SVG overlay. They are written into a PDF only when you export" (spec:151). PDFium's text render mode is a property of a whole page text object (`FPDFTextObj_SetTextRenderMode`). A text object is typically a run spanning a line or more **[reviewer knowledge]**. Bolding three words therefore means one of:
  - splitting content-stream objects and regenerating the page, which modifies the document in the engine and re-renders tiles (not an overlay); or
  - bolding the whole run.

  Further gaps:
  - "any mark under 50 ms" (spec:214) applies to bold.
  - Print "with or without your marks" (spec:173) has no stated way to include overlay marks.
  - The pdf.js fallback engine has no bold path.
- **Fix:**
  - Specify bold as an SVG overlay of glyph outlines (PDFium glyph paths at the character boxes), filled and stroked, so it stays an overlay and stays per-character.
  - Measure it against the 50 ms budget in Phase 0, or exempt it explicitly.
  - Say how print composites overlay marks.
  - Name the R3 export subtype and appearance (for example, a `/Square` or `/FreeText` with an appearance stream, `/Subj (Bold)` and our custom key).

#### N6. "Ported exactly from the research prototype" is false; the filter rules are three-way inconsistent
- **Section:** Learning filter steps and weights (spec:252–279).
- **Problem:** The prototype that "scored 43 of 44" is `score_proto.py`. It has no hard block, no force-save, no MiniLM and no path score (`score_proto.py:53–119`). The TypeScript in 04:293–319 is untested pseudocode. The spec differs from both:
  - **Scans.** Three different rules. The script saves only if −1 + URL score ≥ 3, so arXiv's +3 alone does *not* save (`score_proto.py:64–66, 102`). Research prose saves only if URL ≥ +2 **and** DiT p ≥ 0.7, asks at ≥ +1, and otherwise forgets (04:285–289). The spec saves scans "only from scholarly sites or course pages; otherwise the chip asks" (spec:259). The spec auto-saves any image-only PDF from Moodle or JSTOR with no content check at all.
  - **Override.** The spec uses "a score of 8 or more" (spec:255). The research uses positive-only evidence ≥ 8 (04:283, 04:314).
  - **Sensitive ids.** SSN and UTR are dropped (04:280 vs spec:255).
  - **arXiv weight.** "+4 (file name +3)" (spec:265) matches neither the script (+4 for either) nor the prose (+3 path, additive with +4 text).
  - **Order.** Step 2 needs the score that step 4 computes, yet the list says "stop at the first that decides" (spec:252).
  - **Text source.** Expected outputs came from pdftotext text. PDFium's line breaks differ, and the References regex is line-anchored (`score_proto.py:33`), so "expected outputs become the test" may not reproduce.
- **Fix:**
  - Write one normative TypeScript reference with test vectors in `packages/core`, and drop the word "exactly".
  - Choose the scan rule. Without DiT: URL ≥ +2 → ask, never auto-save.
  - State "positive-only evidence ≥ 8" and the full id list.
  - Compute the score, then apply the hard rules.
  - Regenerate expected outputs with PDFium text and list any decision that changes.

#### N7. Form-PDF routing is undefined and, read literally, sends most papers to Chrome's viewer
- **Section:** Criterion 1 (spec:15); Requirements (spec:37); Forms (spec:179).
- **Problem:**
  - **The rule is undefined.** "PDFs with fillable forms stay in Chrome's viewer." Research warns: "AcroForm on its own is not a signal. hyperref adds AcroForm to LaTeX papers: NBER, LSE CEP, Nature and MIT 6.006 were all AcroForm" (04:239). If the check is "has /AcroForm", four of the 22 learning fixtures bounce out and are never saved, which breaks criterion 4.
  - **The bounce is unspecified.** Detection needs our viewer to fetch and parse first (DNR redirects on headers alone). The bounce then needs an allow rule plus a third GET, which fails on expiring links.
  - **Classification of bounced PDFs is unstated.** It is not said whether a bounced *learning* PDF (a worksheet with fillable boxes) is classified and saved first.
- **Fix:**
  - Define "fillable" as at least one widget of type Tx, Ch, or a non-pushbutton Btn that is referenced from `/AcroForm /Fields`, or XFA.
  - Run the filter and save before bouncing.
  - Specify the bounce: a session allow rule for that URL and tab, then reload. If the re-fetch fails, keep our view with a banner.
  - Add the four hyperref fixtures as must-stay tests.

#### N8. Release 1's only backup has no restore, and its automation is unverified
- **Section:** Criterion 8 (spec:23); Backups (spec:318); Restore (spec:329); Risks (spec:501).
- **Problem:**
  - **No restore in R1.** Restore exists only in R2 ("sign in once and the library downloads", spec:329). Risks counts the folder as the R1 mitigation for "Removing the extension deletes local data" (spec:501), yet nothing reads the folder back. After a profile reset, the user keeps Markdown and PDFs but not a library.
  - **"Every night" is doubtful.** After a restart, `queryPermission()` usually reports "prompt" and `requestPermission()` needs a click (03:97). Whether extension origins get "Allow on every visit" is [U], with "re-prompts every session" reported (03:98). The offscreen page cannot prompt. Writing to Drive-for-desktop's virtual drive is [U] (03:130), yet the spec recommends "a folder … inside Google Drive for desktop" (spec:318). So backups likely pause after every Chrome restart until a click.
  - **Phase 0 doesn't test it.**
- **Fix:**
  - Add "Restore from backup folder" to Phase 3: idempotent, merging by fingerprint and record id, with a versioned JSON schema and an E2E test (back up → wipe profile → restore → identical notes).
  - Test FSA grant persistence from the offscreen page on Windows Chrome, and writes to Drive's G: drive, in Phase 0.
  - Reword criterion 8 to: written automatically while the folder is connected, badge when it is not, restore brings everything back.

#### N9. Backup contents are unspecified and can leak the API key, the sync token and pending notes to a cloud-synced folder
- **Section:** Database tables (spec:313); Backups (spec:318); Claude key (spec:342); Extension sign-in (spec:374); egress table (spec:283–289).
- **Problem:**
  - **What's at risk.** The database holds "settings, pending notes" (spec:313). The API key and sync token sit in "the extension's private database" (spec:342, 374).
  - **Where it goes.** The backup writes "the data as JSON" to a folder suggested to be in Google Drive or OneDrive (spec:318). A straight dump sends the Anthropic key, the cloud refresh token and quotes from bank-statement notes to Google or Microsoft.
  - **Missing from the egress table.** It has no backup-folder row.
- **Fix:**
  - Keep secrets in a separate store that backup, export and sync never read, and add a test that greps backup output for the key.
  - Exclude the pending table and the never-save list from backups.
  - Add an egress row: "Backup folder → wherever that folder syncs → saved learning PDFs and their notes only".

#### N10. The pending area and private test set contradict the fixed privacy decision and the spec's own trace list
- **Section:** Requirements (spec:41); Local traces (spec:291); Notes on unsaved PDFs (spec:296); Tests (spec:305).
- **Problem:** The user's decision (b) is that nothing is stored for non-learning PDFs. The spec says "Non-learning PDFs leave no trace" (spec:41) and lists "Two exceptions" (spec:291). Yet:
  - **Pending marks.** These store the fingerprint, the exact quote and 32 characters either side (spec:155) from a receipt or statement for 7 days (spec:296). That is a third trace, outside the list, and the notes then expire silently.
  - **Private test set.** "A PDF you report as misjudged joins a private test set that stays on your computer" (spec:305) keeps whole copies of wrongly saved private PDFs, a fourth trace. That conflicts with "Forget this PDF removes it completely" (spec:302).
- **Fix:** Put the trade-off to the user:
  - Either keep the pending area, disclose it in spec:41 and spec:291, and warn before expiry;
  - or make the first mark on a not-learning PDF ask "Save this PDF to keep your notes?", keeping the notes in memory until the user answers.

  For the test set, store only the user's label and a salted hash (or derived features), never the file.

#### N11. "Matched by physical position" breaks letter shortcuts on German QWERTZ
- **Section:** Shortcuts (spec:185, 187–206); hand checks (spec:459).
- **Problem:** "Keys are matched by physical position, so Alt+Shift+5 works on any layout" (spec:185) reads as a blanket rule. On German QWERTZ:
  - The key labelled Z reports `code: "KeyY"` and the reverse **[reviewer knowledge]**, so pressing labelled Ctrl+Z redoes and labelled Ctrl+Y undoes.
  - Ctrl+= (Equal code) is the ´ key, while German users zoom with Ctrl++ (code BracketRight).
  - Ctrl+[ / Ctrl+] need AltGr.
  - "?" is on another key.

  German is one of the three layouts in the hand check (spec:459).
- **Fix:**
  - Match letters and punctuation by `e.key`. Fall back to `e.code` only when `e.key` is not Latin (Cyrillic) or AltGr changed it.
  - Use `e.code` only for the digit row (Alt+Shift+5, 1–5).
  - Accept Ctrl+= and Ctrl++ for zoom.
  - Add Playwright tests that send layout-specific `key`/`code` pairs for UK, US, German and Polish.

#### N12. Phases, gates and hand checks don't line up with the features
- **Section:** Gauntlet gates (spec:445); hand checks (spec:459); phase diagram (spec:469–473).
- **Problem:**
  1. **The layout check comes too early.** "keyboard layouts (UK, US, German) on your PC after Phase 1" (spec:459; gate g1, spec:469). But Ctrl+Alt+M, Ctrl+B/U and Alt+Shift+5 are built in Phase 2 (spec:470), so the only check of the top shortcut risk (AltGr) runs before the shortcuts exist.
  2. **One gate list for every task.** It includes "the 44-PDF filter test" and a network test "during the filter run" (spec:445), but the filter is Phase 3. Tasks in Phases 0–2 cannot pass it as written.
  3. **Marks are stored before the filter exists.** Phase 2 persists marks before Phase 3 decides what may be stored. So the C3 fix (first mark saves; pending area) and a crash test on an *unsaved* PDF cannot be tested until Phase 3, and Phase 2 must store marks for every PDF.
- **Fix:**
  - Give each phase its own gate list.
  - Move the layout check to after Phase 2, and repeat it at Phase 4.
  - Build the decision states in Phase 1, with a stub classifier (everything is "not sure", so the first mark saves).
  - Run the crash test on a saved, a not-sure and a not-learning PDF.

#### N13. The nightly D1 snapshot (and the pre-deploy snapshot) cannot run as described (Release 2)
- **Section:** Cloud backup (spec:381); Deploys (spec:375).
- **Problem:**
  - **The export tool fails.** `wrangler d1 export` "does not support DBs that contain virtual tables" (05:110). `sop_meta` has `annotation_fts` and `doc_fts` (05:733–759), and the text shards have `page_fts` (05:798).
  - **A Worker cron is too small.** On the free plan it has the same 10 ms CPU limit **[reviewer knowledge]**, far too little to serialise tens of MB.
  - **Deploys depend on it.** Production updates are gated on "a database snapshot", which has no defined mechanism.
- **Fix:**
  - Run a nightly GitHub Actions job that pages through an authenticated `/api/admin/export?table=&after=` endpoint (each page inside the CPU budget), skips the FTS tables (they can be rebuilt), and writes JSON to R2 with 30-day lifecycle rules.
  - Before each production migration, record a D1 Time Travel bookmark (7 days on Free, 05:117) as the restore point.

#### N14. Staging shares production's account-wide free quotas and has no OAuth app (Release 2)
- **Section:** Deploys (spec:375); Sync rules (spec:326); Setup (spec:529–531).
- **Problem:**
  - **Shared quotas.** D1's free limits (100k rows written per day, 5 GB, about 10 databases) and Workers' 100k requests per day are per account **[reviewer knowledge; 05:116 lists them as account quotas]**. Since 2026-09-01, D1 queries *fail* after the cap (05:116). A staging backfill test can therefore stop production note sync for the rest of the day.
  - **The meter can't see staging.** "The server counts its daily database writes … so your notes always sync first" (spec:326) counts only its own writes.
  - **No staging OAuth app.** Staging needs its own GitHub OAuth App (a different callback URL), but setup creates one (spec:529).
- **Fix:**
  - Give staging a hard write budget (for example 10k per day) and lower production's meter to match (for example 75k).
  - Use small fixture libraries in staging.
  - Budget the database count (production 1 + N shards, staging 1 + 1).
  - Add a second OAuth App and its secrets to setup.

### Minor

1. **R1/R2 tagging.** The Settings row is tagged Release 1 but includes "cloud" (spec:243). The Architecture library list includes Courses (R3) and omits Settings (spec:98). **Fix:** tag "cloud" R2 and fix the list.
2. **Rule 2 and walkthrough 9 have no release tag**, while the Summary says "Release 3 adds … version linking" (spec:11). A build agent may put same-link versions in Phase 8. **Fix:** tag both R1, and call R3 "cross-link version linking".
3. **Page note vs pointer note.** "With nothing selected, Ctrl+Alt+M makes a note for the page" (spec:62) contradicts "a note at the pointer if it is over a page" (spec:164). **Fix:** use one wording.
4. **The 1 GB limit is untested.** "Up to 1 GB opens normally" (spec:182), but Phase 0 tests 300 MB (spec:486). The wasm heap alone is "risky above about 1 GB" (01:116), before the JS copy, hashing and OPFS write. How the size is known before loading is unstated. **Fix:** test the limit in Phase 0 and use Content-Length.
5. **Range loading on the web.** "large PDFs load from R2 in ranges" (spec:377), but EmbedPDF reads the whole file into wasm (01:116; 05:335). **Fix:** say "with a progress bar", or limit range loading to the pdf.js fallback.
6. **@Claude on R1 scans** (no text) and on area marks (no quote) is undefined. For long PDFs not in the library, "most relevant pages found by local search" (spec:338) has no index, because unsaved PDFs are never indexed (spec:291). **Fix:** send cropped page images for area marks and scans, and use an in-memory index for unsaved PDFs.
7. **Shortcut gaps.**
   - "Undo / redo … Anywhere" (spec:197) overrides native undo in the note editor.
   - Ctrl+U inside the editor is undefined.
   - "Enter selects the match" (spec:142) collides with Enter as next match in Find (spec:175), and the next/previous keys are unstated.
   - Ctrl+G is Chrome's find-next convention.

   **Fix:** use the editor's own undo while typing; use Enter / Shift+Enter for next/previous and Alt+Enter to select the match; leave Ctrl+U to the browser inside the editor.
8. **Password PDFs.** "The library keeps the encrypted original" (spec:178), but page text is stored in plaintext in local FTS and, from R2, in D1. **Fix:** state this, or skip indexing for encrypted PDFs.
9. **Polish** is in the Risks row (spec:506) but missing from the hand check (spec:459).
10. **Setup wording.** "No new accounts" (spec:514), but @Claude needs an Anthropic console account (spec:523). "you chose the account already connected to this session" (spec:527) is a leftover from this conversation, not a build instruction.
11. **Incognito marks are unspecified.** If allowed, they are memory-only, which breaks criterion 3's crash promise there (spec:17). **Fix:** "no marks in Incognito", or disclose that they are lost.
12. **Minimum Chrome version.** Chrome 128 is needed for DNR response-header conditions (03:45) and is not stated. **Fix:** set `minimum_chrome_version`.
13. **Embedded PDFs: inline or full tab?** It is unstated whether embeds are replaced inline (an iframe, as pdf.js does, 03:48–49) or open in the full tab (spec:15 says "in the same tab"). An inline viewer must be web-accessible, so any site can frame it. **Fix:** require a click before Save or Ask Claude inside a framed viewer, or open embeds full-tab.
14. **Workers Paid.** "Workers Paid ($5 a month) lifts all three limits" (spec:389). R2 storage is billed separately and is not lifted by Workers Paid **[reviewer knowledge]**.
15. **Network test scope.** "a build test fails on any other request" (spec:289), but the gate checks only "during the filter run" (spec:445). **Fix:** apply it to the whole E2E run.
16. **Criterion 4 is too narrow.** It and the Tests paragraph fail only on "receipts, invoices or statements" (spec:18, 305). Saved payslips, tax forms, tickets and boarding passes in the set would pass. **Fix:** "zero non-learning PDFs".
17. **Allow lists beat the hard block.** Domain allow lists rank above it (spec:254–255) and are "pre-filled with suggestions" (spec:303), so a card-number PDF on an allow-listed Moodle is saved. **Fix:** only per-file choices override the hard block, and suggestions are opt-in.
18. **Alt+drag.** Alt+click on a link downloads it in Chrome **[reviewer knowledge]**, and an area mark has no keyboard path, against "nothing needs the mouse" (spec:142). **Fix:** suppress links during Alt+drag, and add a keyboard area mode or narrow the claim.
19. **The source of truth is unclear.** "Canonical, commentable version: https://claude.ai/artifact/… This file is an export … keep it in sync" (spec:1). Build agents need to know which copy wins if the two diverge. **Fix:** name the repo file as normative for builds.

---

## Is Release 1 a coherent, buildable, testable unit?

- **Independence from R2/R3:** yes, apart from two leftovers: the Settings "cloud" item (m1), and restore, which exists only in R2 while R1's backup is the only protection (N8).
- **Buildable without guessing:** no. Agents would have to guess identity under stamped or Moodle links (N1, N2), comment toggle and split rules (N4), bold rendering (N5), the filter rules and the scan path (N6), form routing (N7), shortcut matching (N11), and what the backup contains (N9).
- **Testable:** not yet. The filter gate cannot run in CI under the licence rule (M11). Gates are not per phase (N12). The reference laptop is undefined (M16).

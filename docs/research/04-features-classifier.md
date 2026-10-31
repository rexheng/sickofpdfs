# 04: Feature teardown and learning-relevance filter

**Status:** research only, no product code. Prepared 31 Oct 2026.
**Scope:** (A) how 13 readers and annotators handle commenting, history and libraries, turned into a v1 spec for "seamless commenting + automatic reading history". (B) a filter that saves only PDFs relevant to learning, checked against 44 public PDFs downloaded for this purpose.

**Confidence.** Claims marked *(verified)* come from the vendor's own docs or a reputable changelog fetched during this research. Claims marked *(reported)* come from news or third-party coverage. Claims marked *(unverified)* are my best knowledge and were not confirmed. The official Windows Foxit **Reader** shortcut list could not be found online. Foxit's Windows **Editor** docs and Mac Reader docs were used instead, and Help › Keyboard Mapping in the installed app is the authority.

---

## TL;DR

1. **No reader the user has today does "select → shortcut → type → Enter".** Chrome (v145, Feb 2026) added Highlight and Note tools behind a pencil mode, with no shortcut and no notes list. Drive's web viewer has area comments but no text highlighting. Foxit and Acrobat need a tool mode or a sticky-note click. Only Google Docs (and Word) own **Ctrl+Alt+M**. Zotero is the closest PDF reader: **Ctrl+Alt+3** makes a note from the selection, but the comment is typed in a sidebar card. Hypothesis (`a`) and Readwise (`N`) are keyboard-friendly, but both are cloud-bound.
2. **History is the bigger gap.** Foxit, Chrome, Acrobat, Drive, PDF Expert and Highlights keep, at most, a list of recent files. Only Sioyek (`O`, a searchable list of recent docs plus cross-document location history) and Zotero/Readwise (full libraries, which need manual import or a cloud account) come close. Nobody builds the history automatically **and** filters out non-learning PDFs.
3. **Storage:** keep annotations in a local **sidecar database keyed by content hash**, as Zotero and Sioyek do. Write into the PDF only on explicit export. Writing into the user's file (Foxit, Acrobat, PDF Expert, Chrome) causes sync conflicts, duplicate "paper (1).pdf" copies, and lost notes when the file is re-downloaded.
4. **Classifier result on 44 public fixtures:** a hand-weighted heuristic score using content and PDF metadata only made **43/44 correct decisions with 1 "ambiguous" and 0 false saves**. Three local models were tested as tie-breakers:
   - MiniLM embedding prototypes: 37/41 (20 ms/doc).
   - DiT RVL-CDIP page-image classifier: 38/44 (0.17 s/page). It works on scans but made 2 false positives.
   - MobileBERT-MNLI zero-shot: 31/41. It is biased toward "invoice" on academic first pages, so it is **not recommended**.
   Recommendation: heuristics first, then local embeddings (DiT for PDFs with no text layer), then **ask the user**. A cloud LLM is opt-in only and receives only redacted excerpts.
5. **Shortcut rule:** keep Ctrl+Alt+M because Docs and Word users already know it. Never let a Ctrl+Alt shortcut fire while a text field has focus, because on German, Polish and other layouts Ctrl+Alt = AltGr (German AltGr+M = µ). Avoid Ctrl+Alt+arrows and Ctrl+Alt+F-keys (Intel graphics hotkeys) and bare Ctrl+Shift / Alt+Shift (input-language switch).

---

# Part A: Feature teardown

## A.1 Creation and comment UI

| Product | Create highlight | Create comment / note | Comment UI | Threads | Colours |
|---|---|---|---|---|---|
| **Foxit PDF Reader** | Comment tab › Highlight. In the Windows Editor docs: **Shift+H**. The Mac Reader uses single-key `U` *(verified, Mac/Editor docs)* | Note tool: Editor **Ctrl+Shift+N**, Mac Reader **Ctrl+N**, single key `S` once accelerators are enabled. Typewriter: **Shift+T** (Editor) | Pop-up note on the page plus a Comments panel. In the panel, Tab/Shift+Tab move between comments, Enter opens the pop-up and Esc closes it *(verified)* | Replies in the panel (Ctrl+Enter submits), status, filters by author, status and type *(verified, Editor docs)* | Palette: Shift+1…0 picks colours 1–10, Shift+L switches colour *(verified, Editor)* |
| **Chrome PDF viewer** (Chrome 145, Feb 2026) | Pencil icon › **Highlight** › drag over text, yellow by default *(reported)* | Pencil › **Note** › click a spot › type › click outside *(reported)* | Box on the page. Clicking a mark shows a small colour picker and delete *(reported)* | None | Small picker |
| **Google Drive PDF viewer (web)** | No web highlighting. Android-only pen and highlighter (4 colours each) *(reported, 2023)* | **Add comment** icon › select area › type › Comment *(verified)* | Docs-style cards on the right | Replies and resolve (Drive comment model) | n/a |
| **Adobe Acrobat** | Highlight tool. Single key `U` (Shift+U cycles highlight/underline/strike) once accelerators are enabled *(verified)* | Comment tool `S`. Tab/Shift+Tab next/previous comment, Enter opens the pop-up *(verified)* | Pop-up notes plus a right-hand **Comments** pane | Replies, status (Accepted/Rejected…), checkmarks. List sortable by page, author, date, type, colour *(verified)* | Per comment, with colour filter |
| **Zotero 7 → 9** | Select text and a colour popup appears ("unlocked mode"). **Ctrl+Alt+1** highlights the selection, Ctrl+Alt+2 underlines *(verified)* | **Ctrl+Alt+3** makes a note from the selection. Alt+3 is the note tool. The comment is typed into the annotation card in the sidebar | Left sidebar of annotation cards (quote, comment, tags) plus a notes pane. Zotero 8 lists annotations under items in the library *(verified)* | None (group libraries show the author) | **8 colours**. Keys 1–8 pick a colour while a tool is active, Alt+8 cycles. Users complain colours reset to yellow *(verified forum)* |
| **Readwise Reader** | Selecting text **auto-highlights** it (Shift+H toggles, Alt+select overrides). `H` highlights the focused paragraph. The keyboard only works at paragraph level *(verified)* | Select a highlight › **N** note (Enter saves, Shift+Enter newline), **T** tag. Shift+N opens the document notebook *(verified)* | Notes in the **right margin** on wide screens, plus a Notebook tab | None | **One colour**. Tags replace colours *(verified)* |
| **Hypothesis** | Select text › "Highlight" in the adder popover, or **h** *(verified)* | Select › "Annotate", or **a**. Focus jumps to the sidebar editor. **Ctrl+Enter** posts, Esc closes the adder *(verified)* | Right sidebar of cards, Markdown | Threaded replies, groups (private/public), tags. Shortcuts customisable since Apr 2026 *(verified)* | One colour |
| **LiquidText** | Select and highlight, or drag an excerpt into the workspace canvas | Margin comments, including **one comment on two or more selections** *(reported, App Store)* | Margin plus an infinite workspace, ink links across documents | Basic collaboration (1 collaborator) | Several |
| **MarginNote 4** | Select › the excerpt becomes a **card** | Comment on the card | Mind map + outline + cards. FSRS flashcards, export to Anki *(reported)* | None | Per card |
| **Sioyek** | Select › **h + letter** (26 highlight types = colours) *(verified)* | `b` bookmark with text. Marks `m`+letter. **Portals** `p` link two locations | Minimal. Lists via `gh`/`gb` | None | 26 types (a–z) |
| **PDF Expert (Mac)** | Annotate tab › Highlight/Underline/Strike. Shortcuts are set by the user in macOS App Shortcuts *(verified)* | Text comments, pop-up notes | Annotation-summary sidebar | (unverified) | Presets |
| **Highlights (Mac/iOS)** | Select › highlight/underline/strike | Comment on any annotation, plus sticky notes | Notes sidebar, sorted by page or colour | None | Default colour per type |
| **Google Docs comments** | n/a | Select › **Ctrl+Alt+M** › type › Comment (Ctrl+Enter) *(verified)* | Cards in the right margin, anchored to the text | Replies, @-mention/assign, resolve, reactions. **Ctrl+Alt+Shift+A** opens the thread. Ctrl+Alt+**N**,**C** / **P**,**C** go to next/previous comment; **E**,**C** enters the current one *(verified)* | None |

## A.2 Search, export, storage, history, library, AI

| Product | Search across notes | Export | Where annotations live | History / recents | Library | AI |
|---|---|---|---|---|---|---|
| Foxit | Comments panel filter, Search panel (Ctrl+Shift+F) | **Export all comments** (FDF/XFDF) Ctrl+L, **Export highlighted text** Ctrl+I, Summarize comments *(verified, Editor)* | **Inside the PDF** | Recent-files list only | None (file based) | Foxit AI Assistant (subscription releases) *(verified)* |
| Chrome viewer | None | Download (marks saved into the copy) or **Save to Google Drive** (goes to a "Saved from Chrome" folder) *(reported)* | In the downloaded or saved copy | Browser History shows the PDF URL, no notes | None | **Gemini "Summarize" button** in the PDF toolbar (stable v150) plus follow-up questions *(reported)* |
| Drive viewer | (unverified) | Comments stay in Drive. They "can show up in some PDF-viewing apps" *(verified)* | **Drive server**. Re-uploading a version can replace or remove comments *(verified)* | Drive Recents | Drive folders | Gemini side panel (summaries, Q&A) since 2024. New viewer with outline and thumbnails, late 2025 *(verified/reported)* |
| Acrobat | Comments pane search, filter, sort | **FDF** data file, comment summary PDF. Exporting only selected comments is not in Reader *(reported)* | **Inside the PDF** | Recent files | Acrobat cloud | AI Assistant (paid add-on). Cannot create comments *(reported)* |
| Zotero | **Zotero 8**: Advanced Search on annotation text and comment, tags, annotations in the items list *(verified)* | "Add note from annotations" (citations included). **Save As / Export PDF** embeds annotations. **Import Annotations** pulls in external ones *(verified)* | **Zotero SQLite DB, not the PDF**, deliberately: conflict-free sync, tagging, filtering *(verified)* | Remembers reading position; tabs | Full reference manager (collections, tags, metadata) | None built in |
| Readwise Reader | By tag in the notebook view; Readwise search | Markdown with an editable export template; Readwise sync to Obsidian, Notion and others *(verified)* | Readwise cloud | Library: Inbox / Later / Archive, plus reading progress | Library + Feed + tags | **Ghostreader** (define, summarise, Q&A, custom prompts) |
| Hypothesis | Sidebar search `/` | Export (JSON and other formats) *(unverified detail)* | Hypothesis server. Anchored by URL / **PDF fingerprint** plus text quote | Activity page | Groups, tags | None core |
| LiquidText | Keyword search across project documents *(reported)* | PDF with notes, outline *(unverified)* | Proprietary project | Projects | Projects | "AI tools", credit-based *(reported)* |
| MarginNote 4 | Within notebooks | Markdown, OPML, Anki *(reported)* | Notebook DB plus iCloud | Study sets | Study sets | AI in **v4.2 (Oct 2025)** *(verified)* |
| Sioyek | **`gh` in this doc / `gH` across all docs**, `gb`/`gB` for bookmarks *(verified)* | `export` to JSON. **`embed_annotations`** writes a PDF copy *(verified)* | **local.db + shared.db** SQLite *(verified)* | **`O` = searchable recent documents**. Back/forward location history *across* documents *(verified)* | None | None |
| PDF Expert | Annotation summary | **HTML / Text / Markdown** summary *(verified)* | Inside the PDF | Recents | File browser | (unverified) |
| Highlights | Notes list | Markdown, TextBundle, HTML, PDF. **Sidecar Markdown** next to the PDF. Sends to Obsidian, DEVONthink and others. **DOI metadata** fetch *(reported)* | In the PDF, plus an optional sidecar | File browser only | None | Apple Intelligence writing tools |
| Google Docs | Comment history | n/a | In the Doc | Docs recents | Drive | Gemini |

## A.3 What the teardown shows

- **The fastest flows are built on the selection plus a single key** (Hypothesis `a`/`h`, Readwise `N`, Sioyek `h`+letter, Zotero `Ctrl+Alt+1–5`). The slowest use tool modes (Foxit, Acrobat, Chrome's pencil mode, Zotero's locked mode).
- **Where the editor opens matters.** Hypothesis and Zotero move focus to a sidebar, so the eye leaves the passage. Google Docs and Readwise put the note in the margin next to the anchor, which feels most seamless.
- **Only Sioyek treats "where I was" as history across documents.** Only Zotero 8 and Sioyek search annotations across documents locally.
- **Every cloud tool (Drive, Readwise, Hypothesis) needs an account and uploads the document or its anchors.** None filters what gets ingested.

## A(i) The 15 features that matter most for a small v1 (ranked)

1. **Select → Ctrl+Alt+M → type → Enter** with no mouse. The editor opens **inline next to the selection** (margin popover, never over the passage). Each keystroke autosaves a draft.
2. **The same shortcut with no selection makes a page note** (or a point note at the mouse pointer). Ctrl+Alt+Shift+M makes a document-level note, so there is never a "nothing happened" case.
3. **Notes rail.** A right-hand list of every note in reading order. Clicking jumps to the passage, the passage and its card light up together, and the rail is searchable.
4. **Automatic reading history (the knowledge base).** For each learning PDF: title, authors, year, DOI/arXiv id, source URL, local path(s), content hash, first and last opened, total reading time, last position, pages visited, notes count. **Opening a document resumes where you left off.**
5. **One search box (Ctrl+K)** over titles, metadata, **full text** and notes. Results jump straight to the page and passage (combining Sioyek `gH` and Zotero 8 annotation search).
6. **Non-destructive, crash-safe storage.** A local SQLite sidecar keyed by SHA-256 of the file bytes plus the PDF `/ID`. The original file is never touched. **Export annotated copy** writes standard PDF annotations; **Import annotations** reads existing ones (Zotero's model).
7. **Learning-relevance gate** (Part B). A visible status chip ("Saved to library" / "Not saved: looks like an invoice") with one-click override. Privacy is a feature.
8. **Automatic metadata**, so the history shows "Callaway & Sant'Anna (2021), *Difference-in-Differences…*" and not `1803.09015v5.pdf`. Sources: XMP/Info dictionary, first-page parsing, arXiv/DOI ids, with optional online lookup by id only.
9. **Robust anchoring.** Store page quads **and** a text-quote selector (exact + prefix/suffix, as Hypothesis and the W3C Web Annotation model do). Notes then survive arXiv v1→v2 or a re-downloaded lecture deck.
10. **Dedupe by hash and id.** `paper.pdf`, `paper (1).pdf` and a Moodle re-download become one library entry with merged notes and path history.
11. **Highlight-only quick action** (`H` with a selection, or Ctrl+Alt+H) plus **a small palette (5 colours) whose meanings are fixed and editable** (for example yellow = key point, blue = definition, green = evidence, pink = question, grey = to-do). Keys 1–5 recolour. The last colour persists, unlike Zotero's reset to yellow.
12. **Jump between notes** (Ctrl+Alt+N / Ctrl+Alt+P; Tab/Shift+Tab when an annotation is focused) **plus back/forward location history** (Alt+← / Alt+→), so jumping never loses your place.
13. **Edit and delete with undo.** Enter/F2 edits, Delete removes, a toast offers Undo, Ctrl+Z works, and deleted items stay in a 30-day soft-delete trash.
14. **Markdown export** per document and for the whole library: quote, note, page, colour label and a deep link back (`app://open?doc=<hash>&page=12&anno=<id>`), plus "copy as citation". This is lock-in insurance, as in Highlights, PDF Expert and Readwise templates.
15. **Zero-effort organisation.** Automatic collections by source and course (Moodle course, module code such as `EC1A1` found in the URL, path or text, or the folder), plus star/pin. No folders to maintain.

**Deliberately not in v1:** threaded replies, statuses and @mentions (Acrobat/Docs review workflows), ink, mind maps, flashcards, cloud sync, AI chat. **v1.5 candidate:** local semantic search over notes. MiniLM ran at about 20 ms per passage on CPU in testing.

## A(ii) Interaction flow: "select text → Ctrl+Alt+M → type → Enter"

**Precondition.** The document viewer has focus and no text input is focused. While a text field has focus, all Ctrl+Alt shortcuts pass through untouched (AltGr safety).

### Case A: text is selected
1. **Keydown Ctrl+Alt+M.** Within one frame (under 50 ms), turn the selection into a *pending* highlight in the current "comment" colour. Text may span pages: store one annotation with quads per page, anchored to the first page.
2. **Open the inline editor** as a popover in the margin beside the end of the selection (right margin if it fits, otherwise below the line). It never covers the selected text. The editor shows a one-line truncated quote of the selection, has the caret focused, and has a placeholder ("Add a note… Enter to save, Shift+Enter for new line").
3. **Typing.** Plain text with light Markdown (`**bold**`, `*italic*`, lists, `` `code` ``, `$…$` rendered on save). The box grows to about 8 lines, then scrolls. The draft is saved to the DB on a 300 ms debounce, so a crash loses nothing.
4. **Enter** saves and closes. **Ctrl+Enter** also saves (Docs, Hypothesis and Foxit habit). **Shift+Enter** inserts a newline.
5. **Esc or a click outside:**
   - If the note is empty, cancel and remove the pending highlight.
   - If it has text, **save and close** (never throw away typed text), with a toast "Note saved · Undo".
6. **After saving**, focus returns to the document at the same scroll position and the selection clears. The highlight shows a small note glyph at the line end, the card appears in the rail (which flashes once if collapsed), and a screen reader hears "Note added, page 4".

### Case B: nothing is selected
- If the pointer is over a page, Ctrl+Alt+M creates a **point note at the pointer**. Otherwise it creates a **page note** pinned to the top margin of the most-visible page. The editor opens in the rail at that page's position, not over the text. Enter and Esc work the same way.
- **Ctrl+Alt+Shift+M** creates or opens the single **document note** ("my takeaways"), pinned at the top of the rail and shown in history and search.
- If the page has **no text layer** (a scan), Ctrl+Alt+M makes a page note. Alt+drag makes an area note (rectangle).

### Case C: the selection overlaps an existing highlight
- Ctrl+Alt+M **opens that annotation's note** (adding a note if it had none) instead of stacking a duplicate. If the selection extends past it, offer "Extend highlight?" inline (Enter = yes).

### Editing
- Click the highlight, its glyph or its rail card, or focus it with next/previous and press **Enter or F2**. The editor opens with the caret at the end. Double-click on a highlight also edits.
- With an annotation focused (not in the editor), **1–5** recolour and **Ctrl+Alt+M** adds or edits its note.

### Deleting
- With an annotation focused, **Delete or Backspace** removes the highlight and its note. A toast "Deleted · Undo" appears, and Ctrl+Z restores it. It goes to a 30-day soft-delete trash.
- Clearing all the text in the editor and pressing Enter **keeps the highlight and drops the note** (it becomes a plain highlight). Destroying a highlight is always a separate, explicit action.

### Jumping between notes
- **Ctrl+Alt+N / Ctrl+Alt+P**: next/previous note in reading order (page, then y, then x). Smooth-scroll it into view, flash it for 600 ms, and focus the annotation (not the editor).
  - Google Docs' chord **Ctrl+Alt+N, C** is tolerated: a C pressed while Ctrl+Alt are still held is ignored.
  - The list wraps around with a toast ("Back to first note").
- **Tab / Shift+Tab** while an annotation is focused (Acrobat/Foxit convention).
- **Alt+←** returns to where you were before any jump, including jumps across documents from search or history (Sioyek-style location stack). **Alt+→** goes forward.
- In the rail: ↑/↓ move between cards, Enter jumps and edits, `/` filters (Hypothesis habit).

**Latency budget.** Highlight visible in under 50 ms, editor visible in under 100 ms, local commit in under 50 ms. The editor is a real `<textarea>` or contenteditable with ARIA labels, and the rail is a listbox.

## A(iii) Keyboard map (Windows; on macOS Ctrl→⌘ unless noted, Ctrl+Alt→⌃⌥)

**Commenting and annotations**

| Action | Windows | macOS | Why / habit carried over | Conflict check |
|---|---|---|---|---|
| Comment on selection / page note | **Ctrl+Alt+M** | ⌘⌥M (Docs habit); alias ⌃⌥M | Google Docs and Word "insert comment" | AltGr: German AltGr+M = µ, so ignore while a text field is focused. macOS ⌘⌥M = "Minimise all" (the app menu overrides it). Not used by Windows, Chrome, Foxit or Acrobat |
| Document note | Ctrl+Alt+Shift+M | ⌃⌥⇧M | Extends the above | None found |
| Highlight selection (no note) | **H** (selection active) / Ctrl+Alt+H | H / ⌃⌥H | Hypothesis `h`, Sioyek `h` | Ctrl+Alt+H is free. Mac ⌘⌥H = Hide Others, hence ⌃⌥ |
| Note on selection (single key) | **N** (selection active) | N | Readwise `N` | Active only while a selection exists |
| Save note | **Enter** (also Ctrl+Enter) | ↩ (⌘↩) | Readwise / Docs / Hypothesis | — |
| New line in note | Shift+Enter | ⇧↩ | Readwise, Slack | — |
| Close editor (keeps text) | Esc / click outside | Esc | — | — |
| Edit focused annotation | Enter / F2 | ↩ | Acrobat/Foxit Enter opens the note; F2 = Windows rename | — |
| Recolour focused annotation | 1–5 | 1–5 | Zotero 1–8 | Only when an annotation is focused |
| Delete focused annotation | Delete / Backspace | ⌫ | Zotero | Undo available |
| Undo / redo | Ctrl+Z / Ctrl+Y or Ctrl+Shift+Z | ⌘Z / ⌘⇧Z | Universal | — |
| Next / previous note | **Ctrl+Alt+N / Ctrl+Alt+P** | ⌃⌥N / ⌃⌥P | Docs (Ctrl+Alt+N,C) | AltGr+N = ń (Polish): text fields excluded |
| Next / previous annotation (focused) | Tab / Shift+Tab | ⇥ / ⇧⇥ | Acrobat/Foxit | — |
| Toggle notes rail | **Shift+F4**; alias Ctrl+Alt+Shift+A | ⇧F4 / ⌃⌥⇧A | Acrobat task pane; Docs comment history | — |
| Toggle outline/thumbnails | F4 | F4 | Acrobat/Foxit navigation pane | — |
| Area note (scans/figures) | Alt+drag | ⌥drag | — | Alt-click alone is not bound |

**History, library, files**

| Action | Windows | macOS | Why | Conflict check |
|---|---|---|---|---|
| Reading history | **Ctrl+H** | **⌘Y** | Chrome History (Mac Chrome uses ⌘Y; ⌘H hides the app) | Foxit/Acrobat use Ctrl+H for Read Mode: an accepted habit clash |
| Go anywhere (docs, notes, commands) | **Ctrl+K** | ⌘K | Readwise, VS Code, Slack | Foxit Editor uses Ctrl+K for Preferences (minor) |
| Search whole library (full text + notes) | Ctrl+Shift+F | ⌘⇧F | Foxit search panel; Acrobat advanced search | — |
| Find in document / next / previous | Ctrl+F / F3 or Enter / Shift+F3 | ⌘F / ⌘G / ⌘⇧G | Universal | — |
| Go to page | Ctrl+G (alias Ctrl+Shift+N) | ⌘⌥G | Foxit (Acrobat alias); Zotero ⌘⌥G | Chrome Ctrl+G = find next (Enter covers it) |
| Back / forward (location) | **Alt+← / Alt+→**, mouse buttons 4/5 | ⌘[ / ⌘] | Acrobat/Foxit previous view, Chrome back | — |
| Open / close / reopen closed | Ctrl+O / Ctrl+W / **Ctrl+Shift+T** | ⌘O / ⌘W / ⌘⇧T | Chrome | — |
| Switch tabs | Ctrl+Tab, Ctrl+1–8, Ctrl+9 | ⌘1–9 | Chrome | — |
| Bookmark this page | Ctrl+D | ⌘D | Chrome bookmark habit | Foxit Ctrl+D = Doc properties (minor) |
| Save to library (override) | Ctrl+Alt+S, or click the status chip | ⌃⌥S | — | AltGr+S = ś (Polish): text fields excluded |
| **Forget this PDF** | **Ctrl+Shift+Delete** | ⌘⇧⌫ | Chrome "Clear browsing data" | — |
| Export notes (Markdown) | Ctrl+Shift+E | ⌘⇧E | — | None known |
| Shortcut sheet | ? and Ctrl+/ | ? | Readwise, Gmail | — |

**View:** Ctrl+= / Ctrl+− / Ctrl+0 (reset to fit width), Ctrl+wheel. Ctrl+] / Ctrl+[ rotate (Chrome PDF viewer patch). PgDn/PgUp, Space/Shift+Space, Home/End. F11 full screen.

**Never bind (reserved or fragile):**
- **Windows:** Win+anything. Alt+Tab, Alt+F4, Alt+Space. Bare Alt / F10 (menu bar). Shift+F10 / Menu key (context menu). Ctrl+Esc, Ctrl+Shift+Esc, Ctrl+Alt+Del, Ctrl+Alt+Tab. **Ctrl+Alt+↑↓←→ and Ctrl+Alt+F1–F12** (Intel graphics hotkeys on many laptops). **Alt+Shift and Ctrl+Shift pressed alone** (keyboard-layout switch). Ctrl+Space (IME toggle). Win+. (emoji), Win+Shift+S, Win+H, Win+V.
- **GPU and game overlays:** Alt+Z (NVIDIA), Alt+R (AMD), Win+G / Win+Alt+R (Xbox Game Bar).
- **Chrome reserved (habit and web-build safety):** Ctrl+T/N/Shift+N/W/Shift+W/L/E/J/Shift+B/Shift+O/U/Shift+I/Shift+J/Shift+C/Shift+M/Shift+A, F5/F6, **F7 (caret browsing)**, F12, Alt+F, Alt+Home.
- **Ctrl+Alt+letter must never fire inside a text field** (AltGr layouts). Single-key accelerators (H, N, 1–5, Tab) fire only when the document or an annotation has focus and no input is active.
- The Electron accelerator for Ctrl+Alt+M is `CommandOrControl+Alt+M`. Register it **in-window only, never as a global shortcut**.

## A(iv) Anti-patterns to avoid

1. **Tool modes.** "Pick the Highlight tool, then select" (Foxit, Acrobat, Chrome's pencil mode, Zotero locked mode) causes mode errors. Annotations should always work from a plain selection.
2. **Editors that cover the passage**, or sticky-note icons painted over text (Acrobat/Foxit pop-ups).
3. **Moving focus away from the text** to a distant sidebar for every note (Hypothesis, Zotero). Keep the editor next to the anchor; the rail is for reviewing.
4. **Losing typed text** on Esc or a click outside. Inconsistent Enter vs Ctrl+Enter submit rules (Docs posts with Ctrl+Enter, Readwise with Enter): accept both.
5. **Annotations that exist only until "Download"** (Chrome viewer) or that silently **modify the user's original file** (Foxit, Acrobat). Result: OneDrive/Dropbox conflicts, broken hashes, notes lost when the file is re-downloaded.
6. **Coordinate-only anchors** (notes drift after a new version) or **text-only anchors** (fail on repeated phrases or ligatures). Store both.
7. **Colour chaos.** Ten or more colours with no meaning, or colours that reset (Zotero forum complaint).
8. **Paragraph-only keyboard highlighting** (Readwise): imprecise for equations and definitions.
9. **Ctrl+Alt shortcuts that eat AltGr characters**, and single-key shortcuts active while typing.
10. **Account or cloud required** for basic notes (Drive, Readwise, Hypothesis). Uploading PDFs to cloud AI by default.
11. **History that logs everything** (receipts, bank statements), or history that needs manual import (Zotero, Readwise).
12. **A new library entry per download** (`paper (3).pdf`) instead of dedupe by hash or id.
13. **Burying or locking in notes.** Proprietary project formats (LiquidText, MarginNote), export hidden in menus. Provide Markdown and PDF export from day one.
14. **Over-building collaboration** (statuses, checkmarks, assignment) for a single-user v1.
15. **AI-first chrome**: summarise buttons and chat panels that crowd out reading. Telemetry that includes document titles or paths.

---

# Part B: Learning-relevance filter

## B.1 Pipeline (everything on-device, nothing persisted until "LEARNING")

```
open PDF ─► Stage 0 user rules (per-file decision, allow/deny domains & folders)  ─► decided?
         ─► Stage 1 cheap features (≤150 ms): source URL, path/filename, Info/XMP metadata,
              page count & geometry, form type, text of first 5 + last 5 pages
         ─► Stage 2 heuristic score S (weights below) + hard vetoes/allows
              S ≥ +3 → LEARNING · S ≤ 0 → NOT LEARNING · else AMBIGUOUS
         ─► Stage 3 (ambiguous only) local model: MiniLM prototype margin (text) or DiT page class (no text layer)
         ─► Stage 4 still ambiguous → ask user (non-modal); optional opt-in LLM on redacted excerpt
```

Until the decision is LEARNING, the document is just "open". It renders and can be read and annotated, but annotations stay in memory (see B.6).

## B.2 Signals

### Source URL
**Windows:** read the **Mark-of-the-Web** `Zone.Identifier` stream. Chrome and Edge write `HostUrl` and `ReferrerUrl` there (Wikipedia/Microsoft-sourced; Chrome substitutes `about:internet` for special schemes). **macOS:** read `kMDItemWhereFroms` (unverified detail). Browser extension or "open with" hand-off can come later.

| Signal | Examples | Weight |
|---|---|---|
| Scholarly host | arxiv.org, doi.org, jstor.org, ssrn.com, nber.org, openreview.net, aclanthology.org, semanticscholar.org, link.springer.com, sciencedirect.com, onlinelibrary.wiley.com, tandfonline.com, academic.oup.com, cambridge.org, nature.com, science.org, pnas.org, plos.org, frontiersin.org, mdpi.com, biorxiv/medrxiv.org, osf.io, core.ac.uk, europepmc.org, ncbi.nlm.nih.gov/pmc, ideas.repec.org, econstor.eu, cepr.org, imf.org, worldbank.org, oecd.org, bis.org, ecb.europa.eu, federalreserve.gov, ipcc.ch, ifs.org.uk, ocw.mit.edu, openstax.org, libretexts.org, ieee.org, acm.org | **+3** |
| LMS / reading list / lecture capture | moodle.* or `/moodle/` (e.g. moodle.lse.ac.uk), *.instructure.com (Canvas), blackboard, brightspace/d2l, Talis Aspire reading lists, panopto, echo360 | **+2** |
| Academic TLD | *.ac.uk (lse.ac.uk, researchonline.lse.ac.uk, cep.lse.ac.uk, etheses.lse.ac.uk), *.edu, *.ac.xx, uni-*.de; EZproxy-rewritten hosts (`www-jstor-org.<proxy>.ac.uk`) | **+1 only**: universities also serve payslips, fee invoices and tenancy contracts (fixture: IUP pay statement on .edu) |
| Negative host | banks (hsbc, barclays, lloydsbank, natwest, santander, monzo, revolut, chase…), paypal, stripe.com (invoice.stripe.com), amazon.*/orders, uber, deliveroo, airlines, trainline, nationalrail, eventbrite, ticketmaster, irs.gov, hmrc / gov.uk tax pages, docusign, Dropbox Sign, Adobe Sign, utility suppliers | **−4** |
| Negative path token | `/invoice`, `/receipt`, `/billing`, `/statement`, `/payslip`, `/payroll`, `/finance/`, `/fees/`, `/accommodation/`, `/ticket`, `/boarding`, `/order`, `/forms/`, `/tenancy`, `/contract` | **−2** |
| Mail attachment / unknown | mail.google.com attachment, file://, no MOTW | 0 |

### Local path and filename (weak)
- **+1:** folder or file names with lecture, week, reading(s), seminar, problem set / ps\d, slides, chapter / ch\d, notes, module codes (`[A-Z]{2}\d[A-Z]\d`, e.g. EC1A1), Zotero storage, "OneDrive - LSE".
- **+3:** an arXiv-id filename (`\d{4}\.\d{4,5}(v\d)?\.pdf`).
- **−2:** invoice, receipt, statement, estatement, payslip, P60, P45, tax, e-ticket, boarding, booking, order, contract, tenancy, or a folder named Receipts/Bank/Tax.

### PDF metadata (observed on the fixtures)
- **LaTeX producer** (pdfTeX/XeTeX/LuaTeX, "LaTeX with hyperref") → **+1.5**. It appeared on 15 of 22 learning fixtures and 0 of 22 non-learning ones.
- **Generator producers** → **−1** (all seen on invoices or tickets): wkhtmltopdf, Apache FOP, iText, TCPDF, FPDF, ReportLab, JasperReports, Crystal Reports, MS Reporting Services, BI Publisher, Antenna House XSL Formatter, Odoo, "Sliced Invoices", PyPDF2.
- **XFA forms** (IRS W-9, W-2, 1040) → **−2**.
- **AcroForm on its own is not a signal.** hyperref adds AcroForm to LaTeX papers: NBER, LSE CEP, Nature and MIT 6.006 were all AcroForm.
- XMP `prism:doi` / `dc:identifier` DOI or arXiv → treat like the text DOI/arXiv signals. Scanner producers (ScanSnap, "Notes", CamScanner, Adobe Scan) → route to the no-text path.

### Structure and layout
- **Pages:** ≥100 → +2.5, ≥30 → +2, ≥8 → +1, ≤2 → −1.
- **Receipt-roll geometry** (width < 300 pt or height/width > 2.2) → −2.
- **Landscape deck** (16:9 or 4:3 and ≥10 pages) → +1.

### Text heuristics (first 5 + last 5 pages; regexes in `score_proto.py`)
**Positive:**
- arXiv id → +4.
- DOI → +2.
- ISBN → +1.5.
- `Abstract` / `Executive summary` heading on pages 1–2 → +2. Do **not** use "Summary": invoices and statements say "Account summary".
- `References` / `Bibliography` / `Works cited` heading → +2.5.
- `Chapter n` / `Contents` / `Lecture n` / `Week n` → +1.5.
- Thesis phrases ("submitted in partial fulfilment", "Doctor of Philosophy") → +2.
- Citation markers (`[12]`, `(Smith et al., 2019)`, `et al.`): ≥5 → +1.5, ≥20 → +2.5.
- Academic vocabulary (theorem, lemma, proof, definition, exercise, regression, hypothesis, "in this paper", solution, learning objectives…), per 1,000 words: ≥3 → +1, ≥8 → +2.
- Math-symbol density (=, ∑, ∫, ≤, Greek letters…): ≥0.5 % of characters → +1, ≥1.5 % → +1.5.

**Negative:**
- Count **distinct admin term groups**, −1 each, capped at −5. The groups are multilingual:
  - invoice/receipt/bill to/ship to
  - invoice/order/account/booking number
  - amount/balance due
  - subtotal
  - payment method
  - card ending / Visa / Mastercard
  - VAT/GST/TVA/MwSt/USt/BTW/IVA
  - Rechnung/Facture/Factuur/Quittung/Fahrkarte/Beleg
  - boarding pass/gate/seat/flight/PNR/e-ticket
  - statement date/sort code/IBAN/BIC/opening & closing balance/direct debit
  - payslip/net pay/gross pay/deductions/National Insurance/tax code/PAYE/YTD
  - OMB No./Internal Revenue Service/HMRC/Self Assessment/UTR/taxpayer
  - landlord/tenant/hereinafter/the parties/terms and conditions/signature of
- **Currency-amount density** per 1,000 words: ≥5 → −1, ≥15 → −2, ≥30 → −3. Economics problem sets with "$ per gallon" stayed below 5.

### Hard rules (applied after S is computed)
- **Veto (forces NOT LEARNING unless the user allows it):**
  - a Luhn-valid card number
  - an IBAN, or a UK sort code plus 8-digit account number
  - a NI number, SSN or UTR
  - a passport MRZ line
  - an IATA BCBP barcode string (`^M1[A-Z/ ]{20}`)
  - ≥2 of the above, unless positive-only evidence is ≥ 8 (for example an arXiv paper that quotes an example IBAN)
- **Allow:** an arXiv id plus a References heading; or a DOI plus an Abstract plus References; or a user allow-rule.
- **No text layer** (fewer than 15 words in the sampled pages):
  - Save only if the URL score is ≥ +2 **and** DiT says scientific publication, scientific report or presentation with p ≥ 0.7. Then queue OCR.
  - If the URL score is ≥ +1, ask.
  - Otherwise forget.

## B.3 Scoring function

```ts
// S = bias + Σ wᵢ·fᵢ   (bias = −1: an unknown PDF is not saved without evidence)
type Decision = "LEARNING" | "NOT_LEARNING" | "AMBIGUOUS";
function decide(f: Features, rules: UserRules): {decision: Decision; S: number; reasons: string[]} {
  const r = rules.match(f);                       // per-file > folder/domain allow/deny
  if (r) return r;
  if (f.words < 15) return noTextPath(f);         // DiT + URL, see hard rules
  let S = -1, pos = 0; const why: string[] = [];
  const add = (w: number, tag: string) => { S += w; if (w > 0) pos += w; why.push(`${tag} ${w > 0 ? "+" : ""}${w}`); };
  if (f.arxivId) add(4, "arXiv id");          if (f.doi) add(2, "DOI");          if (f.isbn) add(1.5, "ISBN");
  if (f.abstractHead) add(2, "Abstract");     if (f.refsHead) add(2.5, "References");
  if (f.chapterOrLecture) add(1.5, "Chapter/Lecture/Contents");                 if (f.thesis) add(2, "Thesis");
  add(f.citations >= 20 ? 2.5 : f.citations >= 5 ? 1.5 : 0, "citations");
  add(f.acadPerK >= 8 ? 2 : f.acadPerK >= 3 ? 1 : 0, "academic vocabulary");
  add(f.mathPct >= 1.5 ? 1.5 : f.mathPct >= 0.5 ? 1 : 0, "math density");
  if (f.latexProducer) add(1.5, "LaTeX");     if (f.generatorProducer) add(-1, "doc-generator producer");
  add(f.pages >= 100 ? 2.5 : f.pages >= 30 ? 2 : f.pages >= 8 ? 1 : f.pages <= 2 ? -1 : 0, "page count");
  if (f.receiptRoll) add(-2, "receipt-roll size");  if (f.landscapeDeck) add(1, "slide deck");
  if (f.xfa) add(-2, "XFA form");
  add(-Math.min(5, f.adminTermGroups), "admin terms");
  add(f.currencyPerK >= 30 ? -3 : f.currencyPerK >= 15 ? -2 : f.currencyPerK >= 5 ? -1 : 0, "currency density");
  add(f.urlScore, "source"); add(f.pathScore, "file name/folder");
  if (f.sensitiveIds >= 2 || f.luhnCard) { if (pos < 8) return {decision: "NOT_LEARNING", S, reasons: [...why, "veto: sensitive ids"]}; }
  const decision = S >= 3 ? "LEARNING" : S <= 0 ? "NOT_LEARNING" : "AMBIGUOUS";
  return {decision, S, reasons: why};             // reasons drive the status-chip tooltip
}
// Stage 3 (AMBIGUOUS only): S' = S + clamp(10 * (simLearn − simNot), −2, +2) using MiniLM prototypes;
//   S' ≥ 3 → LEARNING, S' ≤ 0 → NOT_LEARNING, else ASK.
```

**Why the thresholds are asymmetric.** A false save (a bank statement in your knowledge base) breaks the privacy promise. A false skip (a reading not saved) costs one click on the status chip. So saving needs +3, and anything in between goes to the model, then to the user.

## B.4 Local model tier: tested, not guessed

The int8 ONNX weights below are the same files transformers.js loads. They were run with onnxruntime (CPU) on the fixtures.

| Model (HF id, int8 size) | Input | Result | Speed | Verdict |
|---|---|---|---|---|
| `Xenova/all-MiniLM-L6-v2` (23 MB), cosine to 6 learning / 7 admin prototype sentences | Text of pages 1–2 | **37/41** (3 skipped: no text on pages 1–2). Errors: Attention, AlphaFold, Axler (learning → not), QualityHosting invoice (+0.01 margin) | **~20 ms/doc** | **Use** as the Stage-3 tie-breaker. Margins are small (cos ~0.1–0.5), so it is never decisive alone |
| `Xenova/dit-base-finetuned-rvlcdip` (q8 87.5 MB, q4 56.8 MB), 16 RVL-CDIP classes on a page-1 image | Page-1 render, 224 px grey | **38/44**. Learning only if the class is in {scientific publication, scientific report, presentation}. Mapping "specification" to learning gave 36/44. False positives: HMRC SA100 cover, energy-bill explainer | ~0.17 s/page | **Use only for PDFs with no text layer**. It correctly flagged the image-only Starbucks receipt as invoice. Never the sole reason to save |
| `Xenova/mobilebert-uncased-mnli` (27 MB), zero-shot with 10 hypotheses | Page-1 text | **31/41**. All errors were learning → "invoice or receipt" | 0.43 s/doc | **Don't use.** `nli-deberta-v3-xsmall` (87 MB) may do better; untested |

**Implementation notes:**
- Bundle the models with the app and set `env.allowRemoteModels = false`, so nothing is fetched at classification time.
- Run the models in a worker, and only on AMBIGUOUS or no-text documents (a minority of opens).
- Pipelines: `feature-extraction` (MiniLM, mean-pool + normalise), `image-classification` (DiT).

## B.5 Optional LLM fallback (off by default)

- **Preferred:** a *local* small instruct model (Ollama / llama.cpp / WebLLM), so the privacy rule holds without exceptions.
- **Cloud (explicit opt-in in Settings), allowed only if all of these hold:**
  - the document is still AMBIGUOUS after Stage 3
  - the sensitive-ID pre-screen found nothing
  - admin term groups ≤ 1
- **What is sent:** the title, the first ~1,200 characters of page 1 after redaction (digits → `#`, emails/URLs/names-after-salutation removed), and the feature summary. **Never the file, never more than that excerpt.** Use the provider's zero-retention option.
- **Expected reply:** `{label: "learning"|"not_learning"|"unsure", doc_type, confidence}`. "unsure" → ask the user.

## B.6 Privacy rule

> **Classification happens in memory, on-device, before any write. A PDF that is not (yet) classified LEARNING leaves no trace:**
> - no history row, no thumbnail, no text or vector index entry, no metadata cache
> - no log line or crash report containing its title, path, URL or hash
> - no telemetry
>
> Extracted text and feature buffers are dropped when the tab closes. The only exception is a salted hash in a local "never save" list, written only when the user explicitly picks *Never save this file*. **Nothing about any PDF leaves the device**, except the opt-in, redacted LLM excerpt described in B.5. Annotations made on an unsaved PDF stay in memory until the user saves the PDF to the library, exports an annotated copy, or closes it (with a prompt).

## B.7 User override flow

- **Status chip** in the title bar shows one of: **● Saved to library**, **○ Not saved: looks like an invoice**, or **? Not sure: Save?**. Hover shows the top reasons ("arXiv id, References, LaTeX"). Click toggles.
- **Ambiguous documents:** a non-modal banner appears after about 20 s of reading **or on the first annotation** (annotating is strong intent): "Save this to your reading history? **Save** · **Not now** · **Never for this file** · *Always for moodle.lse.ac.uk*".
  - "Not now" means this session only.
  - Notes made before the decision are kept in memory and committed if the user saves.
- **False skip:** Ctrl+Alt+S or a chip click saves the document, back-fills the history entry (open time, position, in-memory notes) and offers "Always save from <source>/<folder>".
- **False save:** Ctrl+Shift+Delete ("Forget this PDF") purges the history row, text and vector index, thumbnails and notes (with a confirm if notes exist). It offers "Never save this file" (hash blocklist) and "Never from <source>".
- **Rules UI** (Settings › Library rules): allow/deny lists for domains and folders, pre-filled with suggestions (the OneDrive LSE folder, moodle.lse.ac.uk). Precedence: per-file decision > deny > allow > classifier.
- **Session safety net:** "Recently skipped (this session)" in the History view, kept in memory only and cleared at exit, so a mis-skipped reading can be rescued.
- **Learning from overrides:** adjust per-source and per-folder priors **only from positive overrides**. Learning from negatives would mean storing features of non-learning documents, which the privacy rule forbids.

## B.8 Fixture set and evaluation

**Location:** `/tmp/claude-0/-home-user/24aa939a-b5a9-56a1-a55e-601726feabba/scratchpad/research/classifier-fixtures/`
- `learning/`: **22 PDFs, 56 MB.**
- `not-learning/`: **22 PDFs, 7 MB.**
- `manifest.json`: url, source page, label, type, notes, edge_case, sha256, bytes, pages, Info metadata, retrieval date, caveats.

All files are under 15 MB (largest: CS231n slides, 11.6 MB). Every file was checked for a `%PDF` header and size, and none were executed.

- **Learning:**
  - 5 arXiv papers (CS, econometrics, q-fin)
  - NBER w29000
  - LSE CEP dp1800
  - PLOS ONE (DOI) and Nature AlphaFold (OA)
  - 5 open textbooks (Think Stats, Think Python, Grinstead–Snell, Axler LADR4e, Boyd)
  - Tong's Cambridge lecture notes
  - MIT 6.006 lecture notes
  - MIT 14.01 handout and problem-set solutions (contain $ amounts)
  - CS50 and CS231n slides
  - Sutskever PhD thesis
  - IPCC AR6 SPM report
- **Not learning:**
  - 9 invoices, bills and booking receipts from invoice2data's test suite (EN/FR/DE/NL, MIT licence)
  - the Sliced Invoices sample
  - IRS W-9, W-2 and 1040 (XFA)
  - HMRC SA100-2026
  - Five Star Bank sample e-statement
  - 2 "how to read your bill" explainers (edge cases)
  - an IUP payslip explainer (an edge case on a **.edu** domain)
  - KDE KItinerary's synthetic boarding pass
  - a German rail ticket and 3 receipts published by their owner in JensWalter/my-receipts (one is **image-only**)
- **Not obtained:** a public tenancy-agreement PDF. The gov.uk model agreement now returns HTTP 410 and Doncaster's copy returns 403. Contracts are covered by text rules only, so add one next.

**Results (heuristic score):**

| Mode | Learning (22) | Not learning (22) |
|---|---|---|
| Content + metadata only (honest baseline) | 21 saved, **1 ambiguous** (MIT 14.01 handout: figure-only, S = +1.0; the MiniLM margin +0.34 would resolve it) | **22 not saved, 0 false saves** |
| + source URL | 22 saved | 22 not saved. *Optimistic*: the GitHub fixture paths contain "invoice"/"receipt" |

**Caveats:**
- The weights were hand-tuned on these same 44 files, so there is a real risk of overfitting. Build a held-out set, for example a local-only "evaluate on my Downloads" developer mode that never uploads.
- The textbooks pass mainly on page count plus LaTeX (Think Python scores only +3.0 without the URL). A short LaTeX-free reading (a 6-page Word-made seminar handout) is the most likely false skip, which is why the ask-the-user path matters.
- Low-cost improvement: treat in-text scholarly URLs and footers ("MIT OpenCourseWare https://ocw.mit.edu", "Lecture 3", course codes) as a +1 signal.

**Reproduce** (scripts read only extracted text and images; run Python with `-I`):

```
S=/tmp/claude-0/-home-user/24aa939a-b5a9-56a1-a55e-601726feabba/scratchpad
python3 -I $S/scripts/score_proto.py $S/research/classifier-fixtures/manifest.json $S/fixture-text
$S/venv/bin/python -I $S/scripts/embed_proto.py $S/models/minilm     $S/research/classifier-fixtures/manifest.json $S/fixture-text
$S/venv/bin/python -I $S/scripts/dit_proto.py   $S/models/dit        $S/research/classifier-fixtures/manifest.json $S/fixture-img
$S/venv/bin/python -I $S/scripts/zeroshot_proto.py $S/models/mobilebert $S/research/classifier-fixtures/manifest.json $S/fixture-text
```

The downloader is `$S/scripts/fetch_fixtures.py` with `$S/scripts/fixtures.json`. It uses curl `--max-filesize 15MB`, checks the `%PDF` header and runs pdfinfo/pdftotext. Its output field was later renamed from `cls` to `label` in the manifest.

## B.9 Open questions for the build

- **Reading in Chrome tabs bypasses a desktop app.** Do we want a later "Open in <app>" extension that passes the URL along?
- **Chrome Incognito downloads** may not carry a `HostUrl` (unverified). The text signals then do all the work.
- **Non-English academic PDFs** (French or German readings): the positive vocabulary is English-only today, while the admin terms are already multilingual. Add Abstract/Résumé/Zusammenfassung, Literaturverzeichnis, Bibliographie and similar.
- **Edge policy:** decide whether company annual reports, government reports and course handbooks count as learning. The user's brief says "reports" do, and the IPCC report passes. A bank's annual report would score ambiguous (high currency density but long, with no admin term groups) and go to ask, which seems right.

---

## Sources

**Chrome / Google**
- [Google blog: Chrome split view, PDF annotations, Save to Drive (Feb 2026)](https://blog.google/products-and-platforms/products/chrome/chrome-productivity-improvements/)
- [Droid Life on Chrome PDF annotations](https://www.droid-life.com/2026/02/19/chrome-adds-3-sweet-new-features-split-view-pdf-annotations-drive-saves/)
- [ChromeStory: built-in PDF annotation how-to](https://chromestory.com/2026/06/annotate-pdf-chrome-built-in/)
- [TechRepublic on Chrome 145](https://www.techrepublic.com/article/news-chrome-split-view-pdf-annotations-save-to-drive/)
- [PiunikaWeb: Chrome v150 PDF summarize](https://piunikaweb.com/2026/07/02/chrome-v150-pdf-summarize-incognito-support/)
- [Windows Report: Chrome Beta Gemini PDF summaries](https://windowsreport.com/chrome-beta-now-lets-you-summarize-pdfs-with-gemini/)
- [Chromium code review: PDF rotate Ctrl+[ / Ctrl+]](https://codereview.chromium.org/581913003)
- [Drive Help: comment on PDFs and other files](https://support.google.com/drive/answer/7650301?hl=en)
- [Workspace Updates: Gemini in Drive PDF viewer (2024)](https://workspaceupdates.googleblog.com/2024/07/gemini-in-side-panel-of-google-drive-pdf-viewer.html)
- [Workspace Updates: Gemini in overlay previewer (2025)](https://workspaceupdates.googleblog.com/2025/01/use-gemini-to-interact-with-pdfs-in-google-drive-previewer.html?m=1)
- [9to5Google: Drive Android PDF draw/highlight](https://9to5google.com/2023/03/02/google-drive-pdf-draw-highlight/)
- [Google Docs keyboard shortcuts](https://support.google.com/docs/answer/179738?hl=en&co=GENIE.Platform%3DDesktop)

**Foxit / Adobe**
- [Foxit Reader for Mac keyboard shortcuts (2026.2)](https://help.foxit.com/manuals/pdf-reader/foxit-reader-for-mac/en-us/2026.2/Keyboard_Shortcuts_and_Single_key_Accelerators.html)
- [Foxit PDF Editor for Windows keyboard shortcuts](https://resource-cms.foxit.com/foxit-pdf-editor-for-windows/keyboard-shortcuts)
- [Foxit: view all comments](https://resource-cms.foxit.com/foxit-pdf-editor-for-windows/view-all-comments)
- [Foxit: reply to comments](https://resource-cms.foxit.com/foxit-pdf-editor-for-windows/reply-to-comments)
- [Betanews: Foxit 2023.3 AI](https://betanews.com/article/foxit-pdf-reader-2023-3-foxit-pdf-editor-2023-3)
- [Adobe Acrobat keyboard shortcuts](https://helpx.adobe.com/acrobat/desktop/get-started/preferences-and-settings/keyboard-shortcuts.html)
- [Adobe: view comments](https://helpx.adobe.com/acrobat/desktop/share-and-review-documents/manage-reviews/view-comments.html)
- [Adobe: managing comments](https://helpx.adobe.com/acrobat/current/comments.html)
- [Adobe: Summarize comments](https://experienceleague.adobe.com/en/docs/document-cloud-learn/acrobat-learning/60-second/summarize-comments)

**Zotero / Readwise / Hypothesis**
- [Zotero PDF reader](https://www.zotero.org/support/pdf_reader)
- [Zotero keyboard shortcuts](https://www.zotero.org/support/kb/keyboard_shortcuts)
- [Zotero: annotations in database](https://www.zotero.org/support/kb/annotations_in_database)
- [Zotero 8 blog](https://www.zotero.org/blog/zotero-8/)
- [Zotero forum: persistent colours request](https://forums.zotero.org/discussion/131910/feature-request-persistent-annotation-colors-and-keyboard-shortcuts-in-zotero-pdf-reader)
- [Readwise Reader: highlights, tags, notes](https://docs.readwise.io/reader/docs/faqs/highlights-tags-notes)
- [Hypothesis keyboard shortcuts](https://web.hypothes.is/help/keyboard-shortcuts-for-hypothesis/)
- [Hypothesis keyboard-only annotation](https://web.hypothes.is/help/creating-annotations-using-only-your-keyboard/)
- [Hypothesis custom shortcuts](https://web.hypothes.is/help/customizing-keyboard-shortcuts-in-hypothesis/)

**Other readers**
- [Sioyek usage docs](https://sioyek-documentation.readthedocs.io/en/latest/usage.html)
- [LiquidText App Store listing](https://apps.apple.com/us/app/liquidtext-pdf-document-reader-annotate-excerpt/id922765270)
- [MarginNote what's new](https://www.marginnote.com/en/whats-new/)
- [MarginNote 4 App Store listing](https://apps.apple.com/lc/app/marginnote-4/id1531657269)
- [PDF Expert keyboard shortcuts](https://support.readdle.com/pdfexpert/en_US/tips-and-tricks/keyboard-shortcuts)
- [PDF Expert annotation summary export](https://support.readdle.com/pdfexpert/en_US/annotate-pdfs/view-and-export-annotation-summary)
- [Highlights App Store listing](https://apps.apple.com/us/app/highlights-extract-pdf-notes/id1498912833)
- [MPU forum: Highlights sidecar workflow](https://talk.macpowerusers.com/t/pdf-annotation-workflow-using-highlights-app-and-hazel/34333)

**Keyboard conflicts**
- [Raymond Chen: why Ctrl+Alt shouldn't be a shortcut modifier](https://devblogs.microsoft.com/oldnewthing/20040329-00/?p=40003)
- [Microsoft: international conventions (avoid Ctrl+Alt)](https://msdn.microsoft.com/en-us/library/ee490981(v=winembedded.60))
- [Microsoft Learn: hot keys and AltGr](https://learn.microsoft.com/en-nz/archive/blogs/murrays/hot-keys-and-altgr)

**Classifier**
- [Caragea et al., AAAI 2016, document-type classification in digital libraries](https://www.cs.uic.edu/~cornelia/papers/iaai16.pdf)
- [Charalampous & Knoth 2017](https://arxiv.org/pdf/1707.04134)
- [DiT fine-tuned on RVL-CDIP](https://huggingface.co/microsoft/dit-base-finetuned-rvlcdip)
- [Xenova DiT ONNX](https://huggingface.co/Xenova/dit-base-finetuned-rvlcdip)
- [Xenova MobileBERT-MNLI](https://huggingface.co/Xenova/mobilebert-uncased-mnli)
- [Xenova nli-deberta-v3-xsmall](https://huggingface.co/Xenova/nli-deberta-v3-xsmall)
- [Xenova all-MiniLM-L6-v2](https://huggingface.co/Xenova/all-MiniLM-L6-v2)
- [Mark of the Web (Zone.Identifier HostUrl/ReferrerUrl)](https://en.wikipedia.org/wiki/Mark_of_the_Web)

**Fixture sources**
- [invoice2data test fixtures](https://github.com/invoice-x/invoice2data/tree/master/tests/compare)
- [JensWalter/my-receipts](https://github.com/JensWalter/my-receipts)
- [KDE KItinerary synthetic data](https://github.com/KDE/kitinerary/tree/master/autotests/extractordata/synthetic)
- [HMRC SA100 2026](https://www.gov.uk/government/publications/self-assessment-tax-return-sa100)
- [Energy Made Easy tools](https://energymadeeasy.gov.au/article/useful-tools)
- [Consumer Council NI bill guide](https://www.consumercouncil.org.uk/sites/default/files/2019-04/Understanding%20your%20electricity%20bill%202015.pdf)
- [IUP pay statement guide](https://www.iup.edu/Payroll/files/forms/understanding-your-pay-statement.pdf)
- Full per-file URLs are in `manifest.json`.

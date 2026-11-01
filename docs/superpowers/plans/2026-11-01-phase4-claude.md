# Phase 4 · @Claude and Release 1 — plan

Nov 1, 2026. Short plan (CLAUDE.md rule 5). The spec is normative, the contracts (`docs/superpowers/contracts/2026-11-01-cross-phase-contracts.md`) are binding, and this file adds slices and a few contract additions (§8). Sources: spec "Claude integration" part 1, "Build phases", the Release 1 "done when" list; research 03 §5a and 06 §6–10; contracts §3 and §6.

## 1. Goal and "done when"

**Goal.** You type "@Claude …" in any note, or pick Ask Claude or Explain this figure, and an answer streams into the thread with page links that jump to the passage. It is cheap by default (Haiku 5.5), and one click re-asks Opus 5.5. Then Release 1 ships as a zip on GitHub, with SETUP.md and your Windows checklist.

**Phase 4 is done when:**
1. @Claude in a thread streams an answer with clickable "p. N" chips. When it searched the web, the answer also has source chips (Release 1 criterion 5).
2. A typical question sends the marked passage and its paragraph, the document map and at most 5 passages: 3,500 tokens of document text at most, never the whole PDF. A figure question sends a local crop of the figure, its caption, the exact text inside it and up to 3 paragraphs that mention it.
3. Costs, checked with real `usage` in the live check:
   - a Haiku question without web search costs under 0.1 cent;
   - a follow-up within 5 minutes shows cache reads;
   - Think harder costs about 3 to 5 cents;
   - any request over $0.25 asks first, and the monthly cap blocks.
4. The key never leaves `sop-local` except in the request header to Anthropic. Nothing goes to `api.anthropic.com` unless you started an @Claude action. On a PDF that isn't saved, nothing is sent until you confirm.
5. A reply cut off by a crash or a closed tab keeps its text and offers "Try again" (the no-lost-text gate, now for replies).
6. All 8 Release 1 criteria pass on the release candidate (mapped in `docs/checklists/release1-gate.md`):
   - the four critics find no critical or major issue;
   - the `perf-gate` job is green;
   - you sign the Windows checklist, including keyboard layouts (UK, US, DE, PL);
   - the GitHub release holds the zip.

## 2. Frontier check (4 searches, Nov 1, 2026)

What changed since research 03/06 (31 Oct), and what it changes here:
- **The Models API now returns `line`** (`haiku`, `sonnet`, `opus` and two more), plus `lifecycle`, `retires_at` and a full `capabilities` tree. The tree includes `image_input`, `citations`, `effort.*` and `server_tools.web_search`.
  - So D1 needs no id parsing: setup picks the newest active `haiku` model and the newest active `opus` model.
  - Settings warns before a chosen model retires.
  - The docs say "do not infer a line from the id". Source: https://platform.claude.com/docs/en/api/models/list
- **There are three web search tool versions:**
  - basic, `20250305`;
  - dynamic filtering, `20260209`, which "reduces token use" and adds no code-execution charge;
  - `20260318`, which adds response-inclusion control for agent workflows and isn't needed here.
  - Dynamic filtering is "available with Claude 4.6 and later models". The docs don't say whether Haiku 5.5 has it, and `server_tools.web_search` is true if any version works.
  - So setup probes which version the chosen model accepts, newest useful first, with free token counting, and stores the answer (§8 A1).
  - The price is $10 per 1,000 searches, and search results are billed as input on later turns too. Source: https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
- **`search_result` blocks in tool results can be cited** (`search_result_location`, whole text blocks).
  - So pages fetched later through `search_document` and `get_pages` are citable, not only the first passages.
  - Limits: text only (so `get_figure` returns a plain image plus text); a tool result may not mix them with other block types; and citations must be on whenever web search is on. Source: https://platform.claude.com/docs/en/build-with-claude/search-results
- **Citations and caching match the research.** Custom-content documents still cite as `content_block_location`, and the cache minimum on the 5.5 models is 512 tokens. Two rules from the bundled API reference matter here:
  - API version `2026-10-21`, which SDK 1.3.0 sends, rejects user text blocks that carry citations, so earlier replies go back only as assistant turns;
  - switching web search on or off resets the system and message caches, so a thread's tool list stays fixed.
- **Competitors.** NotebookLM, renamed Gemini Notebook, answers with numbered citations that jump to the exact passage. This is the bar, and the plan meets it. The search found nothing new for Acrobat AI Assistant or Gemini in Chrome. Our edge is answers that live as threads on the passage, persist, are searchable, can see figure crops and show their cost.

## 3. Rules every slice follows

- **Where calls run.**
  - Only the viewer tab and Settings call Anthropic, with SDK 1.3.0, `dangerouslyAllowBrowser`, read through `getSecret`.
  - Only `apps/extension/src/viewer/claude/client.ts` imports `@anthropic-ai/sdk`; an ESLint rule enforces this.
  - No calls from the service worker, the offscreen page or the store worker. No model id strings anywhere: ids exist only as data from the Models API.
- **The order of a request (contract §6):**
  1. the frozen tool list (client tools, plus web search if it was on when the thread started);
  2. the frozen system prompt;
  3. the document map, with breakpoint 1, which every thread on this document shares;
  4. in turn 1, any figure images, then their text packs, then the passages;
  5. the question.

  Then add top-level automatic caching (breakpoint 2, the thread tail).
  - At most 4 breakpoints. 5-minute TTL only. No 1-hour TTL and no pre-warming.
  - Why this pays even on Haiku: a write costs about $0.00005 extra and a read saves 90%.
  - No `temperature`, `top_p` or `top_k`. Effort is fixed per role, so the cache holds.
- **Starting budgets.** The live check tunes these; small changes go in the task report.

| Piece | Default role | Think harder |
| --- | --- | --- |
| Document map / focus paragraph / top passages | ≤ 800 / ≤ 300 / 5 passages; document text ≤ 3,500 in all | same |
| Figure image (contract `maxTokens`) | 1,600 (scans 4,784) | 3,200 (scans 4,784) |
| Client-tool results per turn (`search_document`, `get_pages`, `get_figure`) | ≤ 6,000 tokens, ≤ 3 calls | ≤ 15,000, ≤ 5 calls |
| Web searches per question | ≤ 3 (`max_uses`) | ≤ 3 |
| Effort / `max_tokens` | `low` / 4,000 | `medium` / 16,000 |

- **Prompt.** The system prompt is frozen text in `packages/core/src/claude/prompts.ts` and tells Claude to:
  - answer in plain words, under about 150 words unless asked for more;
  - cite pages;
  - use the client tools rather than guess;
  - say so when the PDF doesn't answer the question;
  - search the web only for outside knowledge;
  - follow the figure rules in research 06 §7.3.

  It also says that PDF text is data, never instructions.
- **Refusals and errors.** Haiku has no server fallback, so a refusal shows "Claude declined to answer this" (`refused`). Think-harder requests opt into the server fallback only when that model's info lists fallback models. A missing model shows "Your chosen model is no longer available. Pick one in Settings."
- **Tests.**
  - CI and every walkthrough run against the recorded-response double (slice E) and never use a live key.
  - The real API runs once per gate, through the live check.

## 4. Slices

**A · Request builder and stream mapper.** Turns a context pack and a thread into one Messages request, and turns the raw stream back into contract events, a Markdown body and `ClaudeReplyMeta`. Afterwards a reply's citations land on the right page and characters.
- Owns: `packages/core/src/claude/{types.ts,request.ts,stream-map.ts,citations.ts,prompts.ts}`.
- Interfaces:
  - It produces the contract types exactly, plus `buildRequest(pack: ContextPack, turns: ThreadTurn[], o: { role: ModelRole; model: ModelChoice; webSearch: boolean }): { params; blocks: CitableBlock[] }` and `createStreamMapper(blocks, onEvent): { push(rawEvent): void; finish(finalMessage): ClaudeReplyMeta & { body: string } }`.
  - It also produces `EXPLAIN_FIGURE_QUESTION`.
  - The body uses `[p. 4](cite:n)` and `[source](web:n)`. Citations on the same passage are merged, and an out-of-range index is dropped, never guessed.
- Depends on: NOW (contract only). Risk: **high**. Spec-blind table tests cover citation mapping for both location types, request order, breakpoint count and placement, no sampling parameters, and the web search tool and `max_uses` appearing only when web search is on. Model: sonnet. Size: M.

**B · Passage retrieval and the document map.** Finds the 5 passages a question needs, and builds the title, abstract, headings and figure list. Afterwards a question sends 2,000 to 5,000 tokens, chosen well.
- Owns: `packages/core/src/claude/{passages.ts,paragraphs.ts,rank.ts,doc-map.ts,whole-document.ts}`.
- Interfaces:
  - It produces `createPassageRetriever` and `DocumentMap` from contract §6, plus:
    - `buildDocumentMap(src)`;
    - `focusPassage(anchor, src)`, the anchor's paragraph;
    - `inMemoryRankPages(pages)`, BM25 for unsaved PDFs;
    - `packWholeDocument(src, maxTokens)`.
  - Paragraphs are cut at sentence ends to ≤ 300 tokens. The query is the question plus the anchor quote. It ranks pages, then paragraphs inside the top pages.
  - Ranking can take an optional re-rank hook. It uses Phase 3's MiniLM worker when that is already loaded and finishes within 150 ms; otherwise ranking is BM25 only.
  - The output is byte-identical for the same inputs, so the cache holds.
  - It consumes `PageTextProvider` (P2), Phase 3 `search({ text, documentId, kinds: ['page'] })` for saved documents, the Task 15 outline (for headings, with a font-size fallback) and `PageFigure` (P2).
- Depends on: NOW (adapters stubbed). Risk: **high** (usefulness).
  - A spec-blind retrieval set has 20 questions on 5 reference papers, each with its expected page.
  - Pass means the expected passage is in the pack for at least 18 of 20.
  - Also tested: the pack never exceeds the budget, and `getPassages` never returns the whole document.
- Model: sonnet. Size: M.

**C · Figure crops and figure packs.** Renders a figure, area or scan region locally at a legible size, and gathers its caption, the text inside it and the paragraphs that mention it. Afterwards "Explain this figure" has everything Claude needs.
- Owns: `packages/viewer/src/figures/render-region.ts`, `packages/core/src/claude/figure-text.ts` (token formula, scale fitting, position-tagged inside text, finding mentions and labels such as "Figure 2 and 3"), and `apps/extension/src/viewer/claude/figure-pack.ts`.
- Interfaces:
  - It produces `renderRegion`, `RegionImage` and `FigurePack` (contract §6), plus `figureLabelsIn(question)`.
  - It follows 06 §7.1: 150–300 DPI from the smallest font inside the region, PNG or JPEG, the marked sub-area or pin drawn on the image, a second enlarged crop when the mark is small, at most 4 figures at 1,200 tokens each, and at most 20 images.
  - It consumes `PdfBackend.renderTile` (Task 15), `PageTextProvider` and `PageFigure` (P2). Until P2 lands, it uses Task 5's `DetectedFigure`.
- Depends on: NOW, against Task 15. Risk: **high**, because it sends images. Spec-blind table tests cover the token maths against 06 §7.1's examples and the format choice; Gate 2 adds crop entries. Model: sonnet. Size: M.

**H · Cost, caps and spend.** Prices every request and reply, asks before costly ones, and keeps the month's total. Afterwards you never get a surprise bill.
- Owns: `packages/core/src/claude/{pricing.ts,cost.ts}`, `apps/extension/src/viewer/claude/spend.ts`.
- Interfaces: it produces:
  - `priceFor(model: ModelChoice)`. It looks up `line` plus the version in `displayName` from a price table taken from 06 §6. An unknown version uses the highest price known for that line, and a model with no line asks before sending.
  - `usdFromUsage(usage, price)`. Cache writes cost 1.25×, cache reads use each model's own rate, each search costs $0.01, and Haiku's higher rate applies to prompts over 100,000 tokens.
  - `estimate(pack, role, model)`, using a calibration factor per line that the live check measures with free token counting.
  - `decide({ estimateUsd, spentUsd, capUsd, confirmOverUsd, saved, scope }) → 'send' | { ask: 'unsaved' | 'over-threshold' | 'whole-document'; usd } | { block: 'over-cap' }`.
  - `addSpend(usd)`, one IndexedDB transaction on `claudeSpendMonth`, reset at the local month change.
- Depends on: NOW. Risk: **high**. Spec-blind table tests cover the price maths, cap boundaries, the month rollover and two tabs adding spend at once. Model: sonnet. Size: S.

**E · Recorded-response double and live check.** A fake Anthropic that replays recorded streams, plus one live run per gate. Afterwards every Claude walkthrough runs in CI with no key and no cost.
- Owns: `e2e/support/claude-replay.ts`, `e2e/fixtures/claude/` (scrubbed SSE and Models-list recordings), `scripts/claude/record.mjs`, `apps/extension/src/testing/claude-base-url.ts` (test builds only), `.github/workflows/claude-live.yml`.
- Interfaces:
  - It adds fixture-server routes `/claude/v1/{models,messages,messages/count_tokens}` that replay a named scenario.
  - `claudeReplay(server).use(name)` and `.requests()` return the captured request bodies, so tests can check what was sent: token size, blocks, breakpoints, images, the absence of the key in the body.
  - Test builds point the SDK base URL at the replay server through the test-only module. A production-build check (slice K) proves the module is absent.
  - The recorder reads a key only from an environment variable, scrubs ids and headers, and refuses to write anything that looks like a key.
  - The live workflow runs on manual dispatch and the `phase-4-gate` tag, using a GitHub secret. It runs:
    - the model list;
    - one text question;
    - one figure question;
    - one web search;
    - one follow-up, which must show cache reads;
    - Think harder.

    It prints `usage` and dollars, compares effort `low` with `medium` on 10 questions, and records the calibration factors.
- Depends on: NOW. Risk: **high** (a key in CI): a security read, no spec-blind tests. Model: sonnet. Size: M.

**D · Turn runner and Anthropic client.** Runs one Claude turn end to end:
1. checks;
2. builds the pack;
3. streams;
4. runs client tools;
5. writes the reply row.

Afterwards @Claude works for real, including Stop, Try again, Think harder, follow-ups and crash recovery.
- Owns: `apps/extension/src/viewer/claude/{client.ts,turn.ts,context.ts,client-tools.ts,history.ts,reply-rows.ts,errors.ts,entry.ts}`, and the SDK-import rule in `eslint.config.mjs`.
- Interfaces:
  - It produces `ClaudeTurnRunner` (contract §6) and `ClaudeEntry` (§8 A3).
  - `createClaudeClient(): Promise<ClaudeClient | { error: 'no-key' }>` reads the key on each call, retries twice and scrubs any key-like text out of errors.
  - The reply row lifecycle is exactly contract §3: pending, then streaming (one write at most every 500 ms), then done in one write. On an error, the text is kept. Try again keeps the same id, and a row whose tab is gone becomes interrupted when the PDF opens again.
  - Client tools return `search_result` blocks counted against the turn budget. The runner continues after `pause_turn`, and Stop maps to `cancelled`.
  - Follow-ups append the exact blocks held in memory. After a reload, the thread is rebuilt as plain text turns.
  - On a memory-only PDF the reply stays in memory. In Incognito it is disabled.
  - It consumes A, B, C and H; P2's `writeAnnotations`, `saveDraft`, `sendDraft`, change events, `TabId` and the `sop-tabs` roll call; P3's settings rows and `search`; Task 29's `getSecret`; and Task 30's `SaveState`.
- Depends on: Round 2 (P2 threads and P3 settings merged; A, B, C, H, E). Risk: **high**: spec-blind walkthroughs, plus a security read of the key path, the network gate and the link allow-list. Model: sonnet. Size: L.

**F · Claude in the thread (UI).** How a Claude reply looks and behaves in a Docs-style card. Afterwards Claude feels native to the margin, the way comments do in Google Docs.
- Owns: `apps/extension/src/viewer/claude/ui/{ClaudeReplyView,CitationChip,SourceChip,FigureChip,ReplyStatus,ThinkHarderButton,ClaudeConfirmDialog,MentionItem}.tsx`, their `.module.css` files, and `ui/jump.ts`.
- Interfaces:
  - It fills P2's card and note-box slots (§8 A4). The @Claude autocomplete item and the right-click and figure-toolbar Ask Claude and Explain items all call `ClaudeEntry.ask`.
  - While streaming, the card shows a status line ("Reading 4 passages…", "Searching the web for …"), a Stop button, and Markdown that follows the link allow-list (`cite:`, `web:` and `https:` only; source chips open a new tab).
  - Chips: "p. 4" jumps to the passage and flashes it, and "Fig. 3 · p. 5" jumps to the figure and selects it.
  - Buttons and text: Think harder, Try again, and plain-word error text with a "Open Settings" button.
  - A cost line appears on hover (model name and cents).
  - Confirm dialogs cover an unsaved PDF ("Send 3 passages to Anthropic?"), an estimate over $0.25, and "Ask about the whole document".
  - It consumes `ClaudeStreamEvent`, `ClaudeReplyMeta` and the `packages/ui` components and tokens.
- Depends on: Round 2, against a fake runner fed by E's recordings. Risk: **visual**. Model: opus. Size: L.

**G · Claude settings and setup.** The Claude section of Settings. Afterwards you paste a key once, see it checked, and pick models from the live list.
- Owns: `apps/extension/src/claude-settings/{ClaudeSettingsSection.tsx,model-discovery.ts,key-check.ts}`, plus its CSS.
- Interfaces:
  - Key: paste it, then check it with a model-list call ("That key didn't work" on failure). It is stored with `setSecret` and shown as "Key saved ····abcd", with Delete key next to it.
  - Models:
    - two pickers list active models, grouped by `line`, newest first, with Haiku preselected for the default and Opus for Think harder;
    - each choice shows a typical cost per question from H;
    - each choice probes the web search version and records image support, saved as a `ModelChoice`;
    - a warning appears when a chosen model is about to retire.
  - Switches and numbers: web search on or off, the monthly cap, the confirm threshold, and this month's spend.
  - A short plain line recommends a spend limit in the Anthropic Console.
  - It consumes D's `client.ts`, H's `priceFor`, Task 29's store, and P3's Settings page slot and settings rows.
- Depends on: Round 2. Risk: **high** (key) and **visual**. Model: opus. Size: M.

**J · Release candidate and polish.**
- Builds the RC zip and runs:
  - gates 1 to 3;
  - the perf-gate job;
  - the live check;
  - the four critics, and you, on the real build.
- Each finding goes to the slice or phase that owns the file. Fix it or drop it (rule 3).
- Writes the criteria map. Afterwards each Release 1 criterion points at the test, gate or checklist item that proves it.
- Owns: `docs/checklists/release1-gate.md`.
- Interfaces: it consumes every phase's gates and K's zip.
- Depends on: Round 3. Risk: low (it coordinates). Model: sonnet. Size: M.

**K · Packaging and the GitHub release.** One command builds the release zip, and a tag publishes it. Afterwards installing is "download, unzip, Load unpacked".
- Owns: `scripts/release/{package.mjs,verify-zip.mjs,notices.mjs}`, `.github/workflows/release.yml`, `THIRD_PARTY_NOTICES.md`, and the version field in `apps/extension/package.json`.
- Interfaces:
  - `pnpm release:zip` writes `sickofpdfs-<version>.zip` from the production build.
  - `verify-zip` fails if:
    - the extension id doesn't come from the committed key;
    - `__sopTest` or the test base URL is present;
    - any remote script, font or model URL is present;
    - anything that looks like a model id is present;
    - an engine, font or model file is missing;
    - the licence notices are missing.
  - The workflow, with SHA-pinned actions and `contents: write` only, runs the gates on a `v*` tag, builds, verifies, and creates a draft GitHub release. You press Publish after signing the checklist.
- Depends on: NOW (scaffold), finished in Round 3. Risk: low, plus a security read of the workflow permissions. Model: sonnet. Size: M.

**L · SETUP.md and your Windows checklist.** Afterwards you can set up Release 1 alone in about 10 minutes, and test it on your PC.
- Owns: `SETUP.md`, `docs/checklists/release1-windows.md`.
- Interfaces:
  - SETUP.md covers the spec's six Release 1 steps, in short numbered lines. It uses only our own screenshots; Chrome and Windows screens are described in words, because third-party images stay out of the repo.
  - The checklist:
    - install from the release zip;
    - the double-click chain, briefly;
    - keyboard layouts UK, US, DE and PL;
    - @Claude with your own key and spend limit: a question, a figure, a web search and Think harder, comparing the cost line with Console usage;
    - a backup to a Drive folder, restored on a fresh Chrome profile;
    - the speed feel.

    Each item has a "Result / notes" column, and the list ends with a sign-off.
- Depends on: NOW (draft), screenshots in Round 3. Risk: low. Model: sonnet. Size: S.

## 5. Rounds

| Round | Slices | Starts |
| --- | --- | --- |
| 1 | A, B, C, E, H, plus K (scaffold) and L (draft) | **NOW**, against mocks and contracts; C uses Task 15 as soon as it is merged |
| 2 | D, F, G | After P2's threads, cards and note box, and P3's settings rows, Settings page and `search`, are merged with round 1. A test build with @Claude goes to you afterwards |
| 3 | J, then K and L finish, then tag `phase-4-gate` and `v1.0.0` | After Phases 2, 3 and 4 are all merged |

## 6. Gate 1 walkthrough tests to add (spec-blind author; spec moments 5 and 6, criterion 5)

1. **Ask about a passage.** In a saved paper, select a sentence, press Ctrl+Alt+M, type "@Claude why does this assumption matter?" and press Enter.
   - The reply grows while it streams and ends with "p. N" chips.
   - Clicking a chip jumps to the passage and flashes it.
   - The captured request holds the marked passage and at most 5 passages (document text ≤ 3,500 tokens), and no text from a page that is unrelated.
2. **Right-click → Ask Claude** on a selection gives the same thread and the same kind of request as typing @Claude.
3. **Explain this figure.** Click a chart, then right-click → Explain this figure.
   - The reply carries a "Fig. N · p. M" chip and a caption citation.
   - The request holds exactly one image, which comes before the caption and mention text.
4. **Web search.** A question that needs outside knowledge shows "Searching the web…", and the answer has a source chip that opens in a new tab. With web search off in Settings, the request has no web search tool.
5. **Think harder** adds a second reply from the Think-harder model. The first reply stays.
6. **Unsaved PDF.** On a "Not saved" PDF, @Claude asks "Send … to Anthropic?". Cancel sends nothing, and Send works.
7. **Cost guards.**
   - "Ask about the whole document" on the 600-page file shows an estimate first.
   - With the monthly cap reached, the card says so plainly and nothing is sent.
   - With no key, the card says "Add your Claude key in Settings", with a button.
8. **Reply survives a crash.** Kill the tab while it is streaming, then reopen. The partial reply is still there, marked interrupted, with Try again, which reuses the same reply.
9. **Follow-up.** A second question in the same thread sends the earlier turns, with the document map marked for caching.
10. **Setup.**
    - Paste a key: the model list loads, with Haiku and Opus preselected. Then delete the key.
    - The backup and export scans find the key nowhere.
    - Ctrl+K finds Claude's reply by a word from its answer.
    - Across every walkthrough, there is no request to Anthropic or to the replay server without a Claude action.

## 7. Gate 2 and Gate 3 additions

- **Gate 2 (engine reference set).** For 6 figures in the reference papers (one-column, two-column, tall, equation strip, scan area, rotated table), record:
  - the crop's pixel size and `visualTokens`;
  - a perceptual hash of the crop;
  - a hash of the text inside the figure.

  This runs when `render-region.ts` or engine code changes.
- **Gate 3 (gallery).** Add these screens:
  - a reply mid-stream, with the status line and Stop;
  - a finished reply with page, source and figure chips, Think harder and the cost line on hover;
  - each error state: no key, interrupted, over cap, declined;
  - the unsaved-PDF and over-$0.25 confirm dialogs;
  - the @Claude autocomplete in the note box;
  - the figure toolbar with Ask Claude and Explain;
  - Settings → Claude, empty, then with a key saved and the model pickers open;
  - the About dialog showing the release version.

## 8. Contract additions (for the controller to apply to the contracts)

- **A1 `ModelChoice`.** The value of the settings rows `claude.model.default` and `claude.model.thinkHarder`:

  ```ts
  { id: string /* data from the Models API */; displayName: string; line: string | null;
    imageInput: boolean; webSearchTool: string | null /* the accepted tool type, probed at setup */;
    maxInputTokens: number | null; checkedAt: number }
  ```

  Code never compares ids.
- **A2 Effort per role.** Code holds a fixed mapping, `default` to `low` and `think-harder` to `medium`, checked against `capabilities.effort`. The live check may change the values; it is never a setting.
- **A3 `ClaudeEntry`** in `apps/extension/src/viewer/claude/entry.ts`, published on `ViewerRuntime`:

  ```ts
  ask(target: { threadId: ThreadId } | { anchor: Anchor }, o?: { preset?: 'explain-figure' | 'whole-document'; question?: string }): Promise<ThreadId>
  status(): 'ready' | 'no-key' | 'incognito'
  ```

  P2's menu, figure toolbar and note box call it, and keep the items hidden until it exists.
- **A4 Slots.**
  - P2's comment card renders an `author 'claude'` body with `ClaudeReplyView({ thread, comment })`.
  - The note box takes a mention source, `claudeMentionItems()`.
  - P3's Settings page mounts `ClaudeSettingsSection`.
  - If those phases have already named these seams differently, their names stand.
- **A5 `CitableBlock`** gains an optional `via: { kind: 'document' | 'search_result'; index: number; block: number }`, so both citation location types map back to `blocks[i]`.
- **A6 `claudeSpendMonth`** in `sop-local` holds JSON `{ month: 'YYYY-MM'; usd: number }`.
- **A7 Test hook.** `claudeBaseUrl` exists in `--mode test` builds only (slice E). A build test proves it is absent from production.

## 9. Risks

| Risk | Handling |
| --- | --- |
| The key leaks (error text, logs, devtools, CI) | One importer of the SDK; errors scrubbed; never in service-worker messages, the store, backups or test hooks; the recorder refuses key-like output; Console spend limit; one-click delete; security reads on D, E, G and K |
| A malicious PDF steers Claude, for example into web queries containing your text | The system prompt treats PDF text as data. Searches are capped at 3 and shown in the thread ("Searching the web for …"). Client tools only read this PDF. Reply links are allow-listed |
| Web search dominates the cost (1 cent per search vs about 0.07 cent per Haiku answer) | Search only for outside knowledge; dynamic filtering where it is accepted; the cost line shows it; one switch turns it off |
| Retrieval misses the passage | The anchor's paragraph is always sent; the client tools fetch more; the 20-question set gates quality at 18 of 20 |
| The token estimate is off (Haiku 5.5's tokenizer counts about 30% more; thinking tokens are unknown) | The live check calibrates per line; estimates are marked "about"; the cap uses real `usage` |
| The model or tool version changes or retires | Live list with `lifecycle` and `retires_at`, a warning in Settings, a plain error on a missing model, and the tool-version probe at setup |
| The cache silently stops working | Frozen tools, system and map; effort fixed per role; the live check requires cache reads on a follow-up |
| Long streams or browser CORS fail in an extension page | D proves a streamed call from the viewer tab first, before building on it |

## 10. Owner actions and decisions

- **Action, for the live check:** create a separate API key with a $5 monthly spend limit and add it in GitHub → Settings → Secrets → Actions as `ANTHROPIC_API_KEY_LIVE`. Without it, the live check runs on your PC in the Release 1 checklist.
- **Optional decision:** web searches per question, 3 (spec, the default) or 1 (cheaper).
- **At release:** sign `docs/checklists/release1-windows.md`, then press Publish on the draft GitHub release.

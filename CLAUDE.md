# sickofpdfs — project notes

A Chrome extension that replaces Chrome's PDF viewer. It adds comments, highlight, underline, bold and strikethrough marks, a library of learning PDFs, and @Claude. Everything runs in Chrome tabs. A cloud library on the owner's Cloudflare account comes in Release 2.

- Spec: `docs/superpowers/specs/2026-10-31-sickofpdfs-design.md`. The repo copy is normative; the Claude Doc is for discussion.
- Plan: `docs/superpowers/plans/2026-10-31-release1-phase0-1.md`.
- Phase 0 results and decisions: `docs/spikes/phase0-report.md`.
- Ledger: `.superpowers/sdd/<plan>/progress.md`. It is gitignored and local to one container. Anything that must survive goes here or in the plan.

## Mission and quality bar (every agent reads this)

- **Mission:** reading and thinking about PDFs in Chrome should feel effortless. Select text, right-click, mark it or comment. Every note persists on that PDF wherever it is opened. Learning PDFs build into a knowledge base you can search and ask Claude about. Receipts and private documents are never touched.
- **Quality bar:** at least as good as Chrome's own PDF viewer and Foxit for reading, speed and selection. It has Google Drive's clean aesthetic (not a pixel-perfect copy). It is frontier for AI-in-PDF and annotation; we check this with web research before each phase.
- **Non-negotiables:**
  - no lost notes;
  - no network traffic except what the owner turns on;
  - nothing saved from non-learning PDFs;
  - the visual polish of the owner-facing UI;
  - plain, clear wording in the UI.

The owner has learning disabilities and is highly intelligent. Write to them plainly, with short sentences, structure and no jargon.

## Standing process rules (set by the owner, 2026-11-01)

1. **Build a usable slice first, then harden it.**
   - Test build 1 is the viewer: takeover, scroll, zoom, select and copy, toolbar, "Back to page".
   - Test build 2 adds highlights and comments.
   - Polish comes after that.
2. **Run work in parallel by default, but don't split tightly coupled work.**
   - Independent pieces run side by side, each in its own git worktree: `/home/user/wt-taskN` on branch `wt/taskN`, cut from the current branch head. The automatic worktree option fails here because it bases on `origin/main`.
   - Coupled work goes to one agent as one slice. Loading plus scrolling is one slice. The text layer plus selection painting is another.
   - Each task writes its own results file.
   - Merging happens once per round with `scripts/dev/merge-wave.mjs`, which cherry-picks in order, regenerates the lockfile and runs the gates.
3. **Fix it or drop it.** Fix cheap, small issues right away. Delete the rest; don't keep a "deferred" pile. Only requirements a later task needs are carried, written into that task's brief.
4. **Use the right-sized model.** Small and medium work runs on haiku or sonnet. Opus is only for hard work: the engine port, render scheduling, the text layer, and visual-fidelity work (Drive components and the viewer chrome).
5. **Keep plans short.** A plan gives goals and interfaces, not test code. Interfaces and names are binding. Small differences go in the task report and need no formal ruling.
6. **Three quality gates instead of many tests** (owner, 2026-11-01). Typecheck and lint run everywhere because they are nearly free. Beyond those, quality comes from:
   - **Gate 1: the walkthrough user tests.** There are about 10, one per walkthrough in the spec's "How it feels to use". Playwright drives the real built extension the way the owner would (open a paper, scroll, select, mark, comment, reload, find it in the library), taking screenshots at the key moments. They live in `e2e/walkthroughs/` and run once per round, after the merge.
   - **Gate 2: the engine reference set.** It covers about 20 real PDFs: papers, a scan, forms and a 600-page file. For each one it records the expected output: page count, per-page text hash, selection rects, and a perceptual hash of each page render. Images stay out of the repo; only the hashes are committed. It runs only when engine or text-layer code changes. A difference is shown as a before/after picture and is approved or rejected, never silently re-recorded.
   - **Gate 3: the screenshot gallery.** Key screens are captured after every round and published to a private Artifact page the owner can open on a phone. Each one sits next to the Drive and Chrome references (`docs/research/drive-refs/`, `docs/research/02-drive-visual-spec.md`). The visual critic checks what changed since the last round. The aim is Drive's aesthetic, not a pixel-perfect copy. Visual quality ranks as high as data safety.
7. **Tests come from a spec-blind author, and only where the risk is real** (owner, 2026-11-01). Tests written by the session that wrote the code pass by construction and prove nothing.
   - **Implementers commit no tests.** They prove their work by running it and taking screenshots.
   - **Who writes the gate-1 tests.** A separate author writes them from the spec, the contracts and the interfaces only. It never sees the code, the diff or the brief's example tests. It writes them once per feature, not once per task.
   - **Unit tests: only for tricky, isolated logic,** and only from a spec-blind author. Examples are anchoring, canonical links, the learning filter, sync merge and export mapping. They are table-driven.
   - **When spec-blind authors are used.** Only for the engine, the owner's data, privacy, the network, and comments. Low-risk work (colours, scaffolding, plumbing) relies on gates 1 and 3.
   - **Triage of first-run failures.** Each one is a code bug (the implementer fixes it), a spec gap (the controller decides and records it in the spec), or a wrong guess on something the spec leaves open (the test is adjusted, with a note).
   - **Security read.** Privacy, network and data-loss work also gets a short security read of the diff.
8. **The owner's hands-on testing is the main critic.** A test build zip goes to the owner after every round, once a PDF opens. The four critics (visual, experience, code/security, student) run once per test build, on the real extension.
9. **Only spike what blocks a decision.** Every other check goes inside the feature that needs it.
10. **Test at the end of each phase, not per slice** (owner, 2026-11-02). This overrides rules 6 and 7 where they ask for more.
   - No new unit tests, and no spec-blind test author per slice or round. Tests already written stay.
   - Implementers prove their work with typecheck, lint, a quick run of the feature, and screenshots. They run only the existing walkthroughs that touch their files.
   - At the end of each phase: the full suite (gates 1–3), the four critics, and one short security read of any privacy, network or notes-safety work in that phase.
   - The walkthrough suite (gate 1) stays at 250 tests or fewer (owner, 2026-11-06). Before adding one, merge it into an existing test as a step.

## Standing constraints

- Never put model ID strings (such as `claude-…` ids) in commits, PR text, code, comments or docs. The one exception is the Co-Authored-By and Claude-Session trailer lines the session gives, which end every commit message.
- Push to the feature branch (currently `release1/phase0-1`). Never open a PR unless asked.
- Third-party images (press, Google, clones) stay out of the repo. `docs/research/drive-refs/third-party/` is gitignored.
- Secrets go in GitHub or Cloudflare secrets, never in chat or the repo. The API key and tokens live in an extension-private store that content scripts cannot read.
- Create nothing on Cloudflare without the owner's OK.
- @Claude defaults to Haiku 5.5. "Think harder" escalates to Opus 5.5.
- Dark mode is out of scope. Files over 1 GiB open in Chrome's own viewer (stub; not measured).

# sickofpdfs — project notes

A Chrome extension that replaces Chrome's PDF viewer. It adds comments, highlight, underline, bold and strikethrough marks, a library of learning PDFs, and @Claude. Everything runs in Chrome tabs. A cloud library on the owner's Cloudflare account comes in Release 2.

- Spec: `docs/superpowers/specs/2026-10-31-sickofpdfs-design.md`. The repo copy is normative; the Claude Doc is for discussion.
- Plan: `docs/superpowers/plans/2026-10-31-release1-phase0-1.md`.
- Phase 0 results and decisions: `docs/spikes/phase0-report.md`.
- Ledger: `.superpowers/sdd/<plan>/progress.md`. It is gitignored and local to one container. Anything that must survive goes here or in the plan.

The owner has learning disabilities and is highly intelligent. Write to them plainly, with short sentences, structure and no jargon.

## Standing process rules (set by the owner, 2026-11-01)

1. **Build a usable slice first, then harden it.**
   - Test build 1 is the viewer: takeover, scroll, zoom, select and copy, toolbar, "Back to page".
   - Test build 2 adds highlights and comments.
   - Polish comes after that.
2. **Only spike what blocks a decision.** Every other check goes inside the feature task that needs it.
3. **Run tasks in parallel by default**, each in its own git worktree. Name it `/home/user/wt-taskN` on branch `wt/taskN`, cut from the current branch head.
   - The automatic worktree option fails here, because it bases on `origin/main`.
   - Each task writes its own results file, so no two tasks edit the same document.
   - The controller cherry-picks finished work in task order.
4. **Match review effort to risk. Visual quality ranks as high as data safety (owner, 2026-11-01: "visual more important").**
   - **Data, privacy, security and engine work:** the store, takeover, network, the PDF engine and the loader. These get a real review (sonnet) and fix rounds.
   - **Visual work:** tokens, components, viewer chrome, menus, toolbars, and anything the owner sees. It gets a screenshot review: the reviewer looks at real screenshots next to the Drive and Chrome reference captures in `docs/research/drive-refs/` and the spec in `docs/research/02-drive-visual-spec.md`. That review uses a strong model with fix rounds. The aim is Drive's aesthetic, not pixel-perfect copying.
   - **Non-visual UI plumbing:** a quick review (haiku).
   - **Throwaway spike code:** no review.
5. **Fix it or drop it.** Fix cheap, small issues right away. Delete the rest; don't keep a "deferred" pile. Only requirements that a later task needs are carried, and they are written into that task's brief.
6. **Use the right-sized model.** Small and medium tasks are implemented on haiku or sonnet. Use opus only for hard ones: the engine port, render scheduling, the text layer, and visual-fidelity work (Drive components and the viewer chrome).
7. **Keep plans short.** A plan gives goals and interfaces, not exact test code.
   - The interfaces and names in a brief are binding.
   - Test code in a brief is guidance.
   - Small differences go in the task report and need no formal ruling.
8. **The owner's hands-on testing is the main critic.** The four critics (visual, experience, code/security, student) run once per test build, on the real extension, with screenshots.

## Standing constraints

- Never put model identifiers in commits, PR text, code, comments or docs. Commit messages end with the Co-Authored-By and Claude-Session trailer lines given by the session.
- Push to the feature branch (currently `release1/phase0-1`). Never open a PR unless asked.
- Third-party images (press, Google, clones) stay out of the repo. `docs/research/drive-refs/third-party/` is gitignored.
- Secrets go in GitHub or Cloudflare secrets, never in chat or the repo. The API key and tokens live in an extension-private store that content scripts cannot read.
- Create nothing on Cloudflare without the owner's OK.
- @Claude defaults to Haiku 5.5. "Think harder" escalates to Opus 5.5.
- Dark mode is out of scope. Files over 1 GiB open in Chrome's own viewer (stub; not measured).

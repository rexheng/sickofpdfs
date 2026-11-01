# Gate 2: the engine reference set

This gate catches any PDF page that silently starts to **render, extract or select
differently** after an engine or text-layer change. It runs about 20 real PDFs
through the viewer's own PDFium, in plain Node (no browser), and compares every
page with a committed baseline of hashes.

- `manifest.json` lists the PDFs (19 now).
- `baseline.json` holds the recorded hashes. **No PDF and no picture is committed**, only hashes and numbers.
- `../../../scripts/gates/engine-golden.mjs` is the script.

## Run it

```
pnpm fixtures          # once: makes the fixture PDFs in test-assets/ (git-ignored)
pnpm golden:check      # about 20 s
```

It fetches any missing real PDF into `test-assets/` by URL and checks its SHA-256
first. A file that does not match stops the run with exit code 2 ("input check
failed"); that is a changed input, not an engine difference.

`merge-wave.mjs` runs `golden:check` on its own whenever a round touches
`packages/viewer/src/backend/`, `packages/viewer/src/text-layer/` or `patches/`.

| Exit | Meaning |
| --- | --- |
| 0 | Every covered page matches the baseline. |
| 1 | Something differs. Each changed page is listed with what changed. |
| 2 | Bad inputs: a missing or changed PDF, a bad argument, no baseline. |

## What is recorded for each page

| What | How it is compared |
| --- | --- |
| Page count | Per document. |
| `getPageText` | SHA-256. |
| `getPageChars` (the raw chars) | SHA-256, and its length must equal `FPDFText_CountChars`. A page where it does not is an **error whatever the baseline says**, and cannot be recorded. |
| `getTextRangeRects` | For 3 char ranges of 24 chars (the start, the middle, one across a line break): the rectangles rounded to 0.1 pt. The ranges are stored in the baseline, so a later run measures the same chars. A page with fewer chars has fewer ranges. |
| The page rendered at 96 DPI, with annotations and form fields | A 64-bit dHash and a 64-bit pHash, and an **exact hash** (SHA-256 of the picture averaged down 4 times in each direction). |

A render counts as **changed** when its perceptual distance is over 4 bits (of 64,
on either hash) **or** its exact hash differs. Both are printed. In practice the
exact hash is the sharp one: a whole page of text drawn in the wrong font moves
the perceptual hashes by only 2 to 4 bits.

A document of more than 100 pages is sampled: pages 1 to 5, the last 5, and every
10th page (10, 20, 30, ...). The book (714 pages) covers 80 pages; the scan (120
pages) covers 21. A page count change shows up as a document-level difference.

## When it fails

For every changed render the gate writes three pictures into
`test-assets/golden-diff/` (git-ignored; the folder is emptied at the start of each
run):

```
<pdf>-p<page>-before.png   the baseline's render
<pdf>-p<page>-after.png    the render now
<pdf>-p<page>-diff.png     the "after" faded, with every changed pixel painted red
```

The baseline holds only hashes, so the "before" picture comes from
`test-assets/golden-cache/`, a local copy of the baseline's own renders. `golden:record`
fills it, and so does any run that matches the baseline. On a machine that has never
had a green run, a difference shows the "after" picture only; check out the baseline
commit, run `pnpm golden:check` once, then come back.

Text differences print the first place the chars differ (from the same cache).

Then **look at the pictures** and decide:

- It is a bug: fix the code and run `pnpm golden:check` again.
- It is a deliberate improvement: approve it (below).

## Approve a change

A difference is shown, then approved or rejected. It is never re-recorded silently.

```
pnpm golden:record -- --approve paper-50:1-2          # pages 1 and 2 of paper-50
pnpm golden:record -- --approve resnet:5,attention:*  # page 5 of resnet, all of attention
```

Each entry is `pdf:page`, `pdf:first-last` or `pdf:*`. The page numbers are the
covered pages (1-based, as a reader sees them). `pdf:*` re-records the whole document,
including its page count and sampled page list; use it when a document or its manifest
entry changed. There is no way to approve every PDF at once: for an engine upgrade,
approve each PDF after you have looked at its pictures.

`golden:record` re-records **only** the pages you name. Pages that differ but are not
named stay different, and `golden:check` keeps failing on them. `--all` (record
everything) is accepted **only when no baseline exists yet**.

Commit only `baseline.json` (and `manifest.json` when it changed). Put the reason for
the approval in the commit message.

## Add a PDF

1. Pick a file that is openly licensed, or that the owner can fetch freely. **Do not
   commit the PDF.**
2. Add an entry to `manifest.json`:
   - A real PDF: `"source": "fetch"`, `path` (under `test-assets/`; reuse
     `figures/...` or `classifier/...` when the file is already in one of those
     sets), `url`, `sha256`, `bytes`, `license`, and a one-line `covers` (what risk it
     adds). Get the hash with `curl -sL <url> | sha256sum`.
   - A generated PDF: `"source": "fixture"`, `path`, `made_by`, and `sha256`/`bytes`
     (or `null` when the generator is not byte-for-byte reproducible, for example it
     writes a creation date; the per-page hashes still cover it). Add the generator to
     `scripts/fixtures/build.mjs`.
3. `pnpm golden:record -- --approve <id>:*`
4. `pnpm golden:check` twice, to see that it is stable. Commit `manifest.json` and
   `baseline.json`.

`golden:check` fails on a manifest PDF that has no baseline, and on a baseline entry
that has no manifest PDF, so nothing is silently left uncovered.

## Notes

- The script starts PDFium the way `engine.worker.ts` does (the engine, then
  `installBundledFonts`, before any document opens) and reads the fonts from the
  installed packages instead of over the network. If the worker's start-up changes,
  change `startEngine()` in the script to match.
- A run is deterministic: PDFium runs as wasm, and the hashes use whole numbers (the
  pHash rounds its coefficients).
- The licences differ. The figure-set papers are CC BY 4.0, the IRS form is a US
  government work, and the fixtures are ours. ResNet and Attention (arXiv's
  non-exclusive licence) and the Boyd book (free to download, copyrighted) are not open
  licences: they are fetched by URL for the check and never committed; only their hashes
  are.

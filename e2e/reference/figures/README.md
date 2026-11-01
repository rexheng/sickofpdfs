# Figure reference set (Phase 2, slice S10)

This is the answer key for figure detection. Slice S12's detector is scored against it (Gate 2, research 06 section 3.7).

- 30 open-licence papers, 523 pages, 209 of them with a figure or table on them.
- 267 hand-drawn boxes: 190 figures, 3 algorithm boxes, 74 tables.
- One paper has no figures and no tables. It is there on purpose, to catch false alarms.
- The five Phase 0 tuning papers (ResNet, Attention, XGBoost, AlphaFold, Deep hedging) are not in the set.

## Files

| File | What it holds |
| --- | --- |
| `manifest.json` | One item per paper: URL, SHA-256, licence, size, page count, PDF info, a note on what makes the paper hard. Same layout as `docs/research/classifier-fixtures/manifest.json`. |
| `labels.json` | The boxes. One line per box. |
| `README.md` | This file. |

The PDFs and every page image stay out of the repo. They are third-party files. Fetch the PDFs yourself (below).

## Licences

All 30 papers are CC BY 4.0:

- 22 from arXiv (the abstract page of each shows the licence),
- 4 from PLOS ONE,
- 2 from eLife,
- 2 from Frontiers (licence read from Crossref).

CC BY needs credit to the authors. Each `source_page` names them. We do not copy the papers into the repo.

## Fetching the PDFs

`manifest.json` has `cache_dir: "test-assets/figures"`. That folder is git-ignored with the rest of `test-assets/`.

```sh
node -e '
const m = require("./e2e/reference/figures/manifest.json");
for (const i of m.items) console.log(i.sha256 + "  " + i.file + "  " + i.url);
' | while read sha file url; do
  curl -sSL -o "test-assets/figures/$file" "$url"
  echo "$sha  test-assets/figures/$file" | sha256sum -c -
done
```

Make the folder first (`mkdir -p test-assets/figures`). All 30 files were fetched a second time on 2026-11-01 and every hash matched. The arXiv links name the version (`v1`, `v2`), so they stay put.

Treat the files as untrusted data. Open them only with the engine.

## `labels.json`

```json
{ "pageIndex": 3, "kind": "table", "label": "Table 2",
  "rect": { "x": 62.8, "y": 216.3, "width": 229.5, "height": 114.5 },
  "captionOnPage": true }
```

- `pageIndex`: 0-based, as in `PdfBackend`.
- `kind`: `figure` or `table`.
- `label`: the caption label as printed, such as `Figure 3`, `Table A1`, `Supplementary Figure 1`.
- `rect`: a `PdfRect` in points. It is in unrotated page space, with the origin at the top-left of the crop box and y growing down (`packages/viewer/src/backend/types.ts`). Every page in the set has `/Rotate 0` and a crop box that starts at (0, 0).
- `captionOnPage`: false only for the second page of a table that continues without a new caption (two boxes, both in `arxiv-2101.03214`).
- `variant: "algorithm"`: an algorithm listing. S12 adds "Algorithm" captions, so these are labelled as figures. A scorer can count them or leave them out.
- `part` and `parts`: a table that runs over several pages (`arxiv-2101.03214` Tables 2 and 4, `arxiv-2105.00587` Table A1). Each page has its own box.

### What a box covers

- **Figure:** everything drawn for it. That means all panels, panel letters, axis labels, legends, colour bars and a frame, if the figure has one. All panels of one figure are one box.
- **Table:** the table body, from the top rule or the header row to the bottom rule or the last row. Table notes under the bottom rule are not in the box.
- **Never in the box:** the caption, the "Source:" line, the DOI link line under a PLOS caption.
- **Algorithm:** the whole framed listing, including its title line, because the title is inside the frame.
- Journal logos, page headers, equations and boxed text are not labelled.
- Edges are within about 1 point of the ink. A box counts as found at IoU 0.7 or more, so that is far tighter than the test needs.

### How to score (Gate 2)

- A detection matches a label when it is on the same page and the IoU is at least 0.7. Match one to one, best IoU first.
- **Precision:** of the figures the detector would outline, the share that match a label.
- **Recall:** of the labels with `captionOnPage: true`, the share that are matched.
- Report tables and figures separately as well as together.

## How the labels were made

The detector was never run, and its code was not used. The labels are an independent truth.

1. **Where the captions are.** `pdftotext -bbox-layout` (poppler) gave caption lines and their positions as a plain text search. This was only a starting list.
2. **Looking at pages.** Pages were drawn with the product engine, `createEmbedPdfBackend(...).renderTile` (the same PDFium wasm as the spike), at the page's own size, with a point grid on top. Contact sheets of every page showed which pages hold figures. I drew a rough box for each figure and table by eye, between the white gaps around it.
3. **Snapping.** A throwaway script found the tight ink bounds inside each rough box. Caption lines and neighbouring text were whited out first, so they never count as ink. Where the table's own rule or a panel edge was cut off, I moved the rough box and snapped again. A few boxes (one table whose right edge touches column text) were set by hand from word positions.
4. **Coverage check.** Every caption-like line in every paper was matched to a box. No line was left over. Pages without a box were drawn as thumbnail sheets and looked at, to see that no uncaptioned figure was missed. None was.

### How the boxes were checked

- Each box was drawn over its page and looked at, with a margin around it so a cut edge shows.
- Then each side where the snap stopped exactly at my rough limit was tested again 30 points further out, with other text whited out. Every real cut was fixed. Boxes in six papers were cut short or too loose (a figure frame, a wide figure, a table rule, a table top under its caption) and were redrawn.
- Then a geometry test over all 267 boxes: inside the page, no overlap with another box, no box over its own caption line, a caption with the same label on the page. Everything it reported was looked at. All of it was expected: algorithm titles inside their frames, the two table continuations with no caption, one caption that shares a text row with another, and a few boxes with white space or a footnote between the box and the caption.
- Last, the committed `labels.json` was drawn over the second download of the PDFs. That proves the file and the hashes agree.

One person drew the labels. No second labeller checked them, so there is no agreement figure.

## Hard cases in this set

- `arxiv-2209.00346`: no figure and no table, but about 180 small image masks (type-3 bitmap glyphs). Any detection here is wrong.
- `arxiv-2101.03214`: captions read `Table 1 Evolution ...` with one space and no colon. The caption pattern in research 06 section 3.3 does not match them. Tables 2 and 4 continue on the next page with no caption.
- `arxiv-2101.01065`, `arxiv-2007.12749`, `plos-0282297`, `elife-76000`: body lines that start with a figure name (`Figure 2. The sources ...`, `Fig 3. This is ...`, `Figure 1 continued on next page`). They are not captions.
- `arxiv-2205.15661`: a table and a figure side by side, with their two captions in the same text row.
- `arxiv-2106.01455`: two different tables are both captioned `Table 1`.
- `arxiv-2110.11446`: algorithm boxes, small figures, a table with a one-line caption.
- `arxiv-2208.14959`: portrait and landscape pages mixed. Tables run full width.
- `elife-74510`: Table 1 is set sideways. Its text is rotated on an upright page.
- Word exports (`arxiv-2201.12625`, `arxiv-2101.03214`, `arxiv-2101.01065`, `arxiv-2208.14959`) are tagged PDFs. The rest are not.

## What this set does not cover

- No scanned pages (Release 1 does not detect on scans).
- No page with `/Rotate` other than 0. Figures on rotated pages need a separate set.
- No figure without a caption. I looked and found none.
- Latin text only.

## Changing the set

Do not retune the labels to make a detector pass. If a box is wrong, fix it, say why in the commit, and re-run the detector against the new file. To add a paper: fetch it, label it the same way without the detector, add it to both files, and fetch it twice to check the hash.

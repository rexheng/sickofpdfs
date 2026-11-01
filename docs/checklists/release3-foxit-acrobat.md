# Release 3 hand check: Foxit and Acrobat (W-F1, decision D8.1)

This takes about 10 minutes. You need a Windows PC with **Foxit** and **Acrobat Reader** (or Acrobat).

The question: when you open a PDF we exported, do our notes and replies show up the way they should?

We cannot run Foxit or Acrobat in the build container. So we made three files. They hold the same notes. They differ only in how the **replies** are written. You tell us which one looks best.

## The files

They are in `test-assets/export-samples/`. They are copies of the NBER paper (pages 1 and 2 have notes).

| File | How replies are written |
| --- | --- |
| `sample-A-threaded-empty-appearance.pdf` | Each reply is its own note, linked to its comment. It draws nothing on the page. **This is our proposed default.** |
| `sample-B-threaded-hidden.pdf` | Each reply is its own note, linked to its comment, and marked "hidden". |
| `sample-C-folded.pdf` | No separate replies. Each reply is added as a line of text inside the comment it answers. |
| `sample-D-rotated-and-cropped-pages.pdf` | Optional. Four pages that are turned and trimmed. One highlight, one bold phrase and one pin per page. |

Do not edit or save these files in place. Open them, look, close.

## What is in A, B and C

Same in all three. The author is "Rex Heng" unless it says Claude.

**Page 1**

1. A yellow highlight over "This work is a component of a larger project on income risk". It runs over two lines.
2. A green underline under "Stefanie Stantcheva".
3. A pink line through "Working Paper 29000".
4. An orange highlight over "NBER working papers are circulated for discussion". It has a comment, "TA root", and two replies: "TA reply 1, from Claude" and "TA reply 2, from you".
5. A grey dotted underline under "peer-reviewed or been subject to the review". It has a comment, "TB root", and one reply.
6. A gold box with a comment, "TC root", and one reply from Claude.
7. A small note icon on the right side: "A pin on the page".
8. Two small note icons in the top-left corner: "A note on the whole page" and "A note on the whole document".

**Page 2**

9. The words "idiosyncratic and exogenous changes" in bold.
10. A gold box with no comment, near the addresses.
11. A blue highlight over "event-study design". It has a comment, "TD root", and three replies. They should read in this order: reply 1 (you), reply 2 (Claude), reply 3 (you).

In C the replies are not separate. Each is a line inside its comment.

## Steps, for each reader (Foxit, then Acrobat), for each file (A, B, C)

Write your answer in the table at the bottom. A word or a tick is enough.

1. **Open the file.** Does it open without any message? Write down any message, such as "repaired" or "damaged" or "changed".
2. **Look at page 1.** Do you see the 8 things above? Which are missing?
3. **Look for extra icons.** In A and B, there should be **no** extra note icon on top of the highlights or the dotted underline. Small icons there are "ghost icons", one for each reply. Write down if you see them.
4. **Open the comments list.** In Acrobat: Comment tool, then the comments pane. In Foxit: Comment menu, Comments panel.
   - Are all 7 comments there ("TA", "TB", "TC", the pin, the page note, the document note, "TD")?
   - In A and B: are the 7 replies **under** their own comments, in order? Or are they listed on their own?
   - In C: do you see the reply lines inside each comment?
5. **Open one comment's pop-up** (click the orange highlight, or double-click it). Do you see the comment and its replies? Is "Claude" shown as an author?
6. **Page 2.** Is the bold text bold? Do the three replies of "TD" read in order?
7. **Print preview** (or Print to PDF). Do the marks print? Do replies, pop-ups and ghost icons stay off the paper?
8. **Close the file.** Does the reader ask to save changes? Write that down.

## Then tell us

- Which of A, B or C looked best in **Foxit**?
- Which looked best in **Acrobat**?
- If they differ, which one should we use? (We will pick the one that works in both. If none does, tell us what went wrong.)

## Optional: file D, a turned page

Open `sample-D-rotated-and-cropped-pages.pdf`. On each of the 4 pages, the yellow highlight should cover exactly three words. One other phrase should be bold. A note icon should sit upright. Tell us if a highlight sits in the wrong place or on the wrong words.

## Optional: help the import check

If you can, make two small files and put them in `test-assets/export-samples/from-readers/`:

- Open any PDF in **Foxit**. Add a highlight with a comment, a reply to it, and a sticky note. Save as `foxit-annotated.pdf`.
- Do the same in **Acrobat**. Save as `acrobat-annotated.pdf`.

We use them to check that notes made in those apps come into our viewer as editable notes.

## Your answers

| Reader | File | Opens clean? | All 8 on page 1? | Ghost icons? | Replies under comments? | Print clean? | Asks to save? | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Foxit | A | | | | | | | |
| Foxit | B | | | | | | | |
| Foxit | C | | | | | | | |
| Acrobat | A | | | | | | | |
| Acrobat | B | | | | | | | |
| Acrobat | C | | | | | | | |

Best in Foxit: ____  Best in Acrobat: ____  Use: ____

## What we do with your answer

- If **A** works in both: `replies: 'threaded'` with `replyAppearance: 'empty'` stays the default.
- If **B** works better: we switch the default to `replyAppearance: 'hidden'`.
- If neither shows replies well: we use **C** (`replies: 'folded'`) as the default and keep threads as a choice in the export dialog.
- A "repaired" or "damaged" message in either reader is a bug. Send us the file name.

// Gate 1, Phase 3 plan, item 13: "Export notes."
//   "Ctrl+Shift+E gives Markdown with quotes, page numbers, replies and a working link back."
// Spec, "Export and import": 'Release 1: "Export notes" writes Markdown with quotes, page numbers and links back.' Shortcuts: "Export notes as
// Markdown | Ctrl+Shift+E | Reading". Contracts section 5, "Markdown export": front matter with "title, authors, DOI or arXiv id, source link, and
// `sickofpdfs: { documentId, format: 1 }`. Then one `## Page N` section per page. Each item has the quote as a blockquote, a style label, the
// comment and its replies. Bold quotes render as `**...**` and strikethrough as `~~...~~`. Highlight and underline get a label ... The link back is
// the canonical web link plus `#page=N`; for a file-only document it is the viewer link with `doc` and `page`." Carried ruling: "Markdown puts
// document notes first and leaves drafts out." Contracts: "PDF text, quotes and titles are untrusted" (a note that holds HTML must not become HTML).
//
// The paper "Attention Is All You Need" (arXiv). Page 1 gets: a note with a reply, a bold passage, a struck passage, an underlined passage, a
// highlighted passage, and a note whose text is a <script> tag. Page 3 gets a note on a heading (the page number must be right, and its link back
// must open page 3). A note on the whole paper goes first. The second test does the same for a file that has only a path on this computer.
//
// Guard: EXPORT_IN_VIEWER (the viewer's code uses exportMarkdown, contracts section 5).
// GUESSES: the download is started by an <a download> (Playwright's "download" event); the Markdown names the styles "highlight" and "underline";
// the link back is a Markdown link whose target ends in #page=N; because canonical links are made https, the test opens the link with its scheme
// put back to http (the fixture server speaks http).
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { copyFixture, expect, hooks, test, EXTENSION_ID } from '../support/test';
import { findOnPage, waitForTextLayer } from '../support/tl-blind.spec-blind';
import {
  ATTENTION as ATTENTION_FX,
  LINES,
  cardWith,
  openPaper,
  postNote,
  replyBox,
  saveFirst,
  selectPassage,
  type TlFixture,
} from './support/marks.spec-blind';
import { openLocalFile, readyForMarks } from './support/local-file.spec-blind';
import { OUR_VIEWER_RE } from './support/takeover';
import { ATTENTION, ATTENTION_ARXIV, EXPORT_IN_VIEWER, NO_EXPORT, note, shaOf, shotOf, sleep, waitForStore, waitViewerReady } from './support/library-p3.spec-blind';

test.skip(!EXPORT_IN_VIEWER, NO_EXPORT);
test.setTimeout(300_000);

const PAGE3: TlFixture = { ...ATTENTION_FX, name: 'attention-p3', page: 2 };
const PAGE3_PASSAGE = { from: 'Encoder and Decoder', to: 'Stacks' };
const DOC_NOTE = 'A note on the whole paper';
const COMMENT = 'First comment on page one';
const REPLY = 'A reply to the first comment';
const SCRIPT = 'Remember <script>alert(1)</script> and <b>bold</b> html';
const PAGE3_NOTE = 'Comment on the encoder stacks';

const clearFocus = async (page: Page): Promise<void> => {
  await page.keyboard.press('Escape');
  await page.mouse.click(8, (page.viewportSize()?.height ?? 800) / 2);
};

/** Marks and notes: page 1 (a note with a reply, bold, strike, underline, highlight, a script-tag note), a note on page 3, and a note on the whole paper. */
async function makeNotes(page: Page): Promise<void> {
  await postNote(page, ATTENTION_FX, LINES.l3, COMMENT);
  const card = cardWith(page, COMMENT);
  await card.click();
  await expect(replyBox(page)).toBeVisible();
  await replyBox(page).click();
  await page.keyboard.type(REPLY, { delay: 8 });
  await page.keyboard.press('Enter');
  await expect(cardWith(page, REPLY)).toBeVisible({ timeout: 5000 });
  await clearFocus(page);

  await selectPassage(page, ATTENTION_FX, LINES.l5);
  await page.keyboard.press('Control+b');
  await page.waitForTimeout(300);
  await selectPassage(page, ATTENTION_FX, LINES.l7);
  await page.keyboard.press('Alt+Shift+5');
  await page.waitForTimeout(300);
  await selectPassage(page, ATTENTION_FX, LINES.l9);
  await page.keyboard.press('Control+u');
  await page.waitForTimeout(300);
  await selectPassage(page, ATTENTION_FX, LINES.l11);
  await page.keyboard.press('h');
  await page.waitForTimeout(300);
  await clearFocus(page);

  await postNote(page, ATTENTION_FX, LINES.l1, SCRIPT);
  await clearFocus(page);

  await hooks(page).eval((h, i) => h.viewer.scrollTo(i), PAGE3.page);
  await waitForTextLayer(page, PAGE3.page);
  await postNote(page, PAGE3, PAGE3_PASSAGE, PAGE3_NOTE);
  await clearFocus(page);

  await hooks(page).eval((h, i) => h.viewer.scrollTo(i), 0);
  await page.keyboard.press('Control+Alt+Shift+m'); // a note on the whole paper
  await expect(page.getByRole('textbox', { name: /note|comment/i }).first()).toBeVisible({ timeout: 3000 });
  await page.keyboard.type(DOC_NOTE, { delay: 8 });
  await page.keyboard.press('Enter');
  await expect(cardWith(page, DOC_NOTE)).toBeVisible({ timeout: 5000 });
  await clearFocus(page);
  await sleep(1000);
}

/** Ctrl+Shift+E, and the Markdown it downloads. */
async function exportNotes(page: Page): Promise<{ name: string; md: string }> {
  await page.bringToFront();
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 20_000 }), page.keyboard.press('Control+Shift+e')]);
  const path = await download.path();
  return { name: download.suggestedFilename(), md: await readFile(path, 'utf8') };
}

const indentOf = (line: string): number => (/^[\s>]*/.exec(line)?.[0] ?? '').length;
const sectionOf = (md: string, n: number): string => {
  const parts = md.split(/^## Page (\d+)\b.*$/m);
  const at = parts.findIndex((p, i) => i % 2 === 1 && Number(p) === n);
  return at < 0 ? '' : parts[at + 1];
};

test('Exporting notes as Markdown, with links back that work, also for a paper that is only a local file', async ({ step }, testInfo) => {
  test.setTimeout(600_000);
  await step('Ctrl+Shift+E gives Markdown with front matter, quotes, page numbers, replies, styles and links back that work', async ({ context, openViewer, server }) => {
    const page = await openPaper(openViewer, server, ATTENTION_FX);
    await waitForStore(page);
    const id = await saveFirst(page);
    await makeNotes(page);
    await shotOf(page, testInfo, '01-marked-up');

    const { name, md } = await exportNotes(page);
    note(testInfo, 'the Markdown file is called', name);
    testInfo.annotations.push({ type: 'the Markdown', description: md.slice(0, 3000) });
    expect(name, 'named by the paper and the first 8 digits of its fingerprint, as a .md').toMatch(new RegExp(`-${id.slice(0, 8)}\\.md$`));

    // front matter
    const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(md);
    expect(front, 'the file starts with front matter between --- lines').not.toBeNull();
    const fm = front![1];
    expect(fm, 'it has the title').toMatch(ATTENTION.title);
    expect(fm, 'the arXiv id').toContain(ATTENTION_ARXIV);
    expect(fm, 'the source link').toMatch(/https?:\/\/127\.0\.0\.1:\d+\/f\/classifier\/learning\/arxiv-1706\.03762-attention\.pdf/);
    expect(fm, 'sickofpdfs: { documentId, format: 1 }').toMatch(/sickofpdfs:/);
    expect(fm).toContain(id);
    expect(fm).toMatch(/format:\s*1\b/);

    // the body: the note on the whole paper first, then one section per page
    const body = md.slice(front![0].length);
    const firstPage = body.search(/^## Page \d+/m);
    expect(firstPage, 'there are page sections').toBeGreaterThan(-1);
    expect(body.indexOf(DOC_NOTE), 'the note on the whole paper comes first').toBeGreaterThan(-1);
    expect(body.indexOf(DOC_NOTE), 'before the first page section').toBeLessThan(firstPage);
    expect([...body.matchAll(/^## Page (\d+)/gm)].map((m) => Number(m[1])), 'sections for page 1 and page 3, in order').toEqual([1, 3]);

    // page 1
    const p1 = sectionOf(md, 1);
    expect(p1, 'a quote as a blockquote').toMatch(/^>.*dominant sequence transduction/im);
    expect(p1, 'a bold passage is **...**').toMatch(/\*\*[^*]*based solely on attention[^*]*\*\*/);
    expect(p1, 'a struck passage is ~~...~~').toMatch(/~~[^~]*be superior in quality[^~]*~~/);
    expect(p1, 'an underlined passage is labelled').toMatch(/underline/i);
    expect(p1, 'a highlighted passage is labelled').toMatch(/highlight/i);
    expect(p1, 'the comment is there').toContain(COMMENT);
    const lines = p1.split('\n');
    const rootLine = lines.find((l) => l.includes(COMMENT))!;
    const replyLine = lines.find((l) => l.includes(REPLY));
    expect(replyLine, 'and its reply').toBeDefined();
    expect(indentOf(replyLine!), 'the reply is indented under the comment').toBeGreaterThan(indentOf(rootLine));
    expect(p1, 'a note that holds HTML is not written out as HTML').not.toMatch(/<script/i);
    expect(p1, 'but its words are still there').toContain('alert(1)');
    expect(p1, 'a link back to page 1').toMatch(/\]\(https?:\/\/127\.0\.0\.1:\d+\/f\/classifier\/learning\/arxiv-1706\.03762-attention\.pdf#page=1\)/);

    // page 3
    const p3 = sectionOf(md, 3);
    expect(p3, 'the note on page 3 is under "Page 3"').toContain(PAGE3_NOTE);
    expect(p3, 'with its quote').toMatch(/^>.*Encoder and Decoder/im);
    expect(p1, 'and not under page 1').not.toContain(PAGE3_NOTE);
    const back = /\]\((https?:\/\/[^\s)]+#page=3)\)/.exec(p3);
    expect(back, 'a link back to page 3').not.toBeNull();

    // the link back works: it opens the paper in our viewer, on page 3
    const link = back![1].replace(/^https:/, 'http:');
    const tab = await context.newPage();
    await tab.goto(link).catch(() => {});
    await expect.poll(() => tab.url(), { message: 'the link opens our viewer', timeout: 20_000 }).toMatch(OUR_VIEWER_RE);
    await waitViewerReady(tab);
    await expect.poll(() => hooks(tab).eval((h) => h.viewer.currentPage()), { message: 'on page 3', timeout: 20_000 }).toBe(2);
    await shotOf(tab, testInfo, '02-link-back-opens-page-3');
  }, 300_000);
  await step('a paper that is only a file on this computer links back to the saved copy in the viewer, with its doc and page', async ({ context, tmp }) => {
    const file = await copyFixture(ATTENTION.file, join(tmp, 'Downloads', 'attention.pdf'));
    const sha = await shaOf(ATTENTION);
    const page = await openLocalFile(context, pathToFileURL(file).href);
    await readyForMarks(page);
    await saveFirst(page);
    await postNote(page, ATTENTION_FX, LINES.l3, COMMENT);
    await clearFocus(page);

    const { md } = await exportNotes(page);
    testInfo.annotations.push({ type: 'the Markdown', description: md.slice(0, 2000) });
    expect(md).toContain(COMMENT);
    const link = new RegExp(`\\]\\((chrome-extension://${EXTENSION_ID}/viewer\\.html\\?[^\\s)]*doc=${sha}[^\\s)]*)\\)`).exec(md);
    expect(link, `a file-only document links back to the viewer with doc=<fingerprint> and a page (looked for chrome-extension://${EXTENSION_ID}/viewer.html?...doc=${sha.slice(0, 8)}...)`).not.toBeNull();
    expect(link![1], 'and a page').toMatch(/page=1\b/);

    const tab = await context.newPage();
    await tab.goto(link![1]);
    await waitViewerReady(tab);
    await expect(cardWith(tab, COMMENT), 'the link opens the saved copy with its note').toBeVisible({ timeout: 20_000 });
    const where = await findOnPage(tab, 0, 'Attention Is All You Need').catch(() => null);
    expect(where, 'on the right document').not.toBeNull();
    await shotOf(tab, testInfo, '03-file-only-link-back');
  }, 300_000);
});

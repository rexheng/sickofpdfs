// Walkthrough: a file or link that cannot be opened shows a clear error card with a way out.
// Interface file (copy): the card's title is "Couldn't load this PDF" (http / network / damaged) or "This link didn't return a PDF"
// (not a PDF); its buttons are "Open in Chrome's viewer" and "Import this PDF" (backed by a hidden file input for PDFs).
// Spec, Reading basics / Escape hatch: "Open in Chrome's viewer ... always available"; non-negotiable: "plain, clear wording in the UI".
import { REAL, FIXTURES, ensureCorrupt, ensureEmpty, served } from './support/fixtures.spec-blind';
import { mockUrl } from './support/mock.spec-blind';
import { expect, rt, snap, test, waitForFirstPage } from './support/viewer.spec-blind';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const COULDNT = /Couldn't load this PDF/;
const NOT_A_PDF = /This link didn't return a PDF/;

test.beforeAll(async () => {
  await ensureCorrupt();
  await ensureEmpty();
});

const CASES: { name: string; title: RegExp; source: (server: { url(p: string): string }) => string }[] = [
  { name: 'a damaged PDF (a PDF header, then junk)', title: COULDNT, source: (s) => s.url(served(FIXTURES.corrupt)) },
  { name: 'a link that returns a web page instead of a PDF', title: NOT_A_PDF, source: (s) => mockUrl(s, { status: 200, contentType: 'text/html', body: '<html><body><h1>Please sign in</h1></body></html>' }) },
  { name: 'a link that returns 404', title: COULDNT, source: (s) => s.url('/f/walkthroughs/this-file-does-not-exist.pdf') },
  { name: 'an empty file', title: /Couldn't load this PDF|This link didn't return a PDF/, source: (s) => s.url(served(FIXTURES.empty)) },
];

for (const c of CASES) {
  test(`${c.name} shows a plain error card with two ways out`, async ({ openViewer, server }, testInfo) => {
    const page = await openViewer(c.source(server));
    const card = page.getByText(c.title).first();
    await expect(card, 'the error card title').toBeVisible({ timeout: 15_000 });
    expect(await rt(page).state()).toBe('error');
    await expect(page.getByRole('button', { name: /Open in Chrome.s viewer/ }).or(page.getByRole('link', { name: /Open in Chrome.s viewer/ }))).toBeVisible();
    await expect(page.getByRole('button', { name: /Import this PDF/ })).toBeVisible();
    // Plain words: no codes, class names or stack traces on a card an ordinary person reads.
    const text = await page.locator('body').innerText();
    expect(text, 'no raw error text on the card').not.toMatch(/PdfFormatError|PdfLoadError|PdfPasswordError|TypeError|undefined|\bnull\b|\bat \w+ \(|\.tsx?:\d+|stack/i);
    // Nothing is half-drawn behind the card.
    expect(await page.locator('[role="document"] canvas').count(), 'no page canvases behind an error card').toBe(0);
    await snap(page, testInfo, '07-error-card');
  });
}

test('"Open in Chrome\'s viewer" takes the tab out of our viewer to the PDF itself', async ({ openViewer, server }, testInfo) => {
  const url = server.url(served(FIXTURES.corrupt));
  const page = await openViewer(url);
  await page.getByRole('button', { name: /Open in Chrome.s viewer/ }).or(page.getByRole('link', { name: /Open in Chrome.s viewer/ })).click({ timeout: 15_000 });
  await expect.poll(() => page.url(), { message: 'the tab left our viewer', timeout: 15_000 }).not.toContain('viewer.html');
  expect(new URL(page.url()).origin, "the tab is at the PDF's own address").toBe(server.origin);
  await page.waitForTimeout(1_500);
  expect(page.url(), 'and stays there (our takeover does not pull it straight back)').not.toContain('chrome-extension://');
  await testInfo.attach('after-open-in-chrome-url.txt', { body: page.url(), contentType: 'text/plain' });
});

test('"Import this PDF" lets the owner pick another file, which opens in place of the card', async ({ openViewer, server }, testInfo) => {
  const page = await openViewer(server.url(served(FIXTURES.corrupt)));
  const importButton = page.getByRole('button', { name: /Import this PDF/ });
  await expect(importButton).toBeVisible({ timeout: 15_000 });
  const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 10_000 }), importButton.click()]);
  expect(chooser.isMultiple(), 'one file at a time').toBe(false);
  await chooser.setFiles(REAL.paper50.file);

  await waitForFirstPage(page);
  await expect(page.getByText(COULDNT), 'the card is gone').toBeHidden();
  const doc = await rt(page).doc();
  const bytes = await readFile(REAL.paper50.file);
  expect(doc!.displayName).toMatch(/paper-50/);
  expect(doc!.sourceUrl, 'an imported file has no web address').toBeNull();
  expect(doc!.size).toBe(bytes.length);
  expect(doc!.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  expect(doc!.pageCount).toBe(REAL.paper50.pages);
  await snap(page, testInfo, '07-imported-after-error');
});

// Walkthrough: a file larger than 1 GiB goes to Chrome's own viewer, with a notice first.
// Spec, Reading basics / Large files: "Up to 1 GB opens normally; larger files (size read from the download header) open in
// Chrome's viewer with a note." Interface file: MAX_OPEN_BYTES = 1_073_741_824; on too-large with a web address the viewer shows
// "This PDF is {size} GB, larger than the 1 GB this viewer opens. Opening it in Chrome's viewer..." with an "Open now" button and
// sends takeover:open-in-chrome after 2000 ms.
// The size comes from the response header, so the fixture server's /mock route (a Content-Length and no body: headers are sent, then
// the socket is held) stands in for the huge file; no gigabyte is ever sent. Guess: the limit is "larger than", so exactly 1 GiB opens.
import { budgetMs, budgetNote } from '../support/perf-budget';
import { mockUrl } from './support/mock.spec-blind';
import { expect, rt, snap, test } from './support/viewer.spec-blind';

const GIB = 1_073_741_824;
// TB1 wording ruling (chrome polish): one number, "This PDF is too big for this viewer (1.5 GB)", not two to compare.
const NOTICE = /This PDF is too big for this viewer \([\d.]+ GB\)/;

test('a 1.5 GB PDF: a plain notice, time to read it, then Chrome\'s viewer', async ({ openViewer, server }, testInfo) => {
  const url = mockUrl(server, { status: 200, contentType: 'application/pdf', contentLength: Math.round(1.5 * GIB) });
  const page = await openViewer(url);
  const notice = page.getByText(NOTICE);
  await expect(notice, 'a notice says the file is too large for this viewer').toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/\(1\.[56] GB\)/), 'it says how big the file is, in GB').toBeVisible();
  await expect(page.getByText(/Chrome.s viewer/).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Open now/ }), 'with a way to go now').toBeVisible();
  await snap(page, testInfo, '08-large-file-notice');

  // The owner gets a moment to read it: the bounce is 2 s after the notice, so a second later we are still here.
  await page.waitForTimeout(900);
  expect(page.url(), 'still in our viewer, reading the notice').toContain('viewer.html');
  await expect(notice).toBeVisible();

  // Then the tab goes to Chrome's viewer by itself: the PDF's own address, and it stays there.
  await expect.poll(() => page.url(), { message: "the tab went to Chrome's viewer", timeout: 10_000 }).toBe(url);
  await page.waitForTimeout(1_500);
  expect(page.url(), 'and is not pulled back into our viewer').toBe(url);
  await testInfo.attach('after-bounce-url.txt', { body: page.url(), contentType: 'text/plain' });
});

test('"Open now" goes to Chrome\'s viewer at once', async ({ openViewer, server }) => {
  const url = mockUrl(server, { status: 200, contentType: 'application/pdf', contentLength: 2 * GIB });
  const page = await openViewer(url);
  await expect(page.getByText(NOTICE)).toBeVisible({ timeout: 10_000 });
  const clicked = Date.now();
  await page.getByRole('button', { name: /Open now/ }).click();
  await expect.poll(() => page.url(), { message: 'Open now left our viewer', timeout: 10_000 }).toBe(url);
  // Sooner than the automatic 2 s wait; a smoke run allows the browser more (support/perf-budget.ts).
  expect(Date.now() - clicked, `sooner than the automatic 2 s wait (${budgetNote(2_000)})`).toBeLessThan(budgetMs(2_000));
});

test('one byte over 1 GiB is turned away; exactly 1 GiB is not', async ({ openViewer, server }) => {
  const over = mockUrl(server, { status: 200, contentType: 'application/pdf', contentLength: GIB + 1 });
  const exactly = mockUrl(server, { status: 200, contentType: 'application/pdf', contentLength: GIB });

  const a = await openViewer(over);
  await expect(a.getByText(NOTICE), '1 GiB + 1 byte: notice').toBeVisible({ timeout: 10_000 });

  const b = await openViewer(exactly);
  await b.waitForTimeout(1_500); // time enough for the notice to show, if it was going to
  await expect(b.getByText(NOTICE), 'exactly 1 GiB: no notice').toBeHidden();
  expect(await rt(b).state(), 'it is waiting for the file to arrive (the mock holds the socket)').toBe('loading');
  expect(b.url()).toContain('viewer.html');
});

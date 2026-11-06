// Walkthrough: "Reloading the tab reopens the same PDF." The viewer's address holds the PDF's address (and the page the link asked
// for, as #page=N), so a reload (F5) must bring back the same document.
// Spec: Release 1, criterion 1 (the viewer replaces Chrome's in the same tab); ViewerParams carry `source` and `page` (1-based).
// Not asserted, because the spec ties it to the library of a later task: that a reload resumes where the owner stopped reading.
import { FIXTURES, REAL, ensureBook, served } from './support/fixtures.spec-blind';
import { expect, note, rt, snap, test, waitForFirstPage, waitForPageOnScreen } from './support/viewer.spec-blind';

test.beforeAll(async () => {
  await ensureBook();
});

test('Reloading the tab reopens the same PDF, at the page the link asked for', async ({ step }, testInfo) => {
  test.setTimeout(180_000);
  await step('reloading the tab reopens the same PDF, the same file, drawn again', async ({ openViewer, server }) => {
    const path = REAL.paper50.url;
    const page = await openViewer(server.url(path));
    await waitForFirstPage(page);
    const before = await rt(page).doc();
    const address = page.url();

    await page.reload();
    await waitForFirstPage(page);
    await snap(page, testInfo, '09-after-reload');
    expect(page.url(), 'the address is unchanged by a reload').toBe(address);
    const after = await rt(page).doc();
    expect(after, 'a document is open again').not.toBeNull();
    expect(after!.sha256, 'it is the same file').toBe(before!.sha256);
    expect(after!.displayName).toBe(before!.displayName);
    expect(after!.pageCount).toBe(REAL.paper50.pages);
    expect(await rt(page).state()).toBe('ready');
    expect(server.requests(path), 'one fetch per load, no more').toBeLessThanOrEqual(2);
  }, 60_000);
  await step('reloading a link that asked for page 7 shows page 7 again', async ({ openViewer, server }) => {
    const page = await openViewer(server.url(served(FIXTURES.book)), { page: 7 });
    await waitForFirstPage(page);
    await waitForPageOnScreen(page, 7, 8_000);
    const box = (await rt(page).pageBoxes())[6];
    expect(Math.abs((await rt(page).scrollTop()) - box.top), 'page 7 is at the top of the view').toBeLessThanOrEqual(40);
    await snap(page, testInfo, '09-opened-at-page-7');

    await page.reload();
    await waitForFirstPage(page);
    await waitForPageOnScreen(page, 7, 8_000);
    expect(Math.abs((await rt(page).scrollTop()) - box.top), 'after the reload, page 7 is at the top again').toBeLessThanOrEqual(40);
    await snap(page, testInfo, '09-reloaded-at-page-7');
  }, 60_000);
  await step('reloading after scrolling elsewhere still reopens the same PDF (where it lands is recorded, not judged)', async ({ openViewer, server }) => {
    const page = await openViewer(server.url(served(FIXTURES.book)));
    await waitForFirstPage(page);
    await rt(page).scrollToPage(29);
    await waitForPageOnScreen(page, 30, 8_000);
    const doc = await rt(page).doc();
    await page.reload();
    await waitForFirstPage(page);
    expect((await rt(page).doc())!.sha256).toBe(doc!.sha256);
    const top = await rt(page).scrollTop();
    note(testInfo, 'scroll position after a reload from page 30', top <= 1 ? 'top of the document' : `${top.toFixed(0)} px (page index about ${(await rt(page).currentPage()).toString()})`);
  }, 60_000);
});

import type { Page } from '@playwright/test';
import { expect, test } from '../support/test';
import { buildViewerUrl } from '../../apps/extension/src/shared/viewer-url';
import { OUR_VIEWER, backToPage, expectOurViewer, normalize, quietFor, shot, siteTest, trackNavigations, visit } from './support/takeover';

// "A PDF shown inside a page (such as Moodle) opens in the full tab, with a 'Back to page' button" (Viewer and
// commenting, reading basics) and release 1 criterion 1. Back to page returns to the exact page, and the page's
// own PDF then stays where the page put it: the owner has chosen to read it there.

const EMBEDS = [
  { element: '<iframe>', page: '/h/iframe-page' },
  { element: '<embed>', page: '/h/embed-page' },
  { element: '<object>', page: '/h/object-page' },
] as const;

/** The page still holds its PDF (ours or Chrome's, in its frame) and the tab is still on the page: nothing took it over again. */
async function expectStaysOnPage(page: Page, pageUrl: string, nav: ReturnType<typeof trackNavigations>): Promise<void> {
  await expect.poll(() => page.url(), { message: 'Back to page returns to the exact page', timeout: 10_000 }).toBe(normalize(pageUrl));
  const visitsWhenBack = nav.ourViewerVisits();
  await quietFor(page, 2000);
  expect(page.url(), 'the page is not taken over again').toBe(normalize(pageUrl));
  expect(nav.ourViewerVisits(), 'the full-tab viewer did not open a second time').toBe(visitsWhenBack);
  expect(page.frames().length, 'the PDF is still shown inside the page').toBeGreaterThan(1);
}

test.describe('A PDF embedded in a page', () => {
  for (const embed of EMBEDS) {
    test(`as ${embed.element}: it opens full-tab in our viewer; Back to page returns to the exact page`, async ({ context, server }, testInfo) => {
      const pdf = server.url('/h/plain.pdf');
      const pageUrl = server.url(`${embed.page}?course=EC1A1&week=3#reading`);
      const page = await context.newPage();
      const nav = trackNavigations(page);
      const tabs = context.pages().length;

      await visit(page, pageUrl);

      await expectOurViewer(page, pdf, { back: pageUrl });
      await expect(backToPage(page), 'a "Back to page" button').toBeVisible();
      await shot(page, testInfo, 'full-tab-viewer-with-back-to-page');
      expect(context.pages().length, 'the same tab, no new one').toBe(tabs);

      await backToPage(page).click();

      await expectStaysOnPage(page, pageUrl, nav);
      await shot(page, testInfo, 'back-on-the-page');
    });
  }

  // The spec names the "Back to page" button only. This is the same wish with the browser's Back button, which a person
  // presses without thinking; if the page is taken over again each time, the owner cannot leave the viewer that way.
  test("and the owner presses the browser's own Back button instead: the page returns and stays, not thrown back into the viewer", async ({ context, server }, testInfo) => {
    const pdf = server.url('/h/plain.pdf');
    const pageUrl = server.url('/h/iframe-page?course=EC1A1#reading');
    const page = await context.newPage();
    const nav = trackNavigations(page);
    await visit(page, pageUrl);
    await expectOurViewer(page, pdf, { back: pageUrl });

    await page.goBack();

    await expectStaysOnPage(page, pageUrl, nav);
    await shot(page, testInfo, 'browser-back-on-the-page');
  });

  // sec1 (finding 8, ruled by the controller): this test used to expect "Back to page" here, and that button then sent
  // the owner to whatever page the address named: an open redirect, since any web page can open the viewer with any
  // back=. "Back to page" now goes only to the page the extension saw embed this PDF in this tab; a tab created straight
  // on the viewer (restored, duplicated, or opened by a page) has the browser's own Back instead.
  test('opened straight on a viewer address with a page to go back to that the extension never saw: no Back to page', async ({ context, sw, server }, testInfo) => {
    const pdf = server.url('/h/plain.pdf');
    const pageUrl = server.url('/h/iframe-page?course=EC1A1');
    const [tab] = await Promise.all([
      context.waitForEvent('page'),
      sw.evaluate((url) => chrome.tabs.create({ url }), buildViewerUrl({ source: pdf, back: pageUrl, page: null }, OUR_VIEWER)),
    ]);
    await expectOurViewer(tab, pdf, { back: pageUrl });
    await expect(tab.locator('[role="document"]'), 'the PDF opens').toBeVisible({ timeout: 15_000 });

    await expect(backToPage(tab), 'no "Back to page" for a page the extension did not see').toHaveCount(0);
    await shot(tab, testInfo, 'viewer-opened-straight-without-back-to-page');
  });

  test('that offers itself as a download (an attachment in an iframe) is left alone: the page stays and no viewer opens', async ({ context, server }, testInfo) => {
    const pageUrl = server.url('/h/iframe-attachment-page');
    const page = await context.newPage();
    const nav = trackNavigations(page);

    await visit(page, pageUrl);
    await quietFor(page, 2000);

    expect(page.url()).toBe(normalize(pageUrl));
    expect(nav.ourViewerVisits(), 'our viewer must not open for an attachment').toBe(0);
    await shot(page, testInfo, 'page-with-an-attachment-iframe');
  });
});

siteTest.describe('A PDF embedded in a page on another site', () => {
  siteTest('in an <iframe>, as on Moodle: it opens full-tab and Back to page returns to that site\'s page', async ({ context, server, site }, testInfo) => {
    const pdf = server.url('/f/paper-50.pdf');
    site.html('/mod/resource/view', `<h1>Reading 3</h1><iframe src="${pdf}" title="Reading 3" width="800" height="600"></iframe>`);
    const pageUrl = site.url('/mod/resource/view?id=42');
    const page = await context.newPage();
    const nav = trackNavigations(page);

    await visit(page, pageUrl);

    await expectOurViewer(page, pdf, { back: pageUrl });
    await expect(backToPage(page)).toBeVisible();
    await shot(page, testInfo, 'full-tab-viewer-for-an-embed-from-another-site');

    await backToPage(page).click();

    await expectStaysOnPage(page, pageUrl, nav);
  });
});

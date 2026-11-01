import type { Page, TestInfo } from '@playwright/test';
import { expect, test } from '../support/test';
import {
  clickLink,
  expectChromesOwnViewer,
  expectOurViewer,
  normalize,
  openInChromesViewer,
  quietFor,
  shot,
  siteTest,
  viewerParams,
  visit,
} from './support/takeover';

// The escape hatch ("File -> Open in Chrome's viewer, always available"): whatever PDF is open in our viewer, one
// click shows the same address in Chrome's own PDF viewer, and it stays there. The allow rule behind it is for that
// address, that tab and one visit.

/** Opens `url` in our viewer in `page`, then uses the hatch, and checks that Chrome's own viewer shows it and stays. */
async function escapeFromOurViewer(page: Page, url: string, testInfo: TestInfo): Promise<string> {
  await visit(page, url);
  await expectOurViewer(page, url);
  await shot(page, testInfo, 'our-viewer');
  const source = viewerParams(page).source!;

  await openInChromesViewer(page, source, testInfo);

  await expectChromesOwnViewer(page, source);
  await shot(page, testInfo, 'chromes-own-viewer');
  await quietFor(page, 2000);
  await expectChromesOwnViewer(page, source); // and it stays: our viewer does not take it back
  return source;
}

test.describe('You use "Open in Chrome\'s viewer"', () => {
  const ADDRESSES = [
    { name: 'a normal PDF link', path: '/f/paper-50.pdf' },
    { name: 'a PDF with no content type (found by looking at the file)', path: '/h/no-ctype.pdf' },
    // Every character a pattern treats as special, as a link can carry them.
    { name: 'a link with a long query full of punctuation', path: '/f/paper-50.pdf?q=a+b(c)[d]{2}|e$f^g.*h%20i&x=1;y=2' },
  ];
  for (const address of ADDRESSES) {
    test(`on ${address.name}: Chrome's own viewer shows it and stays`, async ({ context, server }, testInfo) => {
      const page = await context.newPage();

      await escapeFromOurViewer(page, server.url(address.path), testInfo);
    });
  }

  test("on a PDF that was embedded in a page: the PDF itself opens in Chrome's own viewer, full tab", async ({ context, server }, testInfo) => {
    const pdf = server.url('/h/plain.pdf');
    const pageUrl = server.url('/h/iframe-page');
    const page = await context.newPage();
    await visit(page, pageUrl);
    await expectOurViewer(page, pdf, { back: pageUrl });

    await openInChromesViewer(page, pdf, testInfo);

    await expectChromesOwnViewer(page, pdf);
    await shot(page, testInfo, 'embedded-pdf-in-chromes-own-viewer');
  });

  test('is for that tab only: the same link in another tab still opens our viewer', async ({ context, server }, testInfo) => {
    const url = server.url('/f/paper-50.pdf');
    const first = await context.newPage();
    await escapeFromOurViewer(first, url, testInfo);

    const second = await context.newPage();
    await visit(second, url);

    await expectOurViewer(second, url);
    await expectChromesOwnViewer(first, url);
    await shot(second, testInfo, 'other-tab-opens-our-viewer');
  });
});

siteTest.describe('You use "Open in Chrome\'s viewer" on a course page link', () => {
  siteTest('then follow the same link from the course page again: our viewer opens, as the hatch was for one visit', async ({ context, server, site }, testInfo) => {
    const paper = server.url('/f/paper-50.pdf');
    site.html('/course', `<a href="${paper}">Week 3 reading (PDF)</a>`);
    const page = await context.newPage();
    await visit(page, site.url('/course'));
    await clickLink(page.getByRole('link', { name: /Week 3 reading/ }));
    await expectOurViewer(page, paper);
    await openInChromesViewer(page, paper, testInfo);
    await expectChromesOwnViewer(page, paper);

    await visit(page, site.url('/course'));
    await clickLink(page.getByRole('link', { name: /Week 3 reading/ }));

    await expectOurViewer(page, paper);
    await shot(page, testInfo, 'our-viewer-on-the-second-visit');
    expect(normalize(viewerParams(page).source)).toBe(normalize(paper));
  });
});

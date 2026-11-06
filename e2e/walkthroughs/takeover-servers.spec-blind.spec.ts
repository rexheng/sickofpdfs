import { HEADER_CASES } from '../support/header-cases';
import { expect, test } from '../support/test';
import { expectOurViewer, isOurViewer, quietFor, shot, trackNavigations, visit } from './support/takeover';

// Walkthrough 1 again, for the way servers answer. Chrome decides what a PDF is from the response headers, and so do
// we (the takeover rules). Each row of the harness's HEADER_CASES says what a person should see: the PDF in our
// viewer, or the plain download Chrome gives for a file the server marks as one.

/** What the server sends, in words, for the test's name. */
const describeCase = (c: (typeof HEADER_CASES)[number]): string =>
  [c.ct === null ? 'no Content-Type' : `Content-Type ${c.ct}`, 'cd' in c ? `Content-Disposition ${c.cd}` : null].filter(Boolean).join(', ');

test.describe('A PDF address where the server answers with', () => {

  test('Every way a server answers decides between our viewer and a plain download, as Chrome does', async ({ step }, testInfo) => {
    test.setTimeout(480_000);
    for (const c of HEADER_CASES) {
      await step(`${describeCase(c)} (${c.path}) -> ${c.expect}`, async ({ context, server }) => {
        const url = server.url(c.path);
        const page = await context.newPage();
        const nav = trackNavigations(page);

        if (c.expect === 'viewer') {
          await visit(page, url);
          await expectOurViewer(page, url);
          await shot(page, testInfo, 'our-viewer');
          return;
        }

        expect(c.expect, 'the harness lists only "viewer" and "download"').toBe('download');
        const [download] = await Promise.all([page.waitForEvent('download', { timeout: 10_000 }), visit(page, url)]);
        expect(download.suggestedFilename(), 'the file the server named').toBe('a.pdf');
        await quietFor(page, 1000);
        expect(isOurViewer(page.url()) || nav.ourViewerVisits() > 0, 'our viewer must not open for a download').toBe(false);
        await shot(page, testInfo, 'a-plain-download-the-tab-stays-as-it-was');
      }, 60_000);
    }
  });
});

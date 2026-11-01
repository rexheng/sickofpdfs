import { expect } from '../support/test';
import { tinyPdf } from './support/site';
import { OUR_VIEWER, clickLink, expectOurViewer, shot, siteTest as test, visit } from './support/takeover';

// Regression test from a bug report (the independent security read of the takeover fixes, finding 1): after the owner
// opened a signed-in PDF in a tab, a web page visited later in the SAME tab could send the tab to
// viewer.html?file=<that PDF>, and the tab's old record let the viewer fetch it again with the owner's cookie and the
// original Referer. A web page's opening of a viewer address must be refused (ruling R63), whatever the tab opened
// before. The owner's own Back to that viewer entry must still work.

test('a page visited later in the same tab cannot re-open a PDF the owner opened there, with the sign-in', async ({ context, site, files }, testInfo) => {
  const bytes = await tinyPdf();
  files.route('/login', (_req, res) => {
    res.writeHead(200, { 'set-cookie': 'files_sid=s3cret; Path=/; SameSite=Strict', 'content-type': 'text/plain' }).end('signed in');
  });
  files.route('/files/private.pdf', (_req, res, request) => {
    if (!/(?:^|;\s*)files_sid=s3cret(?:;|$)/.test(request.headers.cookie ?? '')) return void res.writeHead(403, { 'content-type': 'text/plain' }).end('not for you');
    res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': bytes.byteLength, 'cache-control': 'no-store' }).end(bytes);
  });
  const pdf = files.url('/files/private.pdf');
  files.html('/reading', `<h1>Reading list</h1><a href="${pdf}">Reading 1 (PDF)</a>`);
  // Another site: once, with no click, it sends the tab to our viewer naming that PDF.
  site.html(
    '/elsewhere',
    `<h1>Another site</h1><script>
       if (!sessionStorage.getItem('sent')) {
         sessionStorage.setItem('sent', '1');
         setTimeout(() => { location.href = ${JSON.stringify(`${OUR_VIEWER}?file=`)} + encodeURIComponent(${JSON.stringify(pdf)}); }, 300);
       }
     </script>`,
  );

  const page = await context.newPage();
  await visit(page, files.url('/login'));
  await visit(page, files.url('/reading'));
  await clickLink(page.getByRole('link', { name: /Reading 1/ }));
  await expectOurViewer(page, pdf);
  await expect(page.locator('[role="document"]'), "the owner's own opening shows the PDF").toBeVisible({ timeout: 15_000 });
  const before = files.requestsTo('/files/private.pdf').length;

  // The owner goes on to another site in the same tab, and that site sends the tab to the viewer.
  await visit(page, site.url('/elsewhere'));
  await expect.poll(() => page.url(), { message: 'the other site sent the tab to our viewer', timeout: 10_000 }).toMatch(/^chrome-extension:\/\//);
  // TB1 wording ruling (chrome polish): the error card writes ’.
  await expect(page.getByText(/Couldn[’']t load this PDF/), 'the viewer refuses it: the file host says no without the sign-in').toBeVisible({ timeout: 15_000 });
  const replays = files.requestsTo('/files/private.pdf').slice(before);
  expect(replays.length, 'the viewer asked for the PDF (without the sign-in)').toBeGreaterThan(0);
  for (const request of replays) {
    expect(request.headers.cookie ?? '', 'no sign-in cookie on a fetch a web page started').not.toContain('files_sid');
    expect(request.headers.referer, 'no Referer on it either').toBeUndefined();
  }
  await shot(page, testInfo, 'opening-by-another-site-refused');

  // Back twice, past the other site, to the owner's own viewer entry: it still shows the PDF.
  await page.goBack();
  await page.goBack();
  await expectOurViewer(page, pdf);
  await expect(page.locator('[role="document"]'), "Back to the owner's own viewer shows the PDF again").toBeVisible({ timeout: 15_000 });
  await shot(page, testInfo, 'back-to-the-owners-viewer');
});

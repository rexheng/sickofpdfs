import { expect } from '../support/test';
import { clickLink, expectOurViewer, normalize, shot, siteTest as test, viewerParams, visit } from './support/takeover';

// Walkthrough 1 ("You click any PDF link"), release 1 criterion 1: a PDF link opens in our viewer, in the same tab.
// The viewer is still a stub, so these look at the tab's address (the original link is in it) and the page root.

test.describe('You click a PDF link', () => {

  test('Clicking a PDF link opens our viewer: in the same tab with reload and Back, in a new tab, at #page=7, and from inside a PDF', async ({ step, site }, testInfo) => {
    test.setTimeout(240_000);
    await step('on a course page: our viewer opens in the same tab, with the original link; reload keeps it; Back returns to the page', async ({ context, server }) => {
      const paper = server.url('/f/paper-50.pdf');
      site.html(
        '/course',
        `<h1>Econometrics: reading list</h1>
       <ul>
         <li><a href="${paper}">Week 3 reading: difference-in-differences (PDF)</a></li>
       </ul>`,
      );
      const page = await context.newPage();
      await visit(page, site.url('/course'));
      await shot(page, testInfo, 'course-page-with-a-pdf-link');
      const tabs = context.pages().length;

      await clickLink(page.getByRole('link', { name: /Week 3 reading/ }));

      await expectOurViewer(page, paper);
      expect(context.pages().length, 'the link opened no extra tab').toBe(tabs);
      await shot(page, testInfo, 'our-viewer-after-the-click');

      const viewerAddress = page.url();
      await page.reload();
      await expectOurViewer(page, paper);
      expect(page.url(), 'reload keeps the same viewer address').toBe(viewerAddress);
      await shot(page, testInfo, 'our-viewer-after-reload');

      await page.goBack();
      await expect.poll(() => page.url(), { message: 'Back returns to the course page' }).toBe(normalize(site.url('/course')));
    }, 60_000);
    await step('that opens in a new tab: the new tab shows our viewer and the course page stays where it was', async ({ context, server }) => {
      const paper = server.url('/f/paper-50.pdf');
      site.html('/course', `<a href="${paper}" target="_blank">Week 3 reading (opens in a new tab)</a>`);
      const page = await context.newPage();
      await visit(page, site.url('/course'));

      const [tab] = await Promise.all([context.waitForEvent('page'), clickLink(page.getByRole('link', { name: /opens in a new tab/ }))]);

      await expectOurViewer(tab, paper);
      await shot(tab, testInfo, 'new-tab-shows-our-viewer');
      expect(page.url(), 'the course page is untouched').toBe(normalize(site.url('/course')));
    }, 60_000);
    await step('with #page=7 in it: our viewer opens at that page', async ({ context, server }) => {
      const page = await context.newPage();
      await visit(page, server.url('/f/paper-50.pdf#page=7'));

      await expectOurViewer(page, server.url('/f/paper-50.pdf'), { page: 7 });
      await shot(page, testInfo, 'opened-at-page-7');
    }, 60_000);
    await step('inside our viewer (a link in a PDF to another PDF): it opens in the same tab, and Back returns to the first', async ({ context, server, openViewer }) => {
      const first = server.url('/f/paper-50.pdf');
      const cited = server.url('/h/plain.pdf');
      const viewer = await openViewer(first);
      const tabs = context.pages().length;
      // A stand-in for a link in the PDF's page. The viewer root is fixed over the whole window, so the link is fixed
      // above it. When the PDF link layer exists, this should click a real link instead.
      await viewer.evaluate((href) => {
        const link = document.createElement('a');
        link.href = href;
        link.textContent = 'Cited paper (PDF)';
        link.style.cssText = 'position: fixed; left: 8px; bottom: 8px; z-index: 10';
        document.body.append(link);
      }, cited);

      await clickLink(viewer.getByRole('link', { name: 'Cited paper (PDF)' }));

      await expectOurViewer(viewer, cited);
      expect(context.pages().length, 'the link opened no extra tab').toBe(tabs);
      await shot(viewer, testInfo, 'cited-paper-in-the-same-tab');

      await viewer.goBack();
      await expectOurViewer(viewer, first);
      expect(viewerParams(viewer).source, 'Back shows the first PDF again').toBe(first);
    }, 60_000);
  });
});

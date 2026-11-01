import { closeSync, ftruncateSync, openSync, writeSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO_ROOT } from '../support/launch';
import { expect, test } from '../support/test';
import { expectChromesOwnViewer, isOurViewer, quietFor, shot, trackNavigations, visit } from './support/takeover';

// PDFs we do not take over: "PDFs loaded by a form post ... open in Chrome's own viewer" (decisions table, release 1
// criterion 1) and "Files over 1 GiB open in Chrome's own viewer" (the large-files row and the standing constraints).

test.describe('A PDF that is left to Chrome\'s own viewer', () => {
  test('because a form posted to get it: the owner submits the form and Chrome shows the PDF, ours never opens', async ({ context, server }, testInfo) => {
    const page = await context.newPage();
    const nav = trackNavigations(page);
    await visit(page, server.url('/h/post-form'));
    await shot(page, testInfo, 'the-form');

    // The form either waits for a click or sends itself; the owner's step is the same.
    const submit = page.locator('form').first().locator('button, input[type=submit]').first();
    if (await submit.isVisible().catch(() => false)) await submit.click().catch(() => {});

    await expect.poll(() => new URL(page.url()).pathname, { message: 'the form posted to /h/post', timeout: 10_000 }).toBe('/h/post');
    await expectChromesOwnViewer(page, server.url('/h/post'));
    await quietFor(page, 2000);
    expect(isOurViewer(page.url()), 'the tab is not in our viewer').toBe(false);
    expect(nav.ourViewerVisits(), 'our viewer never opened for the posted PDF').toBe(0);
    await shot(page, testInfo, 'posted-pdf-in-chromes-own-viewer');
  });

  test.describe('because it is over 1 GiB', () => {
    const HUGE = 'huge-1p5-gib.pdf';
    const hugePath = join(REPO_ROOT, 'test-assets', HUGE);

    test.beforeAll(() => {
      // A sparse file: it says it is 1.5 GiB (the size the server sends as Content-Length) but takes no disk.
      const fd = openSync(hugePath, 'w');
      writeSync(fd, '%PDF-1.4\n');
      ftruncateSync(fd, 1.5 * 1024 ** 3);
      closeSync(fd);
    });
    test.afterAll(async () => {
      await rm(hugePath, { force: true });
    });

    test('the owner clicks it and Chrome\'s own viewer shows it, at its own address', async ({ context, server }, testInfo) => {
      const url = server.url(`/f/${HUGE}`);
      const page = await context.newPage();

      await visit(page, url);

      await expectChromesOwnViewer(page, url);
      await quietFor(page, 2000);
      await expectChromesOwnViewer(page, url); // it stays: nothing takes the tab over later
      await shot(page, testInfo, 'huge-pdf-in-chromes-own-viewer');
    });
  });
});

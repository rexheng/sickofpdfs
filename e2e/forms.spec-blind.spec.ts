// Gate 1, the form bounce (Task 31), as the owner meets it. Written from the spec and the interface file only.
//
//   spec, Release 1 criterion 1: "PDFs loaded by a form post, and PDFs with fillable forms, stay in Chrome's viewer."
//   spec, Reading basics, "Forms": "PDFs with real fillable fields (text boxes, choices or checkboxes listed as form fields, or XFA) are
//     classified first and saved if they are learning PDFs, then reopen in Chrome's own viewer to be filled, through a one-time allow rule
//     for that link and tab. Link boxes that LaTeX adds to papers do not count. If the link can't be fetched again, our view stays, with a
//     banner."
//   spec, walkthrough 10 / Local traces: a tax form is not a learning PDF, so it is never stored.
//   Phase 0 report P0-7 (a result, not code): HMRC SA100 has 4 text fields (fillable), IRS W-9 is XFA (fillable), NBER w29000 has 1,026 link
//     annotations and no widget (not a form).
//   interface file (Tasks 30+31): "the notice shows for 1500 ms, then takeover:open-in-chrome"; on stay-with-banner "show FormBanner
//     (Banner with dismiss)"; fixture routes: `/h/form.pdf` = HMRC SA100, `/h/form-once.pdf` (a link that works once), `/h/hyperref.pdf` = NBER.
//
// The real files are served from `/f/classifier/...` (the fixture server already does that), so these tests need none of the new routes;
// the "link that works once" is mounted here with the same behaviour as the interface file describes for `/h/form-once.pdf`.
//
// GUESSES (the spec names no markup; written down in task-30-tests-report.md): the banner is the shared Banner (role "status", with a
// "Dismiss" button) and its words mention the form; with the stand-in filter a tax form is "not sure" and is therefore not saved; the
// viewer needs one GET for a PDF opened by its viewer address, so a PDF that is not a form costs its server exactly that one request.
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { CHIP, headerButton, listOpfs, waitDecided } from './support/save-probe.spec-blind';
import { TEST_ASSETS } from './support/server';
import { store, waitForStore, ZERO_STATS } from './support/store-probe.spec-blind';
import { expect, test } from './support/test';
import { expectChromesOwnViewer, expectOurViewer, isOurViewer, quietFor, shot, visit } from './walkthroughs/support/takeover';
import { snap, waitReady } from './walkthroughs/support/viewer.spec-blind';

const SA100 = '/f/classifier/not-learning/tax-form-hmrc-sa100-2026.pdf';
const W9 = '/f/classifier/not-learning/tax-form-irs-w9.pdf';
const NBER = '/f/classifier/learning/nber-w29000.pdf';

// Triage (t30-triage T5): the plan's wording is "This PDF has fillable fields. …", which says "fillable", not "form".
const bannerOf = (page: import('@playwright/test').Page) => page.getByRole('status').filter({ hasText: /form|fillable/i });

test('a real fillable form (text fields, or XFA) opens in our viewer for a moment and then reopens in Chrome\'s own viewer, and it is not kept in the library', async ({ context, openViewer, server }, testInfo) => {
  test.setTimeout(120_000);
  for (const [name, path] of [
    ['the HMRC SA100 (text fields)', SA100],
    ['the IRS W-9 (XFA)', W9],
  ] as const) {
    await test.step(name, async () => {
      const url = server.url(path);
      const page = await context.newPage();
      await visit(page, url); // a click on the link: the takeover sends it to our viewer first
      await expectOurViewer(page, url);
      await shot(page, testInfo, `${path.split('/').pop()}-in-our-viewer`);

      await expectChromesOwnViewer(page, url); // then the form is handed back
      await shot(page, testInfo, `${path.split('/').pop()}-in-chromes-viewer`);
      await quietFor(page, 2500);
      await expectChromesOwnViewer(page, url); // and it stays there: our viewer does not take it back
    });
  }

  await test.step('nothing about the forms was stored', async () => {
    const other = await openViewer(server.url('/h/plain.pdf'));
    await waitForStore(other);
    expect(await store(other).stats(), 'a tax form is never saved').toEqual(ZERO_STATS);
    expect(await listOpfs(other, 'pdf')).toEqual([]);
  });
});

test('a LaTeX paper whose only widgets are link boxes (NBER w29000) stays in our viewer, with no banner and no extra request', async ({ openViewer, server }, testInfo) => {
  const page = await openViewer(server.url(NBER));
  await waitReady(page);
  await waitForStore(page);
  await waitDecided(page);

  await quietFor(page, 4000); // longer than the notice, the probe and the bounce together
  await snap(page, testInfo, 'paper-stays');

  expect(isOurViewer(page.url()), 'still our viewer').toBe(true);
  await expect(bannerOf(page), 'it is not a form, so no banner about one').toHaveCount(0);
  await expect(headerButton(page, CHIP.unsure), 'the library chip is untouched').toBeVisible();
  expect(server.requests(NBER), 'the paper was fetched once; a probe for a PDF that is not a form would be a second request').toBeLessThanOrEqual(1);
});

test('a form whose link cannot be fetched again stays in our viewer with a banner, which can be dismissed', async ({ openViewer, server }, testInfo) => {
  test.setTimeout(90_000);
  const bytes = await readFile(join(TEST_ASSETS, 'classifier/not-learning/tax-form-hmrc-sa100-2026.pdf'));
  let gets = 0;
  const handler = (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const origin = req.headers.origin;
    if (origin !== undefined) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('access-control-allow-credentials', 'true');
      res.setHeader('access-control-expose-headers', 'accept-ranges, content-range, content-length, content-disposition');
      res.setHeader('vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-headers': 'range', 'access-control-allow-methods': 'GET, HEAD' }).end();
    } else if (req.method === 'HEAD') {
      res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': bytes.byteLength }).end();
    } else if (++gets > 1) {
      res.writeHead(403, { 'content-type': 'text/html' }).end('<p>This link has expired.</p>'); // the link works once
    } else {
      res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': bytes.byteLength, 'cache-control': 'no-store' }).end(bytes);
    }
    return Promise.resolve();
  };
  server.mount('/spec-blind/form-once.pdf', handler);
  const url = server.url('/spec-blind/form-once.pdf');

  const page = await openViewer(url);
  await waitReady(page); // the form itself opened: the one good fetch went to our viewer
  await waitForStore(page);
  await waitDecided(page);

  const banner = bannerOf(page);
  await expect(banner, 'the viewer says why the form stays here').toBeVisible({ timeout: 15_000 });
  await snap(page, testInfo, 'form-banner');
  await quietFor(page, 3000);
  expect(isOurViewer(page.url()), 'our viewer stays; the tab is not sent to a link that no longer works').toBe(true);
  await expect(banner).toBeVisible();
  expect(gets, 'the probe found the link dead').toBeGreaterThanOrEqual(2);

  await banner.getByRole('button', { name: 'Dismiss' }).click();
  await expect(banner).toHaveCount(0);
  await expect(page.locator('[role="document"]'), 'the form is still on screen').toBeVisible();
  expect(isOurViewer(page.url())).toBe(true);
});

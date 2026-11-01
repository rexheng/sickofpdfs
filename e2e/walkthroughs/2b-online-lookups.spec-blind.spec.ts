// Gate 1, Phase 3 plan, item 12: "Lookups."
//   "With the setting off, no request leaves. With it on, only the id goes to arXiv or Crossref, and only for a saved PDF."
// Spec, "What leaves your computer, and when": "A DOI or arXiv id | arXiv or Crossref | Only for saved PDFs, and only the id"; "Anything else |
// Nobody | No code, fonts or models are downloaded; a build test fails on any other request." "Optional lookups (arXiv, Crossref) run only for
// saved PDFs and send only the id." Contracts section 5 ("Synced settings keys"): `lookups.online` (default `false`). Mission: "no network
// traffic except what the owner turns on."
//
// WHAT IS READ. The browser's own net log (Chromium's --log-net-log), after the browser has closed. It records every request the extension
// started, whether or not the sandbox could reach the host, so the test sees what was SENT. Nothing is mocked.
//
// Part 1 (no guard, runs today): the setting is off by default. A saved arXiv paper and a saved DOI paper are read, and an invoice that quotes
// a DOI is opened. No request may leave (the harness's own network gate fails the test on any request beyond the fixture server).
// Part 2 (runtime guard: Settings has an "online lookups" switch): the switch is turned on. The arXiv paper gets one request to arXiv that
// carries its id, the DOI paper one to Crossref that carries its DOI, and the unsaved invoice's DOI goes nowhere. No request carries
// anything but an id: not the title, the file name, the text, or the address the PDF came from.
//
// GUESSES: the switch is an ARIA switch (or checkbox) whose name contains "lookup"; the hosts are arxiv.org (export.arxiv.org) and
// crossref.org (api.crossref.org); a lookup begins within about 30 seconds of the PDF being saved.
import { expect, test } from '../support/test';
import { ATTENTION as ATTENTION_FX, PLOS as PLOS_FX, openPaper, saveFirst } from './support/marks.spec-blind';
import { ensureP3Fixtures, P3_FILES, p3Url, PRIVATE_DOI } from './support/p3-fixtures.spec-blind';
import { ATTENTION_ARXIV, PLOS_DOI, note, openSettings, pageNotBuilt, shotOf, sleep, waitForStore, waitViewerReady } from './support/library-p3.spec-blind';

test.beforeAll(async () => {
  await ensureP3Fixtures();
});

test.describe('the setting is off', () => {
  test.setTimeout(240_000);

  test('nothing leaves: saved papers with an arXiv id and a DOI are read, and a PDF that is not saved quotes a DOI', async ({ context, openViewer, server }, testInfo) => {
    const settings = await openSettings(context);
    if (!(await pageNotBuilt(settings))) {
      const sw = settings.getByRole('switch', { name: /lookup/i }).or(settings.getByRole('checkbox', { name: /lookup/i })).first();
      if (await sw.isVisible()) {
        await expect(sw, 'online lookups start switched off').not.toBeChecked();
        await shotOf(settings, testInfo, '01-lookups-off');
      }
    }
    for (const fx of [ATTENTION_FX, PLOS_FX]) {
      const page = await openPaper(openViewer, server, fx);
      await waitForStore(page);
      await saveFirst(page);
      await page.waitForTimeout(1500);
    }
    const invoice = await openViewer(server.url(p3Url(P3_FILES.privateDoi)));
    await waitViewerReady(invoice);
    await sleep(8000); // time enough for a lookup to be sent if one were going to be
    // the harness's gate fails this test if anything but the fixture server was requested
  });
});

test.describe('the setting is on', () => {
  test.use({ networkGate: 'observe' });
  test.setTimeout(300_000);

  test.afterEach(async ({ netgate }) => {
    await netgate.report(); // the harness wants the net log read before a test ends, even one that was skipped or failed early
  });

  test('only an id goes to arXiv or Crossref, and only for a saved PDF', async ({ context, openViewer, server, netgate }, testInfo) => {
    const settings = await openSettings(context);
    if (await pageNotBuilt(settings)) test.skip(true, 'the Settings page is not built yet (slice S14)');
    const toggle = settings.getByRole('switch', { name: /lookup/i }).or(settings.getByRole('checkbox', { name: /lookup/i })).first();
    if (!(await toggle.isVisible())) test.skip(true, 'Settings has no "online lookups" switch yet (slices S12/S14)');
    await toggle.click();
    await expect(toggle, 'the switch is on').toBeChecked();
    await shotOf(settings, testInfo, '02-lookups-on');

    for (const fx of [ATTENTION_FX, PLOS_FX]) {
      const page = await openPaper(openViewer, server, fx);
      await waitForStore(page);
      await saveFirst(page);
    }
    const invoice = await openViewer(server.url(p3Url(P3_FILES.privateDoi)));
    await waitViewerReady(invoice);
    await sleep(30_000); // arXiv is asked at most once in 3 seconds; give the queue time

    const report = await netgate.report();
    note(testInfo, 'requests that left the fixture server', report.external.join('\n') || '(none)');
    const urls = report.external.map((u) => ({ raw: u, url: new URL(u), text: decodeURIComponent(u) }));

    for (const u of urls) {
      expect(u.url.hostname, `only arXiv and Crossref may be asked (saw ${u.raw})`).toMatch(/(^|\.)(arxiv\.org|crossref\.org)$/);
    }
    expect(urls.some((u) => /arxiv\.org$/.test(u.url.hostname) && u.text.includes(ATTENTION_ARXIV)), 'arXiv was asked for the saved paper, by its id').toBe(true);
    expect(urls.some((u) => /crossref\.org$/.test(u.url.hostname) && u.text.includes(PLOS_DOI)), 'Crossref was asked for the saved paper, by its DOI').toBe(true);

    // nothing but the id
    const secrets = [PRIVATE_DOI, 'private.invoice', 'Attention Is All', 'attention.pdf', 'arxiv-1706', 'dominant sequence', server.origin, '127.0.0.1', 'invoice'];
    for (const u of urls) {
      for (const s of secrets) expect(u.text.toLowerCase(), `a lookup carries only an id, not "${s}" (${u.raw})`).not.toContain(s.toLowerCase());
    }
    // the unsaved invoice's DOI was never sent
    expect(urls.some((u) => u.text.includes('10.5555')), "the unsaved invoice's DOI was not looked up").toBe(false);
  });
});

// User tests, seeded profile. The owner installs the extension and opens a PDF link: our viewer comes up under the
// extension's fixed id, with the address of the PDF (and the page it came from) in its own address.
// Spec: "Clicking a PDF link ... opens it in our viewer in the same tab"; "a fixed extension key ... so the extension's
// identity and data survive updates"; "Embedded PDFs ... 'Back to page'"; test hooks only through hooks(page).
/* eslint-disable @typescript-eslint/unbound-method -- the fixtures are plain functions; the interface declares them with method syntax */
import { expect } from '@playwright/test';
import { EXTENSION_ID } from '../apps/extension/scripts/extension-id.mjs';
import { VIEWER_PATH, parseViewerUrl } from '../apps/extension/src/shared/viewer-url';
import { ensureSamplePdf } from './support/sample-pdf.spec-blind';
import { hooks, test } from './support/test';

test.use({ profile: 'seeded' });

const SAMPLE = 't12-sample.pdf';
const MOODLE = 'https://moodle.example.ac.uk/course/view.php?id=42&section=3#module-77';

type ChromeInWorker = { chrome: { runtime: { id: string } } };

test.beforeAll(async () => {
  await ensureSamplePdf(SAMPLE);
});

test('the built extension starts under its fixed id', async ({ sw }) => {
  const url = new URL(sw.url());
  expect(url.protocol).toBe('chrome-extension:');
  expect(url.host).toBe(EXTENSION_ID);
  // The extension itself only ever asks Chrome for its id (chrome.runtime.id), so that must agree too.
  expect(await sw.evaluate(() => (globalThis as unknown as ChromeInWorker).chrome.runtime.id)).toBe(EXTENSION_ID);
});

test('a PDF link opens in our viewer, which shows something on screen', async ({ openViewer, server }, testInfo) => {
  const pdfUrl = server.url(`/f/${SAMPLE}`);
  const page = await openViewer(pdfUrl);
  const url = new URL(page.url());
  expect(url.protocol).toBe('chrome-extension:');
  expect(url.host).toBe(EXTENSION_ID);
  expect(url.pathname).toBe(`/${VIEWER_PATH}`);
  expect(parseViewerUrl(page.url())).toEqual({ source: pdfUrl, back: null, page: null });
  await page.screenshot({ path: testInfo.outputPath('t12-viewer-open.png') });
});

test('the address keeps the page the PDF came from and the page to open', async ({ openViewer, server }, testInfo) => {
  const pdfUrl = server.url(`/f/${SAMPLE}`);
  const page = await openViewer(pdfUrl, { back: MOODLE, page: 3 });
  expect(parseViewerUrl(page.url())).toEqual({ source: pdfUrl, back: MOODLE, page: 3 });
  await page.screenshot({ path: testInfo.outputPath('t12-viewer-back-and-page.png') });
});

test('an awkward PDF address (query, ampersands, accents, spaces, a fragment) comes back exactly', async ({ openViewer, server }) => {
  const awkward = `${server.url(`/f/${SAMPLE}`)}?token=a%26b%3Dc&name=déjà vu (1)&n=1+1#section=2`;
  const back = 'https://example.org/reading list?week=3&topic=a/b#row-9';
  const page = await openViewer(awkward, { back, page: 2 });
  expect(parseViewerUrl(page.url())).toEqual({ source: awkward, back, page: 2 });
});

test('the redirect form chrome-extension://<id>/viewer.html?DNR:<url> opens the same viewer', async ({ context, openViewer, server }, testInfo) => {
  const pdfUrl = server.url(`/f/${SAMPLE}?token=1&back=x`);
  const reference = await openViewer(pdfUrl);

  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`chrome-extension://${EXTENSION_ID}/${VIEWER_PATH}?DNR:${pdfUrl}#page=2`);
  await page.waitForFunction(() => document.body.querySelector(':scope > :not(script):not(style)') !== null);
  // Everything after ?DNR: is the source, including the & and the word back=; the #page= belongs to the viewer.
  expect(parseViewerUrl(page.url())).toEqual({ source: pdfUrl, back: null, page: 2 });
  expect(errors).toEqual([]);
  expect(await page.title()).toBe(await reference.title());
  await page.screenshot({ path: testInfo.outputPath('t12-viewer-dnr-form.png') });
});

test('opening a PDF asks its server for the PDF at most once and for nothing else', async ({ openViewer, server }) => {
  const path = `/f/${SAMPLE}`;
  const page = await openViewer(server.url(path));
  await page.waitForTimeout(2000); // time for anything the viewer or the extension would send on its own
  expect(server.requests(path)).toBeLessThanOrEqual(1);
  for (const other of ['/', '/favicon.ico', '/f/', '/h/']) expect(server.requests(other), other).toBe(0);
});

test('test hooks reach the viewer: values go in, results (also async ones) come out, errors come back', async ({ openViewer, server }) => {
  const page = await openViewer(server.url(`/f/${SAMPLE}`));
  expect(await hooks(page).eval((h) => typeof h)).toBe('object');
  expect(
    await hooks(page).eval((h, n) => {
      if (h === undefined) throw new Error('the hooks object is missing');
      return n * 2;
    }, 21),
  ).toBe(42);
  expect(
    await hooks(page).eval(async (_h, text) => {
      await new Promise((r) => setTimeout(r, 50));
      return text.toUpperCase();
    }, 'done'),
  ).toBe('DONE');
  await expect(
    hooks(page).eval(() => {
      throw new Error('hook failure on purpose');
    }),
  ).rejects.toThrow(/hook failure on purpose/);
});

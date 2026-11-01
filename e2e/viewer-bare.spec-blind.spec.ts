// User tests, bare profile (a brand-new Chrome profile: nothing set up). The extension must start under the same
// fixed id and open a PDF the same way as in the seeded profile.
/* eslint-disable @typescript-eslint/unbound-method -- the fixtures are plain functions; the interface declares them with method syntax */
import { expect } from '@playwright/test';
import { EXTENSION_ID } from '../apps/extension/scripts/extension-id.mjs';
import { VIEWER_PATH, parseViewerUrl } from '../apps/extension/src/shared/viewer-url';
import { ensureSamplePdf } from './support/sample-pdf.spec-blind';
import { test } from './support/test';

test.use({ profile: 'bare' });

const SAMPLE = 't12-sample.pdf';

test.beforeAll(async () => {
  await ensureSamplePdf(SAMPLE);
});

test('on a brand-new profile the extension starts under its fixed id', ({ sw }) => {
  expect(new URL(sw.url()).host).toBe(EXTENSION_ID);
});

test('on a brand-new profile a PDF link opens in our viewer', async ({ openViewer, server }, testInfo) => {
  const pdfUrl = server.url(`/f/${SAMPLE}`);
  const page = await openViewer(pdfUrl);
  expect(new URL(page.url()).pathname).toBe(`/${VIEWER_PATH}`);
  expect(parseViewerUrl(page.url()).source).toBe(pdfUrl);
  await page.screenshot({ path: testInfo.outputPath('t12-viewer-bare-profile.png') });
});

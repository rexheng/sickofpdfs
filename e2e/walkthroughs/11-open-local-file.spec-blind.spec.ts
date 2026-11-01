// Walkthrough 2 (the part a browser test can reach): a local PDF (file://) opens, and when Chrome has not been allowed to give the
// extension file access, the viewer says so plainly and offers two ways on.
// Spec: "double-clicking a local PDF opens it in our viewer in the same tab"; Requirements: "Set Chrome as the Windows .pdf app once.
// The extension then takes over local files (file://)". Interface file (copy): the dialog says "Allow access to file URLs", with the
// buttons "Open extension settings" (opens chrome://extensions/?id=<the extension's id>) and "Choose file".
//
// Opened the way Chrome opens a double-clicked file: at its own file:// address, which the takeover sends to the viewer.
// (sec1: a viewer address typed with a file:// source is no longer read, since any web page can send a tab to one;
// the takeover walkthroughs and the sec1 report cover that refusal.)
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { BrowserContext, Page } from '@playwright/test';
import { REAL } from './support/fixtures.spec-blind';
import { EXTENSION_ID, VIEWER_ROOT } from '../support/test';
import { expect, rt, snap, test, waitForFirstPage } from './support/viewer.spec-blind';

/** A new tab opened at the file's own address; returns once the takeover has it in our viewer. */
async function openLocalFile(context: BrowserContext, url: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(url).catch(() => {}); // the takeover replaces the navigation Playwright started
  // Polled, not page.waitForURL: that rejects when the navigation it follows is aborted, and the takeover aborts it.
  await expect.poll(() => page.url(), { message: 'the tab should be showing our viewer', timeout: 15_000 }).toMatch(/^chrome-extension:\/\//);
  await page.waitForSelector(VIEWER_ROOT, { state: 'attached' });
  return page;
}

test.describe('file access allowed', () => {
  test.use({ profile: 'seeded' });

  test('a file:// PDF opens and is the right file', async ({ context }, testInfo) => {
    const url = pathToFileURL(REAL.paper50.file).href;
    const page = await openLocalFile(context, url);
    await waitForFirstPage(page);
    const doc = await rt(page).doc();
    const bytes = await readFile(REAL.paper50.file);
    expect(doc!.sourceUrl).toBe(url);
    expect(doc!.size).toBe(bytes.length);
    expect(doc!.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(doc!.displayName).toMatch(/paper-50/);
    await snap(page, testInfo, '11-local-file-opened');
  });
});

test.describe('file access not allowed (a fresh Chrome profile)', () => {
  test.use({ profile: 'bare' });

  test('the viewer explains it, and "Choose file" opens the PDF anyway', async ({ context }, testInfo) => {
    const page = await openLocalFile(context, pathToFileURL(REAL.paper50.file).href);
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await expect(dialog.getByRole('heading', { name: 'Allow access to file URLs' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Open extension settings' })).toBeVisible();
    await snap(page, testInfo, '11-file-access-dialog');

    const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 10_000 }), dialog.getByRole('button', { name: 'Choose file' }).click()]);
    await chooser.setFiles(REAL.paper50.file);
    await waitForFirstPage(page);
    await expect(page.getByRole('dialog')).toBeHidden();
    const doc = await rt(page).doc();
    expect(doc!.sourceUrl, 'a chosen file has no address').toBeNull();
    expect(doc!.pageCount).toBe(REAL.paper50.pages);
    await snap(page, testInfo, '11-chosen-file-opened');
  });

  test('"Open extension settings" opens this extension\'s page in chrome://extensions', async ({ context }) => {
    const page = await openLocalFile(context, pathToFileURL(REAL.paper50.file).href);
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    const opened = context.waitForEvent('page', { timeout: 10_000 });
    await dialog.getByRole('button', { name: 'Open extension settings' }).click();
    const settings = await opened;
    await expect.poll(() => settings.url(), { timeout: 10_000 }).toContain(`chrome://extensions/?id=${EXTENSION_ID}`);
  });
});

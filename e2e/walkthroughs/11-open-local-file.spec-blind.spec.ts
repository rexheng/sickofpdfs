// Walkthrough 2 (the part a browser test can reach): a local PDF (file://) opens, and when Chrome has not been allowed to give the
// extension file access, the viewer says so plainly and offers two ways on.
// Spec: "double-clicking a local PDF opens it in our viewer in the same tab"; Requirements: "Set Chrome as the Windows .pdf app once.
// The extension then takes over local files (file://)". Interface file (copy): the dialog says "Allow access to file URLs", with the
// buttons "Open extension settings" (opens chrome://extensions/?id=<the extension's id>) and "Choose file".
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { REAL } from './support/fixtures.spec-blind';
import { EXTENSION_ID } from '../support/test';
import { expect, rt, snap, test, waitForFirstPage } from './support/viewer.spec-blind';

test.describe('file access allowed', () => {
  test.use({ profile: 'seeded' });

  test('a file:// PDF opens and is the right file', async ({ openViewer }, testInfo) => {
    const url = pathToFileURL(REAL.paper50.file).href;
    const page = await openViewer(url);
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

  test('the viewer explains it, and "Choose file" opens the PDF anyway', async ({ openViewer }, testInfo) => {
    const page = await openViewer(pathToFileURL(REAL.paper50.file).href);
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await expect(dialog.getByText('Allow access to file URLs')).toBeVisible();
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

  test('"Open extension settings" opens this extension\'s page in chrome://extensions', async ({ context, openViewer }) => {
    const page = await openViewer(pathToFileURL(REAL.paper50.file).href);
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    const opened = context.waitForEvent('page', { timeout: 10_000 });
    await dialog.getByRole('button', { name: 'Open extension settings' }).click();
    const settings = await opened;
    await expect.poll(() => settings.url(), { timeout: 10_000 }).toContain(`chrome://extensions/?id=${EXTENSION_ID}`);
  });
});

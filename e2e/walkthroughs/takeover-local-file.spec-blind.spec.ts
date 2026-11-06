import type { BrowserContext } from '@playwright/test';
import { EXTENSION_ID, expect, test } from '../support/test';
import { expectOurViewer, fileAccessControl, findExtensionSettingsTab, localPdf, shot, visit } from './support/takeover';

// Walkthrough 2 ("You double-click a PDF in File Explorer"): Chrome opens the file as a file:// address and the
// extension takes over. That needs "Allow access to file URLs"; with it off, the owner must see how to turn it on.

/** Whether the extension reports file access. Read through an extension page; null while the extension is reloading. */
async function fileAccess(context: BrowserContext): Promise<boolean | null> {
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${EXTENSION_ID}/viewer.html`);
    return await page.evaluate(() => chrome.extension.isAllowedFileSchemeAccess());
  } catch {
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

test.describe('You open a local PDF, with file access on', () => {
  test.use({ profile: 'seeded' });

  test('Chrome opens the file and our viewer takes it over, whatever the file is called; reload keeps it', async ({ context }, testInfo) => {
    const names = ['Lecture 3 notes.pdf', 'Économétrie – cours (Léa).pdf', 'READING LIST.PDF'];
    for (const name of names) {
      await test.step(name, async () => {
        const file = await localPdf(testInfo, name);
        const page = await context.newPage();

        await visit(page, file.url);

        await expectOurViewer(page, file.url);
        await shot(page, testInfo, `our-viewer-for-${names.indexOf(name) + 1}`);
        const address = page.url();
        await page.reload();
        await expectOurViewer(page, file.url);
        expect(page.url(), 'reload keeps the same viewer address').toBe(address);
        await page.close();
      });
    }
  });
});

test.describe('You open a local PDF, with file access off', () => {
  test.use({ profile: 'bare' });

  test('With file access off, our viewer still opens and the whole set-up to turn file access on works', async ({ step }, testInfo) => {
    test.setTimeout(120_000);
    await step('our viewer opens anyway and shows how to turn file access on, one click from the extension page', async ({ context }) => {
      expect(await fileAccess(context), 'this profile starts with file access off').toBe(false);
      const file = await localPdf(testInfo, 'Lecture 3 notes.pdf');
      const page = await context.newPage();

      await visit(page, file.url);

      await expectOurViewer(page, file.url);
      await expect(fileAccessControl(page).first(), 'a clear way to switch file access on').toBeVisible();
      await shot(page, testInfo, 'file-access-is-off');

      await fileAccessControl(page).first().click();
      const settings = await findExtensionSettingsTab(context);
      expect(settings.url()).toContain(EXTENSION_ID);
      await shot(settings, testInfo, 'extension-page-opened');
    }, 60_000);
    await step('the whole set-up: follow the prompt, switch file access on, open the file again, and it opens in our viewer', async ({ context }) => {
      const file = await localPdf(testInfo, 'Lecture 3 notes.pdf');
      const page = await context.newPage();
      await visit(page, file.url);
      await expectOurViewer(page, file.url);
      await fileAccessControl(page).first().click();
      const settings = await findExtensionSettingsTab(context);

      // The owner's step on Chrome's own page. It reloads the extension (and closes its tabs).
      await settings.locator('extensions-toggle-row', { hasText: 'Allow access to file URLs' }).locator('cr-toggle').click();
      await expect.poll(() => fileAccess(context), { message: 'file access is on after the toggle', timeout: 20_000, intervals: [500] }).toBe(true);
      await settings.close().catch(() => {});

      const again = await context.newPage();
      await visit(again, file.url);
      await expectOurViewer(again, file.url);
      await shot(again, testInfo, 'our-viewer-after-file-access-is-on');
    }, 60_000);
  });
});

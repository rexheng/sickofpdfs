// Walkthrough: a password-protected PDF. It asks for the password, a wrong password is refused in plain words, and the right
// one opens the file. Spec, Reading basics / Password PDFs: "Asks for the password"; criterion 6 "password-protected PDFs work at
// least as well as in Chrome's viewer". Interface file (copy): the dialog says "This PDF is password protected", its field is
// labelled "Password", and a wrong password gives "Incorrect password. Try again.".
// The file is the repo's AES-256 test PDF; its user password is "secret" and page 1 reads "Secret page 1" (24 pt, top-left).
import { FIXTURES, PASSWORD, ensurePassword, served } from './support/fixtures.spec-blind';
import { inkBox } from './support/pixels.spec-blind';
import { expect, note, probe, rt, shoot, snap, test, waitForFirstPage } from './support/viewer.spec-blind';

test.beforeAll(async () => {
  await ensurePassword();
});

test('a password PDF asks, refuses a wrong password plainly, and opens with the right one', async ({ openViewer, server }, testInfo) => {
  const page = await openViewer(server.url(served(FIXTURES.password)));
  const dialog = page.getByRole('dialog');
  await expect(dialog, 'a dialog asks for the password').toBeVisible({ timeout: 15_000 });
  await expect(dialog.getByText('This PDF is password protected')).toBeVisible();
  const field = dialog.getByLabel('Password');
  await expect(field, 'a field labelled "Password"').toBeVisible();
  await expect(field, 'what is typed is hidden').toHaveAttribute('type', 'password');
  await expect(page.getByText('Incorrect password. Try again.'), 'no complaint before a first try').toBeHidden();
  expect(await probe(page).inkNow(), 'nothing of the document shows before it is unlocked').toBe(false);
  await snap(page, testInfo, '06-password-asked');

  // A wrong password: plain words, the same dialog, a second try.
  await field.fill(PASSWORD.wrong);
  await field.press('Enter');
  await expect(page.getByText('Incorrect password. Try again.')).toBeVisible({ timeout: 10_000 });
  await expect(dialog, 'the dialog stays open for another try').toBeVisible();
  expect(await rt(page).state(), 'a wrong password is not a load failure').not.toBe('error');
  expect(await probe(page).inkNow(), 'still nothing of the document').toBe(false);
  await snap(page, testInfo, '06-password-wrong');
  const focused = await field.evaluate((el) => el === document.activeElement);
  note(testInfo, 'password field focused for the retry', String(focused));

  // The right one.
  await field.fill(PASSWORD.right);
  await field.press('Enter');
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await waitForFirstPage(page);
  expect(await rt(page).state()).toBe('ready');
  const doc = await rt(page).doc();
  expect(doc!.encrypted, 'the file is reported as encrypted').toBe(true);
  expect(doc!.pageCount).toBe(2);
  expect(doc!.password, 'the viewer keeps the password that worked (for the session)').toBe(PASSWORD.right);
  await page.waitForTimeout(500);
  const s = await shoot(page, testInfo.outputPath('06-password-opened.png'));
  const c = s.canvases.find((k) => k.page === 0);
  expect(c, 'page 1 is on screen').toBeDefined();
  const ink = inkBox(s.img, s.ratio, { x: c!.x, y: c!.y, width: c!.cssWidth, height: c!.cssHeight }, 128);
  expect(ink, 'page 1 shows its text ("Secret page 1")').not.toBeNull();
  // inkBox measures against the part of the page that is on screen; the question is where the text is on the whole page.
  const shownH = Math.min(c!.y + c!.cssHeight, s.scroller.y + s.scroller.height) - c!.y;
  expect((ink!.top * shownH) / c!.cssHeight, 'at the top of the page').toBeLessThan(0.2);
  expect(ink!.right, 'and in the left half').toBeLessThan(0.5);
  await expect(page.getByText('Incorrect password. Try again.'), 'the old complaint is gone').toBeHidden();
});

test('reloading a password PDF asks for the password again (nothing is remembered in the address)', async ({ openViewer, server }) => {
  const page = await openViewer(server.url(served(FIXTURES.password)));
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Password').fill(PASSWORD.right, { timeout: 15_000 });
  await dialog.getByLabel('Password').press('Enter');
  await waitForFirstPage(page);

  await page.reload();
  await expect(page.getByRole('dialog'), 'it asks again after a reload').toBeVisible({ timeout: 15_000 });
  expect(new URL(page.url()).search, 'the password is not in the address').not.toContain(PASSWORD.right);
});

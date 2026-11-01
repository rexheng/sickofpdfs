// User test for Task 22: Ctrl+A on a page selects all its text, and copying it gives exactly the engine's text for the page
// (R26), on every text-layer fixture: plain, two-column, ligatures, maths, rotated table, right-to-left, turned page, and
// the first pages of two real papers.
// Spec: "Select all on a page equals the engine's page text"; Phase 0 report: "select-all against getTextRange(0, all chars)".
import { expect, test } from '../support/test';
import { copyProblems, squash } from '../support/tl-copy.spec-blind';
import {
  centreOf,
  clearSelection,
  copySelection,
  FIXTURES,
  glyphsOf,
  isVisible,
  openClipboardReader,
  openFixture,
  pageMap,
  pageText,
  readSelection,
  truthOf,
} from '../support/tl-blind.spec-blind';

test.setTimeout(240_000);

test('Ctrl+A selects the whole page text and Ctrl+C gives the engine\'s page text', async ({ openViewer, server, context }, testInfo) => {
  const reader = await openClipboardReader(context, server);
  const problems: string[] = [];
  for (const fx of FIXTURES) {
    const o = await openFixture(openViewer, server, fx);
    const glyphs = await glyphsOf(o.page, o.pageIndex);
    const visible = glyphs.filter(isVisible);
    const first = visible[0];
    const last = visible[visible.length - 1];

    // Focus the page the way a reader does: a click in the margin of the page (no text there), then Ctrl+A.
    const map = await pageMap(o.page, o.pageIndex);
    const margin = map.toClient(8, 8);
    await o.page.mouse.click(margin.x, margin.y);
    await clearSelection(o.page);
    await o.page.keyboard.press('Control+A');
    await o.page.waitForTimeout(250);
    const { ranges } = await readSelection(o.page);
    const mine = ranges.filter((r) => r.pageIndex === o.pageIndex);
    await o.page.screenshot({ path: testInfo.outputPath(`t22-select-all-${fx.name}.png`) });

    if (mine.length !== 1) {
      problems.push(`${fx.name}: Ctrl+A left ${mine.length} ranges on the page (${JSON.stringify(ranges)})`);
      await o.page.close();
      continue;
    }
    const r = mine[0];
    if (r.start > first.index || r.end < last.index + 1) problems.push(`${fx.name}: Ctrl+A selected [${r.start}, ${r.end}) but the text runs from ${first.index} to ${last.index}`);
    if (ranges.some((x) => x.pageIndex < o.pageIndex)) problems.push(`${fx.name}: Ctrl+A selected an earlier page`);

    const copied = await copySelection(o.page, reader);
    if (copied === '') {
      problems.push(`${fx.name}: Ctrl+C after Ctrl+A copied nothing`);
      await o.page.close();
      continue;
    }
    const engine = await pageText(o.page, o.pageIndex);
    const single = fx.name !== 'resnet-p1' && fx.name !== 'attention-p1';
    if (single) {
      // The whole copy is this page: same letters as the engine's text, breaks as in the copy rules.
      if (squash(copied) !== squash(engine)) problems.push(`${fx.name}: the copy is not the engine's page text (${squash(copied).length} vs ${squash(engine).length} letters)`);
      for (const p of copyProblems(glyphs, first.index, last.index + 1, copied, { rtl: fx.dir === 'rtl' })) problems.push(`${fx.name}: ${p}`);
      const truth = truthOf(fx);
      if (truth !== null && fx.dir === 'ltr' && squash(copied) !== squash(truth)) problems.push(`${fx.name}: the copy differs from the hand-written truth text of the page`);
    } else {
      // A paper has more pages near the viewport: page 1's text comes first, whole.
      if (!squash(copied).startsWith(squash(engine))) problems.push(`${fx.name}: the copy does not begin with the first page's text`);
    }
    if (/[\uFB00-\uFB06]/u.test(copied) || copied.includes('\u0000')) problems.push(`${fx.name}: the copy holds a ligature character or NUL`);
    // The click after Ctrl+A lets go.
    const at = centreOf(map, first);
    await o.page.mouse.click(at.x, at.y);
    if ((await readSelection(o.page)).ranges.length !== 0) problems.push(`${fx.name}: a click on the page did not clear the selection`);
    await o.page.close();
  }
  await reader.close();
  expect(problems).toEqual([]);
});

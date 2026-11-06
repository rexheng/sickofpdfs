// Gate 1, Phase 2 plan section 4, item 13: "Speed smoke."
//   "A mark appears in under 50 ms, the note box in under 100 ms, and a figure outline in under 100 ms. On Linux the limits are loose;
//    the perf gate checks the real budgets. The perf marks are sop:mark-drawn, sop:notebox-open and sop:figure-outline."
// Spec, Speed budgets: "any mark under 50 ms; note box under 100 ms; figure outline under 100 ms after hovering ... CI runs looser smoke
// versions so random slowness never blocks work."
//
// How it measures, in the page: the time of the key press (capture phase, so no handler can delay it) to the first change of an SVG
// mark layer on a page (not the selection's own SVG), or to the next frame after a note box was added. The limits here are the spec's
// times three (the box is shared and loaded); the median of five tries must be inside them. The perf marks of the plan must exist.
//
// GUESSES: marks are drawn as an SVG overlay per page (spec: "marks draw as an SVG overlay"); each perf mark is a `performance.mark`
// with that name, made when the mark is drawn, the box is open or the outline is shown, on the page's own clock (so its start time
// minus the time of the key press is the delay).
import { expect, hooks, test } from '../support/test';
import {
  ATTENTION,
  FIGURES_AVAILABLE,
  LINES,
  LOOSE,
  NO_FIGURES,
  WIDE,
  clearSelection,
  installTiming,
  note,
  noteBox,
  openPaper,
  readTiming,
  selectPassage,
  settle,
  type Passage,
} from './support/marks.spec-blind';
import { shot } from './support/takeover';

test.setTimeout(150_000);

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const TRIES: Passage[] = [LINES.l1, LINES.l3, LINES.l5, LINES.l7, LINES.l9];

test('Speed: a mark, the note box, bold and a figure outline appear within their time budgets', async ({ step }, testInfo) => {
  test.setTimeout(600_000);
  await step('a mark appears in under 50 ms (smoke: 150), by key and by the menu, and the page says so with sop:mark-drawn', async ({ openViewer, server }) => {
    const page = await openPaper(openViewer, server, ATTENTION);
    await installTiming(page);
    const fromKey: number[] = [];
    const fromPerf: number[] = [];
    for (const line of TRIES) {
      await selectPassage(page, ATTENTION, line);
      await page.evaluate(() => performance.clearMarks('sop:mark-drawn'));
      await page.keyboard.press('h');
      await page.waitForTimeout(350);
      const t = await readTiming(page);
      expect(t.markDrawn, `a mark layer changed after H (no change to an SVG mark layer was seen)`).not.toBeNull();
      fromKey.push(t.markDrawn!);
      const marks = t.perf['sop:mark-drawn'];
      expect(marks.length, 'the page made its sop:mark-drawn perf mark').toBeGreaterThan(0);
      fromPerf.push(marks.at(-1)! - t.keyAt!);
      await clearSelection(page);
    }
    note(testInfo, 'mark drawn, ms after H (5 tries)', fromKey.map((x) => x.toFixed(0)).join(', '));
    note(testInfo, 'sop:mark-drawn, ms after H (5 tries)', fromPerf.map((x) => x.toFixed(0)).join(', '));
    expect(median(fromKey), `the median mark is on the page within ${50 * LOOSE} ms (the spec says 50)`).toBeLessThanOrEqual(50 * LOOSE);
    expect(Math.max(...fromKey), 'and none was very slow').toBeLessThanOrEqual(50 * LOOSE * 3);
    expect.soft(median(fromPerf), 'sop:mark-drawn is made when the mark is drawn, after the key press and not long after').toBeGreaterThanOrEqual(0);
    expect.soft(median(fromPerf), `and within ${50 * LOOSE} ms`).toBeLessThanOrEqual(50 * LOOSE);
    await shot(page, testInfo, 'five-marks');
  }, 150_000);
  await step('the note box opens in under 100 ms (smoke: 300), and the page says so with sop:notebox-open', async ({ openViewer, server }) => {
    const page = await openPaper(openViewer, server, ATTENTION);
    await installTiming(page);
    const fromKey: number[] = [];
    const fromPerf: number[] = [];
    for (const line of TRIES) {
      await selectPassage(page, ATTENTION, line);
      await page.evaluate(() => performance.clearMarks('sop:notebox-open'));
      await page.keyboard.press('Control+Alt+m');
      await expect(noteBox(page)).toBeVisible({ timeout: 3000 });
      await page.waitForTimeout(250);
      const t = await readTiming(page);
      expect(t.noteBox, 'the note box was added to the page after Ctrl+Alt+M').not.toBeNull();
      fromKey.push(t.noteBox!);
      const marks = t.perf['sop:notebox-open'];
      expect(marks.length, 'the page made its sop:notebox-open perf mark').toBeGreaterThan(0);
      fromPerf.push(marks.at(-1)! - t.keyAt!);
      await page.keyboard.press('Escape'); // an empty new note is dropped
      await expect(noteBox(page)).toHaveCount(0);
      await clearSelection(page);
    }
    note(testInfo, 'note box open, ms after Ctrl+Alt+M (5 tries)', fromKey.map((x) => x.toFixed(0)).join(', '));
    note(testInfo, 'sop:notebox-open, ms after Ctrl+Alt+M (5 tries)', fromPerf.map((x) => x.toFixed(0)).join(', '));
    expect(median(fromKey), `the median box is open within ${100 * LOOSE} ms (the spec says 100)`).toBeLessThanOrEqual(100 * LOOSE);
    expect(Math.max(...fromKey), 'and none was very slow').toBeLessThanOrEqual(100 * LOOSE * 3);
    expect.soft(median(fromPerf)).toBeGreaterThanOrEqual(0);
    expect.soft(median(fromPerf), `sop:notebox-open is within ${100 * LOOSE} ms of the key`).toBeLessThanOrEqual(100 * LOOSE);
  }, 150_000);
  await step('bold on a whole paragraph still appears quickly (smoke: 150 ms), because it is drawn from the glyphs\' own outlines', async ({ openViewer, server }) => {
    const page = await openPaper(openViewer, server, ATTENTION);
    await installTiming(page);
    const abstract: Passage = { from: 'The dominant sequence transduction models', to: 'limited training data.' };
    const tries: number[] = [];
    for (let i = 0; i < 3; i++) {
      const sel = await selectPassage(page, ATTENTION, abstract);
      expect(sel.b - sel.a, 'the abstract is a long selection').toBeGreaterThan(900);
      await page.keyboard.press('Control+b');
      await page.waitForTimeout(500);
      const t = await readTiming(page);
      expect(t.markDrawn, 'bold changed a mark layer (no change to an SVG mark layer was seen)').not.toBeNull();
      tries.push(t.markDrawn!);
      await selectPassage(page, ATTENTION, abstract); // and take it off again
      await page.keyboard.press('Control+b');
      await page.waitForTimeout(300);
      await clearSelection(page);
    }
    note(testInfo, 'bold on ~1000 characters, ms after Ctrl+B (3 tries)', tries.map((x) => x.toFixed(0)).join(', '));
    expect(median(tries), `the median bold is on the page within ${50 * LOOSE} ms (the spec says 50)`).toBeLessThanOrEqual(50 * LOOSE);
    await shot(page, testInfo, 'bold-paragraph');
  }, 150_000);
  await step('a figure outline shows in under 100 ms (smoke: 300) after hovering, and the page says so with sop:figure-outline', async ({ openViewer, server }) => {
    if (!FIGURES_AVAILABLE) {
      testInfo.annotations.push({ type: 'step skipped', description: NO_FIGURES });
      return;
    }
    const page = await openViewer(server.url('/f/objects.pdf'));
    await page.setViewportSize(WIDE);
    await page.waitForFunction(() => (globalThis as unknown as { __sopTest?: { viewerState?: () => string } }).__sopTest?.viewerState?.() === 'ready', undefined, { timeout: 25_000 });
    await hooks(page).eval((h) => h.viewer.setScale(1));
    await hooks(page).eval((h) => h.viewer.scrollTo(0));
    await settle(page, 4000); // figure detection runs when the page is idle, after its full render
    await installTiming(page, { pointer: true });
    // the photo of objects.pdf: (72, 90) 216 x 144 pt, on page 1
    const photo = await hooks(page).eval((h) => h.viewer.clientPointOf({ pageIndex: 0, x: 72 + 108, y: 90 + 72 }));
    const away = await hooks(page).eval((h) => h.viewer.clientPointOf({ pageIndex: 0, x: 400, y: 600 }));
    const fromHover: number[] = [];
    for (let i = 0; i < 5; i++) {
      await page.mouse.move(away.x, away.y);
      await page.waitForTimeout(300);
      await page.evaluate(() => performance.clearMarks('sop:figure-outline'));
      await page.mouse.move(photo.x, photo.y);
      await page.waitForTimeout(350);
      const t = await readTiming(page);
      // Triage (Round 3 harness check): the spec does not say the figure outline is an SVG, so the delay is the first change of an SVG
      // mark layer when there is one, and otherwise the page's own perf mark, which the plan names (sop:figure-outline).
      const performed = t.perf['sop:figure-outline'];
      expect(performed.length, 'the page made its sop:figure-outline perf mark').toBeGreaterThan(0);
      expect(t.keyAt, 'the probe heard the pointer move').not.toBeNull();
      fromHover.push(t.markDrawn ?? performed.at(-1)! - t.keyAt!);
    }
    note(testInfo, 'figure outline, ms after the pointer moved (5 tries)', fromHover.map((x) => x.toFixed(0)).join(', '));
    expect(median(fromHover), `the median outline shows within ${100 * LOOSE} ms (the spec says 100)`).toBeLessThanOrEqual(100 * LOOSE);
    await shot(page, testInfo, 'figure-outline');
  }, 150_000);
});

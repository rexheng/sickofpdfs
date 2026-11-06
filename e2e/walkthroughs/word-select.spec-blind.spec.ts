// User tests for Task 22, R28: a double-click selects the whole word on at least 95% of words across the text-layer
// fixtures (the Phase 0 report found 2 of 517 split words came out whole, because the layer cuts words into spans).
// Triple-click is not defined by the interface file; the test asks only what a reader expects of it (the line, and not
// the neighbouring column).
// Spec: "An invisible text layer ... makes selecting, double-clicking and copying work like any web page".
import { expect, test } from '../support/test';
import {
  centreOf,
  clearSelection,
  FIXTURES,
  fixture,
  glyphsOf,
  isVisible,
  openFixture,
  pageMap,
  rng,
  trimmed,
  wordsOf,
  th,
  type CharRange,
  type Opened,
  type Word,
} from '../support/tl-blind.spec-blind';

test.setTimeout(240_000);

const PER_FIXTURE = 45;

/** Words spread over the page, the same ones every run. Every word of a small page; a seeded stride over a big one. */
/**
 * The boxes of the page's links, in client px. Triage note (navprint): a double-click on a word under a link follows
 * the link on its first click, as in Chrome's viewer, so words under `a.sop-link` are skipped. Links are read at idle
 * time (at most 500 ms after the page is drawn), hence the short wait.
 */
async function linkBoxes(page: Opened['page'], pageIndex: number): Promise<{ x: number; y: number; w: number; h: number }[]> {
  await page.waitForTimeout(800);
  return page.evaluate(
    (i) =>
      [...document.querySelectorAll(`[data-page-index="${i}"] a.sop-link`)].map((a) => {
        const r = a.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      }),
    pageIndex,
  );
}

const underLink = (boxes: { x: number; y: number; w: number; h: number }[], at: { x: number; y: number }): boolean =>
  boxes.some((b) => at.x >= b.x - 1 && at.x <= b.x + b.w + 1 && at.y >= b.y - 1 && at.y <= b.y + b.h + 1);

function sample(words: Word[], n: number, seed: string): Word[] {
  if (words.length <= n) return words;
  const random = rng(seed);
  const picked = new Set<number>();
  while (picked.size < n) picked.add(Math.floor(random() * words.length));
  return [...picked].sort((a, b) => a - b).map((i) => words[i]);
}

test('Double and triple clicks select whole words, words with ligatures, and lines', async ({ step }, testInfo) => {
  test.setTimeout(720_000);
  await step('double-clicking a word selects that whole word, on at least 95% of words across the fixtures', async ({ openViewer, server }) => {
    const rows: string[] = [];
    const misses: string[] = [];
    let tried = 0;
    let whole = 0;
    for (const fx of FIXTURES) {
      const o = await openFixture(openViewer, server, fx);
      const glyphs = await glyphsOf(o.page, o.pageIndex);
      const map = await pageMap(o.page, o.pageIndex);
      const words = sample(wordsOf(glyphs, fx.dir === 'rtl' ? 'he' : 'en', { rtl: fx.dir === 'rtl' }), PER_FIXTURE, `dbl-${fx.name}`);
      const links = await linkBoxes(o.page, o.pageIndex);
      let ok = 0;
      let skipped = 0;
      for (const w of words) {
        // The glyph in the middle of the word, as a reader aims.
        const visible = glyphs.slice(w.start, w.end).filter(isVisible);
        if (visible.length === 0) continue;
        const target = visible[Math.floor(visible.length / 2)];
        const at = centreOf(map, target);
        if (underLink(links, at)) {
          skipped++;
          continue;
        }
        await o.page.mouse.move(at.x, at.y);
        await o.page.mouse.dblclick(at.x, at.y);
        const ranges: CharRange[] = await th(o.page).eval((h) => {
          const r = h.selectionRanges();
          getSelection()?.removeAllRanges();
          return r;
        });
        tried++;
        const mine = ranges.filter((r) => r.pageIndex === o.pageIndex);
        const [a, b] = mine.length === 1 ? trimmed(glyphs, mine[0]) : [-1, -1];
        if (mine.length === 1 && a === w.start && b === w.end) {
          ok++;
          whole++;
        } else if (misses.length < 40) {
          misses.push(`${fx.name}: "${w.text}" [${w.start}, ${w.end}) got ${mine.length === 1 ? `[${mine[0].start}, ${mine[0].end}) trimmed [${a}, ${b})` : JSON.stringify(ranges)}`);
        }
      }
      rows.push(`${fx.name}: ${ok}/${words.length - skipped}${skipped > 0 ? ` (${skipped} under links skipped)` : ''}`);
      if (fx.name === 'resnet-p1') {
        // A picture of one double-click, for the record (on a word that is not under a link).
        const free = words.filter((x) => !underLink(links, centreOf(map, glyphs[Math.floor((x.start + x.end) / 2)])));
        const w = free[Math.floor(free.length / 2)];
        const g = glyphs[Math.floor((w.start + w.end) / 2)];
        const at = centreOf(map, g);
        await o.page.mouse.dblclick(at.x, at.y);
        await o.page.waitForTimeout(250);
        await o.page.screenshot({ path: testInfo.outputPath('t22-double-click-word.png') });
      }
      await o.page.close();
    }
    testInfo.annotations.push({ type: 'double-click, whole words', description: `${whole}/${tried}; ${rows.join('; ')}` });
    expect(tried, 'enough words were tried').toBeGreaterThan(150);
    expect(whole / tried, `whole words: ${whole}/${tried} (${rows.join('; ')})\nmisses:\n${misses.join('\n')}`).toBeGreaterThanOrEqual(0.95);
  }, 240_000);
  await step('double-clicking a word with a ligature in it (office, fluffy, affine, file) selects all of it', async ({ openViewer, server }) => {
    const fx = fixture('ligatures');
    const o = await openFixture(openViewer, server, fx);
    const glyphs = await glyphsOf(o.page, o.pageIndex);
    const map = await pageMap(o.page, o.pageIndex);
    const bad: string[] = [];
    for (const w of wordsOf(glyphs, 'en')) {
      const visible = glyphs.slice(w.start, w.end).filter(isVisible);
      // Aim at every glyph of the word, not only the middle: a ligature shares one box between letters.
      for (const target of visible) {
        await clearSelection(o.page);
        const at = centreOf(map, target);
        await o.page.mouse.dblclick(at.x, at.y);
        const ranges = await th(o.page).eval((h) => h.selectionRanges());
        const [a, b] = ranges.length === 1 ? trimmed(glyphs, ranges[0]) : [-1, -1];
        if (a !== w.start || b !== w.end) bad.push(`"${w.text}" aimed at glyph ${target.index} "${target.text}": got ${JSON.stringify(ranges)}`);
      }
    }
    expect(bad).toEqual([]);
  }, 240_000);
  await step('triple-click selects the line, and does not reach into the other column', async ({ openViewer, server }) => {
    const o = await openFixture(openViewer, server, fixture('two-column'));
    const glyphs = await glyphsOf(o.page, o.pageIndex);
    const map = await pageMap(o.page, o.pageIndex);
    const visible = glyphs.filter(isVisible);
    const midX = 612 / 2;
    const column = (g: { box: { x: number; width: number } }) => (g.box.x + g.box.width / 2 < midX ? 'left' : 'right');
    const failures: string[] = [];
    for (const [side, nth] of [['left', 9], ['right', 9], ['left', 20]] as const) {
      const inSide = visible.filter((g) => column(g) === side);
      // The nth line of the column: group by vertical centre.
      const rowsOf: (typeof visible)[] = [];
      for (const g of inSide) {
        const y = g.box.y + g.box.height / 2;
        const last = rowsOf[rowsOf.length - 1];
        if (last && Math.abs(last[0].box.y + last[0].box.height / 2 - y) <= 0.5 * g.fontSize) last.push(g);
        else rowsOf.push([g]);
      }
      const line = rowsOf[nth];
      const target = line[Math.floor(line.length / 3)];
      await clearSelection(o.page);
      const at = centreOf(map, target);
      await o.page.mouse.click(at.x, at.y, { clickCount: 3 });
      await o.page.waitForTimeout(80);
      const ranges = await th(o.page).eval((h) => h.selectionRanges());
      if (nth === 9 && side === 'left') await o.page.screenshot({ path: testInfo.outputPath('t22-triple-click-line.png') });
      const mine = ranges.filter((r) => r.pageIndex === o.pageIndex);
      if (mine.length !== 1) {
        failures.push(`${side} line ${nth}: ${mine.length} ranges`);
        continue;
      }
      const picked = glyphs.slice(mine[0].start, mine[0].end).filter(isVisible);
      const have = new Set(picked.map((g) => g.index));
      const missing = line.filter((g) => !have.has(g.index));
      if (missing.length > 0) failures.push(`${side} line ${nth}: the line is not all selected (${missing.length} of ${line.length} glyphs missing, e.g. "${missing[0].text}")`);
      const strays = picked.filter((g) => column(g) !== side);
      if (strays.length > 0) failures.push(`${side} line ${nth}: ${strays.length} glyphs of the other column were selected`);
      if (picked.length > 0.5 * inSide.length) failures.push(`${side} line ${nth}: ${picked.length} of the column's ${inSide.length} glyphs are selected (more than a paragraph's worth)`);
    }
    expect(failures).toEqual([]);
  }, 240_000);
});

// Helpers for walkthrough 19, "Bold word starts" (ruling R90). Written from the spec only: R90, the View-menu and shortcut-sheet wording the other
// walkthroughs already rely on, and the speed budgets. Nothing here looks at how the feature is built; it only looks at what the owner sees.
//
// HOW "BOLD" IS READ FROM THE OUTSIDE (the one idea of this file)
//   The feature draws a heavier stroke along the outline of a glyph, over the page's picture (R90: "reuses the bold mark's glyph-outline overlay"). So a bold
//   letter is a letter that holds MORE INK than the same letter drawn plain. The test takes the same page three times:
//     OFF   the switch is off (the page as the file draws it);
//     FULL  the switch is off and the owner's own bold mark covers the whole passage (every letter bold, drawn by the existing bold mark);
//     ON    the switch is on (and the bold mark is taken off again).
//   For every letter it measures the ink gain, (ink in a box round the letter's ink box, ON or FULL, over OFF) - 1, where the box comes from the text
//   layer's own geometry (the engine's tight glyph box, grown a little). The FULL gain is that letter's own yardstick: it already holds the effect of the
//   letter's shape, its size and its neighbours. The letter is "drawn bold" when its ON gain is at least half its FULL gain. A letter that is not bold gains
//   nothing, or only the touch of a neighbour's heavier edge, which is well under half. The spec says the stroke is heavier than the bold mark's, so a
//   bold start should come out at 1 or more of the yardstick; the walkthrough only asks for 0.5 (is it bold at all) and reports the real median.
//   The words themselves are worked out from the engine's text (the glyphs of the passage), by the rule of R90, never from the product.
//
// WHAT THE RULE IS (R90, "What it does")
//   Only letters count. A word of 1 to 3 letters: its first letter is bold. A longer word: the first half rounded up (4 letters: 2; 5: 3; 7: 4; 12: 6).
//   Pure numbers, maths symbols and punctuation are left alone. Each part of a hyphenated word is a word of its own. A word broken across lines counts per line.
//   (The spec's three examples, "Rea·ding", "meth·od", "facili·tating", do not all follow its own rule: "Reading" has 7 letters, so 4 are bold by the rule, and
//   "method" has 6, so 3. The walkthrough follows the RULE and the report says so.)
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserContext, Locator, Page, TestInfo } from '@playwright/test';
import jpeg from 'jpeg-js';
import { PDFDocument, StandardFonts, TextRenderingMode, rgb, setTextRenderingMode } from 'pdf-lib';
import { expect, freshOutputPath } from '../../support/test';
import { findOnPage, glyphsOf, pageMap, settle, type PageMap } from '../../support/tl-blind.spec-blind';
import { REPO_ROOT } from '../../support/launch';
import { decodePng, type Box } from '../../support/tl-paint.spec-blind';
import { WALKTHROUGH_DIR } from './fixtures.spec-blind';
import { answerSavePrompt, clearSelection, selectPassage, type Passage, type Shot, type TlFixture } from './marks.spec-blind';
import { openViewMenu } from './views.spec-blind';
import {
  BOLD_AT,
  CHROME_KEYS,
  MIN_YARDSTICK,
  boldCount,
  changedShare,
  coverageGaps,
  darknessIn,
  describeModel,
  describeVerdict,
  gainOf,
  judge,
  median,
  modelOf,
  pressable,
  whatIsWrong,
  type LetterWant,
  type Model,
  type Verdict,
  type Want,
} from './word-starts-rule.spec-blind';
export { BOLD_AT, CHROME_KEYS, MIN_YARDSTICK, boldCount, changedShare, coverageGaps, darknessIn, describeModel, describeVerdict, gainOf, judge, median, modelOf, pressable, whatIsWrong };
export type { LetterWant, Model, Verdict, Want };

// ---------------------------------------------------------------------------------------------------------------
// The switch, in the View menu

/** The View-menu group: "Bold word starts" (R90, "The switch"; R90c: Off, Light, Medium and Strong, as a radio group). */
export const WORD_STARTS = /Bold word starts/i;

// Triage (word starts round 3): guess G1 was a check-box row; R90c rules that View offers Off, Light, Medium and Strong
// directly, as one radio group named "Bold word starts". "On" is a choice other than Off; "the row" is the group's heading.
/** The radio group in the open View menu, and its choices. */
const choicesIn = (menu: Locator) => {
  const group = menu.getByRole('group', { name: WORD_STARTS });
  return { group, choice: (name: string) => group.getByRole('menuitemradio', { name, exact: true }) };
};

export interface SwitchState {
  /** The View menu has a group named for it. */
  present: boolean;
  /** The ARIA role of its choices: `menuitemradio` (R90c). */
  role: string | null;
  /** "true" when a choice other than Off is checked, "false" when Off is, null when none is. */
  checked: string | null;
  /** Everything the group's heading says, whitespace collapsed (its name and its shortcut). */
  text: string;
}

/** Opens View, reads the group and shuts the menu again. */
export async function switchState(page: Page): Promise<SwitchState> {
  const menu = await openViewMenu(page);
  const { group, choice } = choicesIn(menu);
  const present = (await group.count()) > 0;
  const out: SwitchState = { present, role: null, checked: null, text: '' };
  if (present) {
    out.role = await choice('Off').getAttribute('role');
    const off = await choice('Off').getAttribute('aria-checked');
    out.checked = off === 'true' ? 'false' : off === 'false' ? 'true' : null;
    const heading = await group.getAttribute('aria-labelledby');
    out.text = heading === null ? '' : (await menu.locator(`[id="${heading}"]`).innerText()).replace(/\s+/g, ' ').trim();
  }
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu'), 'the View menu closes').toBeHidden();
  return out;
}

/** Whether View shows "Bold word starts" ticked. Fails, naming the row, when View has no such row. */
export async function isOn(page: Page): Promise<boolean> {
  const state = await switchState(page);
  expect(state.present, 'View has a row named "Bold word starts" (R90: "It sits in the View menu as Bold word starts, with a check mark")').toBe(true);
  return state.checked === 'true';
}

/** View → Bold word starts → Medium when it is off, Off when it is on, with the mouse. Waits a moment for the pages to settle. */
export async function toggleFromMenu(page: Page): Promise<void> {
  const target = (await isOn(page)) ? 'Off' : 'Medium';
  const menu = await openViewMenu(page);
  await choicesIn(menu).choice(target).click();
  await settle(page, 300);
}

/** Makes the switch `on` (or off) from the View menu, and checks the check mark agrees. */
export async function setSwitch(page: Page, on: boolean): Promise<void> {
  if ((await isOn(page)) !== on) await toggleFromMenu(page);
  await expect.poll(() => isOn(page), { message: `the View menu shows "Bold word starts" ${on ? 'ticked' : 'not ticked'}`, timeout: 6_000 }).toBe(on);
}

// ---------------------------------------------------------------------------------------------------------------
// Pictures of the screen

/** The window as a picture once it has stopped changing (two shots in a row are the same bytes), with the pointer parked off the pages. */
export async function stableShot(page: Page, name?: string, testInfo?: TestInfo): Promise<Shot> {
  const size = page.viewportSize() ?? { width: 1280, height: 800 };
  await page.mouse.move(4, size.height / 2);
  let last = await page.screenshot();
  const deadline = Date.now() + 7_000;
  for (;;) {
    await page.waitForTimeout(170);
    const next = await page.screenshot();
    if (Buffer.compare(last, next) === 0 || Date.now() > deadline) {
      if (name !== undefined && testInfo !== undefined) {
        const path = freshOutputPath(testInfo, `${name}.png`);
        await writeFile(path, next);
        await testInfo.attach(name, { path, contentType: 'image/png' });
      }
      return { img: decodePng(next), dpr: await page.evaluate(() => window.devicePixelRatio) };
    }
    last = next;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Reading ink gains

export interface Look {
  shot: Shot;
  map: PageMap;
  /** Where the page element is in the window. */
  page: Box;
}

/** A settled picture of the window, where the page's points are in it, and where the page is. */
export async function look(page: Page, pageIndex: number, name?: string, testInfo?: TestInfo): Promise<Look> {
  const shot = await stableShot(page, name, testInfo);
  return { shot, map: await pageMap(page, pageIndex), page: await pageBox(page, pageIndex) };
}

// ---------------------------------------------------------------------------------------------------------------
// The three pictures of a passage, and the verdict

export interface RuleRun {
  verdict: Verdict;
  off: Look;
  full: Look;
  on: Look;
  a: number;
  b: number;
}

export interface RuleOptions {
  /** How the window is photographed. Default: `look` of the fixture's page. Presentation mode swaps this for "go into it, look, come out". */
  take?: (name: string) => Promise<Look>;
  /** A name for the pictures in test-results (`19-<label>-off.png` and so on). */
  label: string;
  testInfo: TestInfo;
  /** The part of the window the glyphs must lie inside to be judged (default: the whole window). */
  view?: Box;
}

/** The first and last char of a passage on a page, found by the engine. */
export async function charRange(page: Page, fx: TlFixture, p: Passage): Promise<{ a: number; b: number }> {
  const first = await findOnPage(page, fx.page, p.from);
  const last = await findOnPage(page, fx.page, p.to);
  return { a: first.start, b: last.start + last.count - 1 };
}

/**
 * The whole measurement for one passage: OFF, then FULL (the owner's bold mark over the whole passage, Ctrl+B), then the bold mark taken off again,
 * then ON. Ends with the switch on. The page must show the passage and must not scroll or zoom between the pictures.
 */
export async function runRule(page: Page, fx: TlFixture, passage: Passage, o: RuleOptions): Promise<RuleRun> {
  const take = o.take ?? ((name: string) => look(page, fx.page, name, o.testInfo));
  await setSwitch(page, false);
  const { a, b } = await charRange(page, fx, passage);
  const off = await take(`19-${o.label}-off`);

  await selectPassage(page, fx, passage);
  await page.keyboard.press('Control+b');
  await answerSavePrompt(page, 'Yes', 700);
  await clearSelection(page);
  const full = await take(`19-${o.label}-bold-mark`);

  await selectPassage(page, fx, passage);
  await page.keyboard.press('Control+b'); // Ctrl+B again takes the bold off
  await clearSelection(page);
  const again = await take(`19-${o.label}-off-again`);
  const restored = changedShare(off.shot, again.shot, off.page);
  expect(restored, `${o.label}: taking the owner's bold mark off again puts the page back as it was (the walkthrough needs a clean OFF picture)`).toBeLessThan(0.002);

  await setSwitch(page, true);
  const on = await take(`19-${o.label}-on`);
  const glyphs = await glyphsOf(page, fx.page);
  const verdict = judge({ glyphs, a, b, map: on.map, off: off.shot, full: full.shot, on: on.shot, ...(o.view !== undefined ? { view: o.view } : {}) });
  return { verdict, off, full, on, a, b };
}

// ---------------------------------------------------------------------------------------------------------------
// How fast bold shows: the compositor's own frames

export interface Latency {
  /** Milliseconds from the trigger to the first frame the screen showed with the effect; null if none did in time. */
  ms: number | null;
  frames: number;
}

/**
 * Starts the browser's screencast (the frames it actually puts on the screen, each with the time it was swapped in), runs `trigger`, and reports how
 * long it was until a frame showed more than a speck of change inside `region` (CSS px) against the frame that was on the screen before the trigger.
 * `trigger` should do one thing, the input that turns the effect on, so the clock starts as close to it as can be.
 */
export async function paintLatency(page: Page, region: Box, trigger: () => Promise<void>, o: { timeoutMs?: number; exclude?: Box } = {}): Promise<Latency> {
  const timeoutMs = o.timeoutMs ?? 5_000;
  const cdp = await page.context().newCDPSession(page);
  const frames: { t: number; data: string }[] = [];
  cdp.on('Page.screencastFrame', (f) => {
    frames.push({ t: (f.metadata.timestamp ?? Date.now() / 1000) * 1000, data: f.data });
    void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined);
  });
  try {
    const size = page.viewportSize() ?? { width: 1280, height: 800 };
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, everyNthFrame: 1, maxWidth: size.width, maxHeight: size.height });
    // A baseline: the frame that is on the screen before the trigger. A still page sends none, so a tiny repaint is asked for.
    const begin = Date.now();
    while (frames.length === 0 && Date.now() - begin < 3_000) {
      await page.evaluate(() => {
        const e = document.createElement('div');
        e.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;background:rgba(0,0,0,0.01);pointer-events:none';
        document.body.append(e);
        requestAnimationFrame(() => requestAnimationFrame(() => e.remove()));
      });
      await page.waitForTimeout(120);
    }
    if (frames.length === 0) throw new Error('paintLatency: the browser sent no screencast frame at all');
    await page.waitForTimeout(350); // everything that was going to be painted has been
    const t0 = Date.now();
    const known = frames.length;
    await trigger();
    const base = frames[known - 1];
    const baseImg = jpeg.decode(Buffer.from(base.data, 'base64'), { useTArray: true, formatAsRGBA: true });
    const ratio = baseImg.width / size.width;
    const specks = (img: { width: number; height: number; data: Uint8Array }): number => {
      let n = 0;
      const x0 = Math.max(0, Math.floor(region.left * ratio));
      const x1 = Math.min(img.width, Math.ceil(region.right * ratio));
      const y0 = Math.max(0, Math.floor(region.top * ratio));
      const y1 = Math.min(img.height, Math.ceil(region.bottom * ratio));
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          if (o.exclude !== undefined && x / ratio >= o.exclude.left - 6 && x / ratio <= o.exclude.right + 6 && y / ratio >= o.exclude.top - 6 && y / ratio <= o.exclude.bottom + 6) continue;
          const at = (y * img.width + x) * 4;
          const l = (p: Uint8Array | Uint8ClampedArray, k: number) => 0.299 * p[k] + 0.587 * p[k + 1] + 0.114 * p[k + 2];
          if (Math.abs(l(img.data, at) - l(baseImg.data, at)) > 24) n++;
        }
      }
      return n;
    };
    let seen = known;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      while (seen < frames.length) {
        const f = frames[seen++];
        if (f.t < t0 - 2) continue;
        const img = jpeg.decode(Buffer.from(f.data, 'base64'), { useTArray: true, formatAsRGBA: true });
        if (specks(img) >= 150) return { ms: Math.max(0, f.t - t0), frames: frames.length };
      }
      await page.waitForTimeout(25);
    }
    return { ms: null, frames: frames.length };
  } finally {
    await cdp.send('Page.stopScreencast').catch(() => undefined);
    await cdp.detach().catch(() => undefined);
  }
}

/** Opens View and returns the centre of the choice that turns Bold word starts on (Medium) or off (Off), so one mouse click on it can be timed. */
export async function rowCentre(page: Page): Promise<{ x: number; y: number }> {
  const target = (await isOn(page)) ? 'Off' : 'Medium';
  const menu = await openViewMenu(page);
  const row = choicesIn(menu).choice(target);
  await expect(row, `View offers "Bold word starts: ${target}"`).toBeVisible();
  const b = await row.boundingBox();
  if (b === null) throw new Error('the Bold word starts choice has no box');
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/**
 * Installs a timer in the page: at the last click or key press (capture phase) it notes the event time, then the time of the first change inside a
 * page's own box that adds or changes drawing (an SVG, a path or a canvas; the selection layer and menus do not count). R90 says the bold is "the bold
 * mark's glyph-outline overlay", an SVG; if the product draws it some other way this reads null and the frames of paintLatency are all there is.
 */
export async function installDomTimer(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __wsDom: { startAt: number | null; first: number | null } };
    w.__wsDom = { startAt: null, first: null };
    const start = (e: Event): void => {
      w.__wsDom.startAt = e.timeStamp;
      w.__wsDom.first = null;
    };
    window.addEventListener('click', start, { capture: true });
    window.addEventListener('keydown', start, { capture: true });
    const drawing = (n: Node): boolean => {
      const el = n instanceof Element ? n : n.parentElement;
      if (el === null) return false;
      if (el.closest('.sop-selection, [role="menu"], [role="menubar"]') !== null) return false;
      if (el.closest('[data-page-index]') === null) return false;
      return el instanceof SVGElement || el.querySelector('svg, path, canvas') !== null;
    };
    new MutationObserver((records) => {
      const t = w.__wsDom;
      if (t.startAt === null || t.first !== null) return;
      if (records.some((m) => drawing(m.target) || Array.from(m.addedNodes).some(drawing))) t.first = performance.now();
    }).observe(document.documentElement, { subtree: true, childList: true, attributes: true });
  });
}

/** Milliseconds from the last click or key to the first drawing change inside a page, or null if the page made none. */
export const readDomTimer = (page: Page): Promise<number | null> =>
  page.evaluate(() => {
    const t = (window as unknown as { __wsDom: { startAt: number | null; first: number | null } }).__wsDom;
    return t.startAt !== null && t.first !== null ? t.first - t.startAt : null;
  });

/** The share of a page's pixels that change when the switch goes from on to off (and back on): how much bold start there is on it. Ends with the switch on. */
export async function drawnShare(page: Page, pageIndex: number, o: { except?: () => Box[]; name?: string; testInfo?: TestInfo } = {}): Promise<number> {
  await setSwitch(page, true);
  const on = await look(page, pageIndex, o.name !== undefined ? `${o.name}-on` : undefined, o.testInfo);
  await setSwitch(page, false);
  const off = await look(page, pageIndex, o.name !== undefined ? `${o.name}-off` : undefined, o.testInfo);
  await setSwitch(page, true);
  return changedShare(on.shot, off.shot, on.page, 2, o.except !== undefined ? o.except() : []);
}

/** A share of changed page pixels that is more than speckle: bold starts on a page of text change several in a thousand. */
export const SOMETHING_DRAWN = 0.003;

/** The verdict of `runRule` as expectations, one for each part of R90's rule, so a failure names the part. */
export function expectRule(v: Verdict, label: string, minAssessed: number): void {
  const list = (xs: string[]): string => `\n  ${xs.slice(0, 6).join('\n  ')}${xs.length > 6 ? `\n  ... and ${xs.length - 6} more` : ''}`;
  expect.soft(v.assessed, `${label}: enough of the passage could be judged (${describeVerdict(v)})`).toBeGreaterThanOrEqual(minAssessed);
  expect.soft(v.byRule.numbersBold.length, `${label}: pure numbers are left alone${list(v.byRule.numbersBold)}`).toBe(0);
  expect.soft(v.byRule.hyphensBold.length, `${label}: a hyphen is left alone${list(v.byRule.hyphensBold)}`).toBe(0);
  expect.soft(v.byRule.firstLetterPlain.length, `${label}: the first letter of every word is bold${list(v.byRule.firstLetterPlain)}`).toBe(0);
  expect.soft(v.byRule.offByOne.length, `${label}: 1 to 3 letters: the first letter; longer: the first half rounded up${list(v.byRule.offByOne)}`).toBe(0);
  expect.soft(v.byRule.other.length, `${label}: nothing else is bold, and the first half is all bold${list(v.byRule.other)}`).toBe(0);
  expect.soft(v.medianOn, `${label}: the bold starts are clearly bold (${describeVerdict(v)})`).toBeGreaterThanOrEqual(0.15);
}

// ---------------------------------------------------------------------------------------------------------------
// The shortcut, read from the shortcut sheet

/** Opens the sheet with "?" and returns the dialog. */
export async function openSheet(page: Page): Promise<Locator> {
  await page.keyboard.press('?');
  const sheet = page.getByRole('dialog', { name: /shortcuts/i });
  await expect(sheet, '"?" opens the shortcut sheet').toBeVisible({ timeout: 5_000 });
  return sheet;
}

/** The keys the sheet lists for "Bold word starts": one string per <kbd>, as the sheet prints them ("Alt+B"), or null when the row is missing. */
export async function sheetKeys(sheet: Locator): Promise<{ label: string; keys: string[]; all: { label: string; keys: string[] }[] } | null> {
  const rows = await sheet.evaluate((root) =>
    Array.from(root.querySelectorAll('tr')).map((tr) => ({
      label: (tr.querySelector('th') ?? tr.querySelector('td'))?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      keys: Array.from(tr.querySelectorAll('kbd')).map((k) => (k.textContent ?? '').replace(/\s+/g, ' ').trim()),
    })),
  );
  const mine = rows.find((r) => WORD_STARTS.test(r.label));
  return mine === undefined ? null : { label: mine.label, keys: mine.keys, all: rows };
}

// ---------------------------------------------------------------------------------------------------------------
// The quiet note for a scanned page

export const SCAN_NOTE = 'Bold word starts works on text pages. This page is a scanned image.';

export interface NoteWatch {
  /** How many times the note went from not there to there. */
  appeared: number;
  /** Whether it is on the screen now. */
  showing: boolean;
  /** The note was inside a dialog or alert dialog, or held the keyboard focus when it came (a quiet note does neither). */
  loud: string[];
}

/** Runs in every extension page of the context before it loads: watches the page for the note's words. Serialised by Playwright: it uses nothing outside its body. */
export function installNoteWatch(sentence: string): void {
  if (location.protocol !== 'chrome-extension:') return;
  const w = window as unknown as { __wsNote: { appeared: number; showing: boolean; loud: string[] } };
  w.__wsNote = { appeared: 0, showing: false, loud: [] };
  let timer: number | undefined;
  const check = (): void => {
    timer = undefined;
    const text = (document.body?.textContent ?? '').replace(/\s+/g, ' ');
    const now = text.includes(sentence);
    if (now && !w.__wsNote.showing) {
      w.__wsNote.appeared++;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
        if (!(n.nodeValue ?? '').includes('Bold word starts works')) continue;
        const el = n.parentElement;
        if (el === null) break;
        if (el.closest('[role="dialog"], [role="alertdialog"], dialog, [aria-modal="true"]') !== null) w.__wsNote.loud.push('the note is inside a dialog');
        if (el.contains(document.activeElement) && document.activeElement !== document.body) w.__wsNote.loud.push('the note took the keyboard focus');
        break;
      }
    }
    w.__wsNote.showing = now;
  };
  const arm = (): void => {
    timer ??= window.setTimeout(check, 40);
  };
  const start = (): void => {
    new MutationObserver(arm).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
    arm();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}

export async function useNoteWatch(context: BrowserContext): Promise<void> {
  await context.addInitScript(installNoteWatch, SCAN_NOTE);
}

export const noteWatch = (page: Page): Promise<NoteWatch> => page.evaluate(() => (window as unknown as { __wsNote: NoteWatch }).__wsNote);

// ---------------------------------------------------------------------------------------------------------------
// What the print path receives

export interface SheetHash {
  /** FNV-1a over the pixels of the print copy's picture of each sheet (first sheets only), taken the moment the viewer asks the browser to print. */
  sheets: { w: number; h: number; hash: string; dark: number }[];
}

/** Runs in every extension page before it loads: wraps window.print so the pictures of the print copy are read the moment printing is asked for. */
export function installSheetHasher(): void {
  if (location.protocol !== 'chrome-extension:') return;
  const w = window as unknown as { __wsPrints: { sheets: { w: number; h: number; hash: string; dark: number }[] }[] };
  w.__wsPrints = [];
  const inner = window.print.bind(window);
  const wrap = (): void => {
    const root = document.getElementById('sop-print-root');
    const sheets: { w: number; h: number; hash: string; dark: number }[] = [];
    for (const img of Array.from(root?.querySelectorAll('img') ?? []).slice(0, 2)) {
      if (!img.complete || img.naturalWidth === 0) continue;
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      if (ctx === null) continue;
      ctx.drawImage(img, 0, 0);
      const px = new Uint32Array(ctx.getImageData(0, 0, c.width, c.height).data.buffer);
      let h = 2166136261;
      let dark = 0;
      for (let i = 0; i < px.length; i++) {
        h = Math.imul(h ^ px[i], 16777619);
        if ((px[i] & 0xff) < 100) dark++;
      }
      sheets.push({ w: c.width, h: c.height, hash: (h >>> 0).toString(16), dark });
    }
    w.__wsPrints.push({ sheets });
  };
  // Our wrapper is installed after the recorder (if any) has replaced window.print, so it runs first and then calls it.
  window.print = () => {
    wrap();
    inner();
  };
}

export async function useSheetHasher(context: BrowserContext): Promise<void> {
  await context.addInitScript(installSheetHasher);
}

export const sheetHashes = (page: Page): Promise<SheetHash[]> => page.evaluate(() => (window as unknown as { __wsPrints: SheetHash[] }).__wsPrints);

// ---------------------------------------------------------------------------------------------------------------
// A PDF with text pages and scanned pages, made here

export const MIXED_FILE = 'wt-wordstarts-mixed.v1.pdf';
export const served = (name: string): string => `/f/walkthroughs/${name}`;
/** The paper whose pages 1 and 2 are the text pages of the mixed file (real embedded fonts; the lines are known). */
const PAPER_FILE = 'test-assets/classifier/learning/arxiv-1706.03762-attention.pdf';

/** A grey page of "scanned text": short dark dashes in rows, as a photograph of a printed page. No text in the file for it. */
function scannedPicture(width: number, height: number, seed: number): Uint8Array {
  const data = Buffer.alloc(width * height * 4, 255);
  let s = seed;
  const rand = (): number => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let row = 0; row < 38; row++) {
    const y0 = 150 + row * 30;
    let x = 130;
    while (x < width - 130) {
      const len = 14 + Math.floor(rand() * 60);
      for (let y = y0; y < y0 + 11 && y < height; y++) for (let k = x; k < Math.min(width - 130, x + len); k++) {
        const o = 4 * (y * width + k);
        const v = 25 + Math.floor(rand() * 40);
        data[o] = v;
        data[o + 1] = v;
        data[o + 2] = v;
      }
      x += len + 14 + Math.floor(rand() * 12);
    }
  }
  return jpeg.encode({ data, width, height }, 70).data;
}

/**
 * Four pages: 1 and 4 are pages 1 and 2 of "Attention Is All You Need" (real text in real embedded fonts); 2 is a scan (a picture and nothing else);
 * 3 is a scan with recognised text laid invisibly over its picture (text render mode 3, as OCR leaves it).
 * R90: "Pages without real text outlines (scans, and OCR text) are left as they are."
 */
export async function ensureMixedScan(): Promise<string> {
  const path = join(WALKTHROUGH_DIR, MIXED_FILE);
  if ((await stat(path).catch(() => null))?.isFile()) return path;
  await mkdir(WALKTHROUGH_DIR, { recursive: true });
  const paper = await PDFDocument.load(await readFile(join(REPO_ROOT, PAPER_FILE)));
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  const [p1, p2] = await doc.copyPages(paper, [0, 1]);
  const scan = async (seed: number, ocr: boolean): Promise<void> => {
    const page = doc.addPage([612, 792]);
    const image = await doc.embedJpg(scannedPicture(1224, 1584, seed));
    page.drawImage(image, { x: 0, y: 0, width: 612, height: 792 });
    if (ocr) {
      page.pushOperators(setTextRenderingMode(TextRenderingMode.Invisible));
      page.drawText('Recognised words sit invisibly over the picture of this page.', { x: 72, y: 640, size: 14, font, color: rgb(0, 0, 0) });
    }
  };
  doc.addPage(p1);
  await scan(7, false);
  await scan(9, true);
  doc.addPage(p2);
  const bytes = await doc.save();
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, bytes);
  await rename(tmp, path);
  return path;
}

/** The page element's rectangle in the window. */
export async function pageBox(page: Page, pageIndex: number): Promise<Box> {
  const r = await page.evaluate((i) => {
    const e = document.querySelector(`[data-page-index="${i}"]`)?.getBoundingClientRect();
    return e ? { left: e.left, top: e.top, right: e.right, bottom: e.bottom } : null;
  }, pageIndex);
  if (r === null) throw new Error(`page ${pageIndex + 1} is not on the screen`);
  return r;
}


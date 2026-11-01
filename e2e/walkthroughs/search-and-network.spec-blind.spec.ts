// Gate 1, Phase 2 plan section 4, item 12: "Search and the network."
//   "Search opens Google Scholar in a new tab, or doi.org for a reference that has a DOI. The network gate shows nothing else leaving."
// Spec, Marks: "Search opens Google or Google Scholar for the selected words in a new tab; on a reference in a bibliography it finds
// that paper (Google Scholar, DOI or arXiv)." Plan S13: "Search opens Google Scholar in a new tab, or the paper itself when the
// selection holds a DOI or an arXiv id." "Search sends only the selected words, and only when you press Search." Spec, "What leaves your
// computer": "Words you select and press Search on -> Google or Google Scholar, in a new tab -> Only when you press Search";
// "Anything else -> Nobody ... a build test fails on any other request."
//
// The walkthrough answers the three hosts itself (so no real request is made), notes every request the browser makes to anything but
// the fixture server, and then asks the network gate (the net log of the whole run) whether anything else left.
//
// GUESSES: the Scholar address is https://scholar.google.com/scholar?q=<the words>; a DOI goes to https://doi.org/<the DOI>; an arXiv id
// goes to https://arxiv.org/abs/<the id>. The walkthrough checks the host, and that the words or the id are in the address.
import type { BrowserContext } from '@playwright/test';
import { expect, test } from '../support/test';
import {
  ARXIV_PASSAGE,
  ATTENTION,
  LINES,
  PLOS,
  PLOS_DOI,
  PLOS_DOI_PASSAGE,
  RESNET_REFS,
  allCards,
  menuRow,
  markMenu,
  openPaper,
  postNote,
  replyBox,
  rightClickSelection,
  selectPassage,
} from './support/marks.spec-blind';
import { shot } from './support/takeover';

test.use({ networkGate: 'observe' });
test.setTimeout(120_000);

// "observe" asks every test to read the gate itself; a test that fails early still has to let the gate close the browser.
test.afterEach(async ({ netgate }) => {
  await netgate.report();
});

const SEARCH_HOSTS = /^https:\/\/(scholar\.google\.com|www\.google\.com|google\.com|doi\.org|dx\.doi\.org|arxiv\.org)\//;
const words = (s: string): string => s.replace(/\s+/gu, ' ').trim();

/** Answers the search hosts with a blank page, and notes each request that is not to the fixture server or the extension. */
async function watchOutside(context: BrowserContext, origin: string): Promise<string[]> {
  const outside: string[] = [];
  await context.route(SEARCH_HOSTS, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>stub</title><p>stub</p>' }));
  context.on('request', (r) => {
    const url = r.url();
    if (/^https?:/.test(url) && !url.startsWith(origin)) outside.push(url);
  });
  return outside;
}

test('Search on a sentence opens Google Scholar in a new tab, with those words and nothing else', async ({ context, openViewer, server, netgate }, testInfo) => {
  const outside = await watchOutside(context, server.origin);
  const page = await openPaper(openViewer, server, ATTENTION);
  const sel = await selectPassage(page, ATTENTION, LINES.l9);
  await page.waitForTimeout(500);
  expect(outside, 'before anyone presses Search nothing has left').toEqual([]);

  const before = context.pages().length;
  await rightClickSelection(page, sel);
  await expect(markMenu(page)).toBeVisible({ timeout: 3000 });
  const [tab] = await Promise.all([context.waitForEvent('page', { timeout: 10_000 }), menuRow(page, /search/i).click()]);
  await tab.waitForLoadState('domcontentloaded').catch(() => undefined);
  await expect.poll(() => tab.url(), { message: 'the new tab goes to a search address' }).toMatch(/^https:\/\//);
  const url = new URL(tab.url());
  await shot(tab, testInfo, 'search-tab');
  expect(url.host, 'Google Scholar').toBe('scholar.google.com');
  const q = url.searchParams.get('q') ?? '';
  expect(words(q.replaceAll('"', '')), `the address carries the selected words: ${tab.url()}`).toContain(words(sel.text));
  expect(tab.url(), 'and nothing about the PDF (its address, or where it came from)').not.toContain(server.origin.replace('http://', ''));
  expect(context.pages().length, 'one new tab').toBe(before + 1);
  expect(await page.evaluate(() => String(getSelection() ?? '')).then((t) => t.length), 'the viewer keeps the selection').toBeGreaterThan(0);

  const hosts = new Set(outside.map((u) => new URL(u).host));
  expect([...hosts], 'the only host anything was sent to is the search').toEqual(['scholar.google.com']);
  const report = await netgate.report();
  expect(report.external.filter((u) => !SEARCH_HOSTS.test(u)), 'the network gate saw nothing else leave').toEqual([]);
  expect(report.recording).toBe(true);
});

test('Search on a reference that has a DOI goes to doi.org for that paper', async ({ context, openViewer, server, netgate }, testInfo) => {
  const outside = await watchOutside(context, server.origin);
  const page = await openPaper(openViewer, server, PLOS);
  const citation = await selectPassage(page, PLOS, { from: 'Citation: Piwowar', to: 'journal.pone.0000308' });
  expect(citation.text).toContain(PLOS_DOI);
  await rightClickSelection(page, citation);
  await expect(markMenu(page)).toBeVisible({ timeout: 3000 });
  const [tab] = await Promise.all([context.waitForEvent('page', { timeout: 10_000 }), menuRow(page, /search/i).click()]);
  await tab.waitForLoadState('domcontentloaded').catch(() => undefined);
  await expect.poll(() => tab.url()).toMatch(/^https:\/\//);
  const url = new URL(tab.url());
  await shot(tab, testInfo, 'doi-tab');
  expect(url.host, 'a selection that holds a DOI goes to the paper itself on doi.org').toMatch(/^(dx\.)?doi\.org$/);
  expect(decodeURIComponent(url.pathname), 'the address is the DOI').toContain(PLOS_DOI);
  expect(new Set(outside.map((u) => new URL(u).host)).size, 'one host').toBe(1);

  // the DOI alone, too
  await page.bringToFront();
  const alone = await selectPassage(page, PLOS, PLOS_DOI_PASSAGE);
  await rightClickSelection(page, alone);
  const [second] = await Promise.all([context.waitForEvent('page', { timeout: 10_000 }), menuRow(page, /search/i).click()]);
  await expect.poll(() => second.url()).toMatch(/^https:\/\//);
  expect(decodeURIComponent(new URL(second.url()).pathname)).toContain(PLOS_DOI);
  const report = await netgate.report();
  expect(report.external.filter((u) => !SEARCH_HOSTS.test(u))).toEqual([]);
});

test('Search on a reference that has an arXiv id goes to arxiv.org for that paper', async ({ context, openViewer, server, netgate }, testInfo) => {
  await watchOutside(context, server.origin);
  const page = await openPaper(openViewer, server, RESNET_REFS);
  const sel = await selectPassage(page, RESNET_REFS, ARXIV_PASSAGE);
  await rightClickSelection(page, sel);
  await expect(markMenu(page)).toBeVisible({ timeout: 3000 });
  const [tab] = await Promise.all([context.waitForEvent('page', { timeout: 10_000 }), menuRow(page, /search/i).click()]);
  await expect.poll(() => tab.url()).toMatch(/^https:\/\//);
  const url = new URL(tab.url());
  await shot(tab, testInfo, 'arxiv-tab');
  expect(url.host, 'a selection that holds an arXiv id goes to the paper itself on arXiv').toBe('arxiv.org');
  expect(tab.url()).toContain('1409.0575');
  const report = await netgate.report();
  expect(report.external.filter((u) => !SEARCH_HOSTS.test(u))).toEqual([]);
});

test('marking up, commenting and replying send nothing anywhere: Search is the only thing that talks to the web, and only when pressed', async ({ context, openViewer, server, netgate }, testInfo) => {
  const outside = await watchOutside(context, server.origin);
  const page = await openPaper(openViewer, server, ATTENTION);
  const a = await selectPassage(page, ATTENTION, LINES.l1);
  await page.keyboard.press('h');
  await selectPassage(page, ATTENTION, LINES.l3);
  await page.keyboard.press('Control+u');
  await selectPassage(page, ATTENTION, LINES.l5);
  await page.keyboard.press('Control+b');
  await postNote(page, ATTENTION, LINES.l7, 'A note that stays on this computer');
  await replyBox(page).click();
  await page.keyboard.type('and a reply that does too', { delay: 5 });
  await page.keyboard.press('Enter');
  await rightClickSelection(page, a);
  await expect(markMenu(page)).toBeVisible({ timeout: 3000 });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1500);
  await shot(page, testInfo, 'a-whole-session');
  expect(await allCards(page).count()).toBe(1);
  expect(outside, 'no request left the browser for anything but the fixture server').toEqual([]);
  const report = await netgate.report();
  expect(report.external, 'and the network gate agrees').toEqual([]);
  expect(report.recording).toBe(true);
});

// User tests for Task 22: a screen reader reads the page text, once, in reading order. The page is drawn on a canvas,
// so the text layer is the only thing a screen reader can read; it must not be hidden, must not repeat the text, and must
// keep PDFium's reading order (left column, then right).
// Spec: "Accessibility: WCAG 2.2 AA for the interface; the text layer is readable by screen readers"; interface file:
// "the layer is not aria-hidden".
import type { Page } from '@playwright/test';
import { expect, test } from '../support/test';
import { squash } from '../support/tl-copy.spec-blind';
import { fixture, openFixture, pageText, truthOf } from '../support/tl-blind.spec-blind';

test.setTimeout(120_000);

/** What a screen reader gets, from the browser's accessibility tree: the text of every node it would read, in tree order. */
async function readAloud(page: Page): Promise<{ text: string; roles: string[] }> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Accessibility.enable');
  const { nodes } = (await cdp.send('Accessibility.getFullAXTree')) as {
    nodes: { nodeId: string; ignored?: boolean; role?: { value: string }; name?: { value?: string }; childIds?: string[] }[];
  };
  await cdp.detach();
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const spoken: string[] = [];
  const roles: string[] = [];
  const walk = (id: string, inside: boolean) => {
    const n = byId.get(id);
    if (!n) return;
    const role = n.role?.value ?? '';
    const isDocument = role === 'document' && (n.name?.value ?? '').length > 0;
    const within = inside || isDocument;
    if (within && !n.ignored) {
      roles.push(role);
      if (role === 'StaticText' && n.name?.value) spoken.push(n.name.value);
    }
    for (const child of n.childIds ?? []) walk(child, within);
  };
  walk(nodes[0].nodeId, false);
  return { text: spoken.join('\n'), roles };
}

/**
 * The text in Playwright's accessibility snapshot of the page list. The snapshot writes text either as its own `- text: ...`
 * entry or inline after a role (`- document "name": ...`), so both forms are read.
 */
async function snapshotText(page: Page): Promise<string> {
  const yaml = await page.locator('[role=document]').ariaSnapshot();
  const parts: string[] = [];
  for (const line of yaml.split('\n')) {
    const m = /^\s*- (?:text: ?|[A-Za-z]+(?: "(?:[^"\\]|\\.)*")?(?: \[[^\]]+\])*: )(.*)$/u.exec(line);
    if (!m) continue;
    let t = m[1].trim();
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) t = t.slice(1, -1);
    if (t !== '') parts.push(t);
  }
  return parts.join('\n');
}

const SINGLE_PAGE = ['two-column', 'ligatures', 'maths', 'rotated-table', 'rtl', 'rotated-page'];

test('the accessibility tree holds the page text once, in PDFium reading order', async ({ openViewer, server }, testInfo) => {
  const problems: string[] = [];
  for (const name of SINGLE_PAGE) {
    const o = await openFixture(openViewer, server, fixture(name));
    const engine = squash(await pageText(o.page, o.pageIndex));
    const tree = await readAloud(o.page);
    const read = squash(tree.text);
    if (read !== engine) {
      let i = 0;
      while (i < read.length && i < engine.length && read[i] === engine[i]) i++;
      problems.push(`${name}: the accessibility tree reads ${read.length} letters, the engine's page text is ${engine.length}; first difference at ${i}: tree "${read.slice(Math.max(0, i - 20), i + 20)}" vs engine "${engine.slice(Math.max(0, i - 20), i + 20)}"`);
    }
    if (name === 'two-column') {
      await testInfo.attach('two-column-accessibility-tree.txt', { body: tree.text, contentType: 'text/plain' });
      // Reading order of the two columns: the first words of the right column come after the last words of the left.
      const truth = truthOf(fixture(name))!;
      expect(squash(tree.text), 'a screen reader reads the paragraphs in the order they are written').toBe(squash(truth));
    }
    expect(tree.roles, `${name}: the page render (a canvas) is not read as an image`).not.toContain('image');
    if (name === 'two-column') {
      // Not hidden by attribute or style: no text span sits in aria-hidden / hidden / inert, or is display:none / visibility:hidden.
      const hidden = await o.page.evaluate(() => {
        const spans = [...document.querySelectorAll('[data-page-index="0"] [data-start]')];
        const bad = spans.filter((s) => s.closest('[aria-hidden="true"], [hidden], [inert]') !== null);
        const invisible = spans.filter((s) => getComputedStyle(s).display === 'none' || getComputedStyle(s).visibility !== 'visible');
        return { spans: spans.length, hiddenByAttribute: bad.length, invisible: invisible.length };
      });
      if (hidden.spans < 20) problems.push(`two-column: only ${hidden.spans} text spans have data-start`);
      if (hidden.hiddenByAttribute > 0) problems.push(`two-column: ${hidden.hiddenByAttribute} text spans sit inside aria-hidden, hidden or inert`);
      if (hidden.invisible > 0) problems.push(`two-column: ${hidden.invisible} text spans are display:none or visibility:hidden`);
    }
    await o.page.close();
  }
  expect(problems).toEqual([]);
});

test("Playwright's accessibility snapshot of the page list holds the page text in order", async ({ openViewer, server }, testInfo) => {
  const o = await openFixture(openViewer, server, fixture('two-column'));
  const snapshot = await snapshotText(o.page);
  await testInfo.attach('two-column-aria-snapshot.txt', { body: await o.page.locator('[role=document]').ariaSnapshot(), contentType: 'text/plain' });
  expect(snapshot.length, 'the snapshot has text entries').toBeGreaterThan(0);
  expect(squash(snapshot)).toBe(squash(await pageText(o.page, o.pageIndex)));
  expect(o.errors).toEqual([]);
});

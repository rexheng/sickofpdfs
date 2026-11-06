// Regression walkthrough, R103 (safety and privacy): a page the owner saves on purpose must never put active content or
// session keys into the PDF that sits in the library and in backups.
//
// The owner's steps: save a hostile page (headings with ( ) \ and curly quotes, links that try to close the PDF's syntax, a
// mailto: that does the same) from the toolbar menu, then save a blog whose address carries a sign-in key. The saved PDFs are
// read back from the extension's file store and their objects are checked: only plain web links, no JavaScript, Launch or other
// action, whole outline titles with their curly quotes, and a source link with no key in it.
//
// The menu is opened as `popup.html?tab=<id>` (the test build's hook): Playwright cannot click the toolbar button.
import { createRequire } from 'node:module';
import type { BrowserContext, Page, Worker } from '@playwright/test';
import { EXTENSION_ID, expect, hooks, test, VIEWER_ROOT } from '../support/test';

const require = createRequire(new URL('../../apps/extension/package.json', import.meta.url));
const { PDFDict, PDFDocument, PDFHexString, PDFName, PDFString } = require('pdf-lib') as typeof import('pdf-lib');

test.setTimeout(240_000);
test.use({ viewport: { width: 1280, height: 900 } });

const PARA = (n: number) => `<p>Paragraph ${n}. ${'Reading research papers takes practice, and a method helps a great deal with it. '.repeat(4)}</p>`;
const HOSTILE = `<!doctype html><html lang="en)/S/JavaScript/JS(app.alert(1)"><head><meta charset="utf-8"><title>Don’t panic (part 1 — a guide</title></head><body>
<article><h1>Don’t panic (part 1 — a guide</h1><p>By Sam Example</p>${PARA(1)}
<h2>1) Setup — what you’ll need</h2>${PARA(2)}
<p>See <a href="https://example.com/a)/S/JavaScript/JS(app.alert(1)">this link</a> and <a href="mailto:x@y.z)>>/S/Launch/F(calc.exe)>>endobj">mail me</a> and <a href="javascript:alert(1)">js</a>.</p>
<h2>Paths like C:\\Users\\me) and \\(escapes\\)</h2>${PARA(3)}
<h2>&lt;img src=x onerror=alert(1)&gt; &lt;/p&gt;&lt;script&gt;alert(2)&lt;/script&gt;</h2>${PARA(4)}${PARA(5)}${PARA(6)}</article></body></html>`;

async function tabOf(context: BrowserContext, sw: Worker, url: string): Promise<number> {
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForLoadState('load');
  const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id ?? -1, page.url());
  expect(tabId, 'the page tab is found').toBeGreaterThan(0);
  return tabId;
}

async function save(context: BrowserContext, tabId: number): Promise<{ viewer: Page; id: string }> {
  const menu = await context.newPage();
  await menu.setViewportSize({ width: 320, height: 260 });
  await menu.goto(`chrome-extension://${EXTENSION_ID}/popup.html?tab=${tabId}`);
  const opened = context.waitForEvent('page', { timeout: 30_000 });
  await menu.getByRole('menuitem', { name: 'Save this page to library' }).click();
  const viewer = await opened;
  await viewer.waitForURL(/viewer\.html/u, { timeout: 60_000 });
  await viewer.waitForSelector(VIEWER_ROOT, { state: 'attached' });
  await expect.poll(() => hooks(viewer).eval((h) => h.save?.state().kind ?? null), { timeout: 40_000 }).toBe('saved');
  return { viewer, id: (await hooks(viewer).eval((h) => h.save.documentId())) as string };
}

/** The saved PDF's bytes, from the extension's file store. */
async function pdfBytes(viewer: Page, id: string): Promise<Buffer> {
  const b64 = await viewer.evaluate(async (docId) => {
    const walk = async (d: FileSystemDirectoryHandle): Promise<string | null> => {
      for await (const [n, hd] of d.entries()) {
        if (hd.kind === 'directory') {
          const r = await walk(hd);
          if (r !== null) return r;
        } else if (n.startsWith(docId)) {
          const b = new Uint8Array(await (await (hd).getFile()).arrayBuffer());
          let s = '';
          for (const x of b) s += String.fromCharCode(x);
          return btoa(s);
        }
      }
      return null;
    };
    return walk(await navigator.storage.getDirectory());
  }, id);
  expect(b64, 'the PDF is in the file store').not.toBeNull();
  return Buffer.from(b64!, 'base64');
}

const text = (o: unknown): string => (o instanceof PDFHexString || o instanceof PDFString ? o.decodeText() : '');

/** Every object of the PDF, read back with pdf-lib. */
async function inspect(bytes: Buffer) {
  const doc = await PDFDocument.load(bytes, { throwOnInvalidObject: false, updateMetadata: false });
  const ctx = doc.context;
  const actions: { type: string; uri: string | null; keys: string[] }[] = [];
  const titles: string[] = [];
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue;
    const a = obj.get(PDFName.of('A'));
    if (a !== undefined) {
      const act = ctx.lookup(a);
      if (act instanceof PDFDict) {
        const uri = act.get(PDFName.of('URI'));
        actions.push({ type: String(act.get(PDFName.of('S'))), uri: uri === undefined ? null : text(uri), keys: act.keys().map(String) });
      }
    }
    if (obj.get(PDFName.of('Title')) !== undefined && obj.get(PDFName.of('Parent')) !== undefined) titles.push(text(obj.get(PDFName.of('Title'))));
  }
  const info = ctx.lookup(ctx.trailerInfo.Info);
  const subject = info instanceof PDFDict ? text(info.get(PDFName.of('Subject'))) : '';
  const lang = text(doc.catalog.get(PDFName.of('Lang')));
  const openAction = doc.catalog.get(PDFName.of('OpenAction'));
  const names = doc.catalog.get(PDFName.of('Names'));
  const aa = doc.catalog.get(PDFName.of('AA'));
  return { actions, titles, subject, lang, extras: { openAction: openAction !== undefined, names: names !== undefined, aa: aa !== undefined } };
}

test('a hostile page is saved: only plain links, whole outline titles, no key in the source link', async ({ context, sw, server }) => {
  server.mount('/x/', (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HOSTILE);
    return Promise.resolve();
  });
  const hostile = await save(context, await tabOf(context, sw, server.url('/x/hostile')));
  const bytes = await pdfBytes(hostile.viewer, hostile.id);
  const raw = bytes.toString('latin1');
  const h = await inspect(bytes);

  // Only plain links: every action is a URI action with exactly its three keys. No JavaScript, Launch, SubmitForm, GoToR...
  expect(raw).not.toMatch(/\/S\s*\/(JavaScript|Launch|SubmitForm|ImportData|GoToR|GoToE|Named|Thread|Rendition)/u);
  expect(raw).not.toMatch(/\/JS\b|\/OpenAction|\/AA\b|\/Launch|\/EmbeddedFile/u);
  expect(h.actions.length, 'the page has links').toBeGreaterThan(0);
  for (const a of h.actions) {
    expect(a.type).toBe('/URI');
    expect([...a.keys].sort()).toEqual(['/S', '/Type', '/URI']);
    expect(a.uri).toMatch(/^(https?:\/\/|mailto:)[\x21-\x7e]+$/u);
  }
  expect(h.extras).toEqual({ openAction: false, names: false, aa: false });
  expect(h.lang).toBe('en');

  // Every heading is its own whole outline entry, with its characters as written.
  expect(h.titles).toEqual([
    'Don’t panic (part 1 — a guide',
    '1) Setup — what you’ll need',
    'Paths like C:\\Users\\me) and \\(escapes\\)',
    '<img src=x onerror=alert(1)> </p><script>alert(2)</script>',
  ]);
});

test('a saved blog keeps its curly quotes in the outline and no sign-in key in its source link', async ({ context, sw, server }) => {
  const blog = await save(context, await tabOf(context, sw, server.url('/a/blog-code?access_token=SECRET123&utm_source=newsletter')));
  const bytes = await pdfBytes(blog.viewer, blog.id);
  const h = await inspect(bytes);
  expect(h.titles).toContain('3. Decide what “missing” means');
  expect(h.titles).toContain('Cleaning messy CSV files with pandas — Notes from the lab');

  // The PDF's links, its subject and the library's row all hold the same cleaned link.
  expect(bytes.toString('latin1')).not.toMatch(/SECRET123|access_token|utm_source/u);
  expect(h.subject).not.toMatch(/SECRET123|access_token|utm_source/u);
  const from = h.actions.find((a) => a.uri?.includes('/a/blog-code'));
  expect(from?.uri, 'the "From …" link is there').toBe(h.subject);
  const found = await hooks(blog.viewer).eval((hk, link) => hk.store!.documentAtLink(link), server.url('/a/blog-code'));
  expect(found, 'the library holds the page under the cleaned link').toBe(blog.id);
});

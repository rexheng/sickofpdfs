// Gate 1, the library store (Task 28), as the owner meets it. Written from the spec and the interface file only.
//
//   spec, Release 1 criterion 3: "Reopening the same link, or the same file after it is moved, renamed or copied, shows the same notes."
//   spec, walkthrough 9: "Same contents, same fingerprint, same notes ... The library records the new location."
//   spec, Storage: the library is SQLite in the extension's private file storage, "owned by one hidden background page that Chrome recreates
//     on demand"; "a broadcast channel tells every open tab when something changes".
//   spec, Local traces: "A PDF that isn't saved leaves no history row, thumbnail, search entry or log line."
//   spec, Incognito: "the extension only views PDFs: no marks, notes or saving".
//   interface file (Task 28): the viewer connects to the store after the document is ready and publishes it as `store` (null in Incognito);
//     ensureOffscreen: "getContexts check + createDocument ... one shared promise", re-checked when createDocument fails (two callers race).
//
// The fixture server serves the same one-page PDF at several addresses (/h/plain.pdf, /h/octet.pdf, /h/attachment.pdf), so "the same file
// from another link" is the same bytes. What the test calls "save" is the store's own saveDocument, with what the viewer knows about the file:
// the save flow itself is Task 30's.
//
// GUESSES (the spec names no screen text): the hidden library page is the extension's only OFFSCREEN_DOCUMENT context; a store call made
// after Chrome closes it is answered within the client's reconnect (3 s) plus start-up time.
import { rm } from 'node:fs/promises';
import { launchExtension, waitForExtensionWorker } from './support/launch';
import { expect, hooks, test } from './support/test';
import { ZERO_STATS, connectTogether, inputFor, libraryFileSizes, offscreenCount, openViewerIn, scanOpfs, store, waitForStore } from './support/store-probe.spec-blind';

const PLAIN = '/h/plain.pdf';
const OTHER_LINKS = ['/h/octet.pdf', '/h/attachment.pdf'];

test('The library store: it survives a restart, one PDF in two tabs is one document, one hidden page serves every tab, and none opens in Incognito', async ({ step, profiles }, testInfo) => {
  test.setTimeout(360_000);
  await step('closing Chrome and opening it again: the saved PDF is still in the library, and the same file from another link is the same document', async ({ server }) => {
    const userDataDir = await profiles.copy('seeded');
    const first = server.url(PLAIN);
    const second = server.url(OTHER_LINKS[0]);
    let context = await launchExtension({ userDataDir });
    try {
      await waitForExtensionWorker(context);
      let page = await openViewerIn(context, first);
      await waitForStore(page);
      const input = await inputFor(page, first);

      // Just opening a PDF saves nothing (spec, Local traces): no row anywhere, and its address is in no file.
      expect(await store(page).stats()).toEqual(ZERO_STATS);
      expect(await scanOpfs(page, server.origin.replace('http://', '')), 'the address of an unsaved PDF is written nowhere').toEqual([]);

      const saved = await store(page).saveDocument(input);
      expect(saved.created).toBe(true);
      expect(saved.row).toMatchObject({ id: input.id, pageCount: input.pageCount, byteSize: input.byteSize, title: input.title });
      expect((await libraryFileSizes(page)).some((n) => n > 0), 'the library lives in the extension\'s private files (.sop-db)').toBe(true);
      await page.screenshot({ path: testInfo.outputPath('store-1-saved.png') });

      await context.close(); // the owner closes Chrome

      context = await launchExtension({ userDataDir });
      await waitForExtensionWorker(context);
      page = await openViewerIn(context, second); // the same file, from another link
      await waitForStore(page);
      const again = await inputFor(page, second);
      expect(again.id, 'same bytes, same fingerprint').toBe(input.id);

      expect(await store(page).call('resolveFingerprint', again.id)).toBe(input.id);
      expect(await store(page).getDocument(input.id)).toMatchObject({ id: input.id, title: input.title, createdAt: saved.row.createdAt });
      // Triage (t30-triage T4): since Task 30, opening a saved PDF from a new link records that place (walkthrough 9), so it is 2 here.
      await expect.poll(() => store(page).stats()).toMatchObject({ documents: 1, locations: 2 });

      const reopened = await store(page).saveDocument(again);
      expect(reopened.created, 'it is not a new document').toBe(false);
      const places = await store(page).listLocations(input.id);
      expect(places.map((p) => new URL(p.raw).pathname).sort(), 'the library records the new place').toEqual([PLAIN, OTHER_LINKS[0]].sort());
      expect(await store(page).stats()).toMatchObject({ documents: 1, locations: 2 });
      await page.screenshot({ path: testInfo.outputPath('store-2-after-restart.png') });
    } finally {
      await context.close().catch(() => undefined);
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }, 120_000);
  await step('the same PDF in two tabs, opened from two links, is one document: one tab hears about the other\'s save, and the second link becomes a second place', async ({ openViewer, server }) => {
    const a = await openViewer(server.url(PLAIN));
    const b = await openViewer(server.url(OTHER_LINKS[0]));
    await Promise.all([waitForStore(a), waitForStore(b)]);
    const inA = await inputFor(a, server.url(PLAIN));
    const inB = await inputFor(b, server.url(OTHER_LINKS[0]));
    expect(inB.id, 'the same file has the same fingerprint in both tabs').toBe(inA.id);

    await hooks(a).eval((h) => {
      const g = globalThis as unknown as { __heard: unknown[] };
      g.__heard = [];
      (h as unknown as { store: { onChange(cb: (c: unknown) => void): () => void } }).store.onChange((c) => g.__heard.push(c));
    });

    const savedByB = await store(b).saveDocument(inB);
    expect(savedByB.created).toBe(true);
    await expect
      .poll(() => hooks(a).eval(() => (globalThis as unknown as { __heard: unknown[] }).__heard), { message: 'tab A is told that tab B saved the document', timeout: 5000 })
      .toContainEqual(expect.objectContaining({ table: 'documents', op: 'upsert', ids: [inA.id] }));

    expect(await store(a).call('resolveFingerprint', inA.id)).toBe(inA.id);
    const savedByA = await store(a).saveDocument(inA);
    expect(savedByA.created, 'tab A finds the document tab B saved').toBe(false);
    expect(savedByA.row.createdAt).toBe(savedByB.row.createdAt);
    expect((await store(a).listLocations(inA.id)).map((p) => new URL(p.raw).pathname).sort()).toEqual([PLAIN, OTHER_LINKS[0]].sort());
    expect(await store(b).stats(), 'both tabs read the same library').toMatchObject({ documents: 1, locations: 2 });
    await a.screenshot({ path: testInfo.outputPath('store-3-two-tabs.png') });

    await a.reload();
    await waitForStore(a);
    expect(await store(a).getDocument(inA.id), 'after a reload it is the same document').toMatchObject({ id: inA.id, createdAt: savedByB.row.createdAt });
  }, 60_000);
  await step('the hidden library page: three viewers opening together get one, and after Chrome closes it, four connections at once bring back exactly one with everything saved', async ({ openViewer, server, sw }) => {
    expect(await offscreenCount(sw), 'a fresh browser has no hidden page yet').toBe(0);
    const links = [PLAIN, ...OTHER_LINKS].map((p) => server.url(p));

    // three viewers open in the same moment
    const pages = await Promise.all(links.map((link) => openViewer(link)));
    await Promise.all(pages.map((p) => waitForStore(p)));
    expect(await offscreenCount(sw), 'two callers must not each create a hidden page').toBe(1);
    // Schema v6 (Phase 4 slice D, 6 Nov) adds @Claude's passage vectors, so the newest version is 6 (v5 was R92's tags, v4 ruling N5's forgotten list).
    for (const page of pages) expect(await store(page).call<number>('schemaVersion')).toBe(6);
    const page = pages[0];
    const input = await inputFor(page, links[0]);
    await store(page).saveDocument(input);
    for (const other of pages) expect(await store(other).stats(), 'all three read the same library').toMatchObject({ documents: 1 });

    // Chrome closes the hidden page; four tabs ask for the library at the very same moment
    await sw.evaluate(() => chrome.offscreen.closeDocument());
    expect(await offscreenCount(sw)).toBe(0);
    const answers = await connectTogether(page, 4);
    expect(answers).toHaveLength(4);
    for (const answer of answers) expect(answer).toMatchObject({ id: 1, ok: true, value: 6 }); // schemaVersion, 6 since Phase 4's passage vectors
    expect(await offscreenCount(sw), 'one hidden page came back, not four (and not an error from a second createDocument)').toBe(1);

    // the tab's own connection was to the page that is gone: it notices, reconnects and asks again
    expect(await store(page).getDocument(input.id)).toMatchObject({ id: input.id, title: input.title });
    expect(await store(page).stats()).toMatchObject({ documents: 1, locations: 1 });
  }, 120_000);
  await step('in an Incognito window the viewer shows the PDF but never opens the library: store is null and no hidden page is made', async ({ context, openViewer, server, sw }) => {
    // The page's own answer to "am I in Incognito" (interface file: chrome.extension.inIncognitoContext) is switched on before any page loads.
    await context.addInitScript(() => {
      Object.defineProperty(chrome.extension, 'inIncognitoContext', { get: () => true, configurable: true });
    });
    const page = await openViewer(server.url(PLAIN));
    await expect.poll(() => hooks(page).eval((h) => (h as unknown as { viewerState(): string }).viewerState()), { message: 'the PDF opens', timeout: 20_000 }).toBe('ready');
    await page.waitForTimeout(1500); // time enough for a viewer that does connect to do so
    await page.screenshot({ path: testInfo.outputPath('store-5-incognito.png') });

    expect(await hooks(page).eval((h) => 'store' in h && (h as unknown as { store: unknown }).store === null), 'runtime.store is published as null').toBe(true);
    expect(await offscreenCount(sw), 'a view-only viewer does not wake the library').toBe(0);
  }, 60_000);
});

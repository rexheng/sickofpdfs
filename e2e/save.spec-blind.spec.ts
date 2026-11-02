// Gate 1, the save decision (Task 30), as the owner meets it. Written from the spec and the interface file only.
//
//   spec, walkthrough 1: "A chip in the top bar reads 'Saved to library' (reasons on hover) ... If you have read it before, it opens where
//     you stopped."
//   spec, walkthrough 9: "You move, rename or re-download a file. Same contents, same fingerprint, same notes. Re-downloads that differ only
//     by a download stamp ... are recognised by their text. The library records the new location."
//   spec, Identity rule 2: "the new fingerprint becomes an alias: same notes, nothing copied."
//   spec, Local traces: "A PDF that isn't saved leaves no history row, thumbnail, search entry or log line."
//   spec, Learning filter, notes on a PDF that isn't saved: "Your first mark or note on a 'not sure' PDF saves it to the library, with an
//     Undo chip."; "When the filter is wrong: The chip in the top bar always shows the decision; click it, or press Ctrl+Alt+S, to save."
//   spec, Library: "In an Incognito window the extension only views PDFs: no marks, notes or saving."
//   spec, Shortcuts: "Save to library: Ctrl+Alt+S".
//   interface file (Tasks 30+31): the chip table (labels "Saved to library", "Not sure: Save?", "Incognito: view only", an "Undo" text button
//     "for 10 s", tooltip "Already in your library"); the stand-in filter says 'unsure' for every PDF ("No filter yet: your first mark
//     saves it"); `save.firstMark()` on the test hooks is what the mark flow will call; Undo = `forgetDocument` + `blobs.delete`, "Nothing
//     about the PDF is left"; "touchLocation and recordOpen have exactly one call site: SaveController.start()", "when identity resolves
//     to a known document"; `blobStore` is null in Incognito; stored copies live in `pdf/<2 hex>/<sha256>.pdf` (Task 29).
//
// GUESSES (the spec names no markup; written down in task-30-tests-report.md): the chip is a button inside the page's <header>, found by
// its words; "Undo" is a button in the same header; with the stand-in filter every ordinary PDF opens as "Not sure: Save?"; one history
// row per document, however often it is opened; the tooltip appears on hover.
import { forceVerdict } from './support/filter-verdict';
import { ensureSamplePdf } from './support/sample-pdf.spec-blind';
import { opfsFilesContaining, blobPathOf, CHIP, headerButton, listOpfs, opfsSha256, save, waitDecided } from './support/save-probe.spec-blind';
import { makeStampedPdf } from './support/stamped-pdf';
import { offscreenCount, store, waitForStore, ZERO_STATS } from './support/store-probe.spec-blind';
import { expect, test, type FixtureServer } from './support/test';
import { rt, snap, waitReady } from './walkthroughs/support/viewer.spec-blind';

const SAMPLE = 't12-sample.pdf';
const SAMPLE_PATH = `/f/${SAMPLE}`;
const SAMPLE_WORDS = 'sickofpdfs task 12 sample';
const hostPort = (server: FixtureServer) => server.origin.replace('http://', '');
const pathsOf = (places: { raw: string }[]) => places.map((p) => new URL(p.raw).pathname).sort();

type OpenViewer = (source: string, opts?: { back?: string; page?: number }) => Promise<import('@playwright/test').Page>;

/** Opens the viewer on `url` and waits until the PDF is shown, the library is connected and the save decision has settled. */
async function openDecided(openViewer: OpenViewer, url: string) {
  const page = await openViewer(url);
  await waitReady(page);
  await waitForStore(page);
  const state = await waitDecided(page);
  return { page, state };
}

test.beforeAll(async () => {
  await ensureSamplePdf(SAMPLE);
});

// Triage (S11, rule 7): these are about the save flow on a "not sure" PDF, written when the stand-in called every PDF that. The
// real filter calls the one-page sample "not learning", so the test build's verdict switch makes these PDFs "not sure" again.
test.beforeEach(async ({ context }) => forceVerdict(context, 'unsure'));

test('reading a new PDF writes nothing; Ctrl+Alt+S then saves it, and the chip, the rows and the stored copy all say so', async ({ openViewer, server }, testInfo) => {
  const url = server.url(SAMPLE_PATH);
  const { page, state } = await openDecided(openViewer, url);
  const doc = (await rt(page).doc())!;

  await test.step('opening and reading: the chip asks, and nothing is written anywhere', async () => {
    expect(state.kind, 'with no filter yet, every PDF is "not sure"').toBe('unsure');
    await expect(headerButton(page, CHIP.unsure)).toBeVisible();
    for (const index of [2, 0, 1]) await rt(page).scrollToPage(index);
    await page.waitForTimeout(1200); // time enough for anything that would write on its own
    await snap(page, testInfo, '1-reading-unsaved');

    expect(await store(page).stats(), 'not one row: no document, place, history, page text or queue entry').toEqual(ZERO_STATS);
    expect(await listOpfs(page, 'pdf'), 'no stored copy').toEqual([]);
    expect(await listOpfs(page, 'tmp'), 'no half-written copy').toEqual([]);
    expect(await opfsFilesContaining(page, hostPort(server)), 'the address of an unsaved PDF is written nowhere').toEqual([]);
    expect(await opfsFilesContaining(page, SAMPLE_WORDS), 'neither its words').toEqual([]);
    expect(await save(page).documentId()).toBeNull();
    expect(await save(page).blobStore(), 'the copy store is there, ready, and empty').toBe('present');
  });

  await test.step('the chip explains itself on hover', async () => {
    await headerButton(page, CHIP.unsure).hover();
    // Triage (S11): "No filter yet" never shows (R73); the hover says why to save.
    await expect.soft(page.getByText(/this pdf isn.t in your library yet/i).first()).toBeVisible({ timeout: 5000 });
    await page.mouse.move(600, 400);
  });

  await test.step('Ctrl+Alt+S saves it', async () => {
    await page.keyboard.press('Control+Alt+s');

    await expect(headerButton(page, CHIP.saved)).toBeVisible();
    await expect(headerButton(page, CHIP.unsure)).toHaveCount(0);
    await expect(headerButton(page, /Undo/), 'a save you asked for has no Undo').toHaveCount(0);
    await snap(page, testInfo, '2-saved');

    expect(await save(page).state()).toMatchObject({ kind: 'saved', documentId: doc.sha256, undoable: false });
    expect(await save(page).documentId()).toBe(doc.sha256);
    expect(await store(page).stats()).toMatchObject({ documents: 1, locations: 1, history: 1, pageText: doc.pageCount, aliases: 0 });
    expect(await store(page).getDocument(doc.sha256)).toMatchObject({ id: doc.sha256, pageCount: doc.pageCount, byteSize: doc.size });
    expect(pathsOf(await store(page).listLocations(doc.sha256))).toEqual([SAMPLE_PATH]);

    // the stored copy is the very file that was read
    expect(await listOpfs(page, 'pdf')).toEqual([{ path: blobPathOf(doc.sha256), size: doc.size }]);
    expect(await opfsSha256(page, blobPathOf(doc.sha256))).toBe(doc.sha256);
    expect(await save(page).hasBlob(doc.sha256)).toBe(true);
    expect(await listOpfs(page, 'tmp'), 'no half-written copy is left behind').toEqual([]);

    // and its pages are in the library's search
    const hits = await store(page).call<{ documentId: string; pageIndex: number }[]>('searchPages', 'sample', 10);
    expect(hits.map((h) => h.pageIndex).sort()).toEqual([0, 1, 2]);
  });
});

test('reopening a saved PDF, from the same link or another, shows it as saved with no question, and records the new place', async ({ openViewer, server }, testInfo) => {
  const { bytes } = await ensureSamplePdf(SAMPLE);
  const COPY_PATH = '/s/a-copy-of-the-sample.pdf'; // the same bytes at another address: a PDF that was moved or renamed
  server.serveSequence(COPY_PATH, [bytes]);

  const first = await openDecided(openViewer, server.url(SAMPLE_PATH));
  const doc = (await rt(first.page).doc())!;
  await first.page.keyboard.press('Control+Alt+s');
  await expect(headerButton(first.page, CHIP.saved)).toBeVisible();

  const second = await openDecided(openViewer, server.url(COPY_PATH));
  await snap(second.page, testInfo, '3-reopened-from-another-link');

  expect((await rt(second.page).doc())!.sha256, 'same bytes, same fingerprint').toBe(doc.sha256);
  expect(second.state).toMatchObject({ kind: 'saved', documentId: doc.sha256, undoable: false });
  await expect(headerButton(second.page, CHIP.saved)).toBeVisible();
  await expect(headerButton(second.page, CHIP.unsure), 'it is not asked about again').toHaveCount(0);
  await expect(headerButton(second.page, /Undo/)).toHaveCount(0);
  expect(await store(second.page).stats(), 'one document, one history row, two places, one stored copy').toMatchObject({ documents: 1, history: 1, locations: 2, pageText: doc.pageCount });
  expect(pathsOf(await store(second.page).listLocations(doc.sha256))).toEqual([COPY_PATH, SAMPLE_PATH].sort());
  expect((await listOpfs(second.page, 'pdf')).map((f) => f.path)).toEqual([blobPathOf(doc.sha256)]);

  await headerButton(second.page, CHIP.saved).hover();
  await expect.soft(second.page.getByText('Already in your library').first(), 'the tooltip of a PDF found in the library').toBeVisible({ timeout: 5000 });

  // the first tab, reloaded, also finds it
  await first.page.reload();
  await waitReady(first.page);
  expect(await waitDecided(first.page)).toMatchObject({ kind: 'saved', documentId: doc.sha256 });
  await expect(headerButton(first.page, CHIP.saved)).toBeVisible();
  expect((await listOpfs(first.page, 'pdf')).length, 'still one stored copy').toBe(1);
  expect(await store(first.page).stats()).toMatchObject({ documents: 1, history: 1, locations: 2 });
});

test('Undo after the first mark leaves nothing: no row, no stored copy, no trace; the Undo runs out after 10 seconds and then the PDF stays', async ({ openViewer, server }, testInfo) => {
  test.setTimeout(120_000);
  const { page } = await openDecided(openViewer, server.url(SAMPLE_PATH));
  const doc = (await rt(page).doc())!;

  await test.step('the first mark on a "not sure" PDF saves it, with an Undo', async () => {
    await save(page).firstMark();
    await expect(headerButton(page, CHIP.saved)).toBeVisible();
    await expect(headerButton(page, 'Undo')).toBeVisible();
    await snap(page, testInfo, '4-saved-with-undo');
    expect(await save(page).state()).toMatchObject({ kind: 'saved', documentId: doc.sha256, undoable: true });
    expect(await store(page).stats()).toMatchObject({ documents: 1, locations: 1, history: 1, pageText: doc.pageCount });
    expect((await listOpfs(page, 'pdf')).map((f) => f.path)).toEqual([blobPathOf(doc.sha256)]);
    // control: the file search can see the library, so the empty answer below means something
    expect((await opfsFilesContaining(page, hostPort(server))).length, 'control: the address is in the library file').toBeGreaterThan(0);
    expect((await opfsFilesContaining(page, SAMPLE_WORDS)).length, 'control: the words are in the stored copy and the page text').toBeGreaterThan(0);
  });

  await test.step('Undo forgets it completely', async () => {
    await headerButton(page, 'Undo').click();

    await expect(headerButton(page, CHIP.saved)).toHaveCount(0);
    await expect(headerButton(page, 'Undo')).toHaveCount(0);
    await snap(page, testInfo, '5-after-undo');
    await expect.poll(() => store(page).stats(), { message: 'every row is gone, the queue for sync too' }).toEqual(ZERO_STATS);
    expect(await store(page).getDocument(doc.sha256)).toBeNull();
    expect(await listOpfs(page, 'pdf'), 'no stored copy').toEqual([]);
    expect(await save(page).hasBlob(doc.sha256)).toBe(false);
    expect(await opfsFilesContaining(page, hostPort(server)), 'its address is in no file').toEqual([]);
    expect(await opfsFilesContaining(page, SAMPLE_WORDS), 'its words are in no file').toEqual([]);
    expect(await save(page).documentId()).toBeNull();
  });

  await test.step('Ctrl+Alt+S saves it again, as if for the first time', async () => {
    await page.keyboard.press('Control+Alt+s');
    await expect(headerButton(page, CHIP.saved)).toBeVisible();
    expect(await store(page).stats()).toMatchObject({ documents: 1, locations: 1, history: 1, pageText: doc.pageCount });
    expect((await listOpfs(page, 'pdf')).map((f) => f.path)).toEqual([blobPathOf(doc.sha256)]);
  });

  await test.step('after 10 seconds the Undo goes and the PDF stays', async () => {
    const other = await openDecided(openViewer, server.url('/h/plain.pdf'));
    const otherDoc = (await rt(other.page).doc())!;
    await save(other.page).firstMark();
    const undo = headerButton(other.page, 'Undo');
    await expect(undo).toBeVisible();
    const shown = Date.now();

    await expect(undo).toBeHidden({ timeout: 20_000 });

    const lasted = Date.now() - shown;
    expect(lasted, `the Undo lasted ${lasted} ms; the interface says 10 s`).toBeGreaterThan(8500);
    expect(lasted).toBeLessThan(14_000);
    await expect(headerButton(other.page, CHIP.saved)).toBeVisible();
    expect(await save(other.page).state()).toMatchObject({ kind: 'saved', documentId: otherDoc.sha256, undoable: false });
    expect((await listOpfs(other.page, 'pdf')).map((f) => f.path)).toContain(blobPathOf(otherDoc.sha256));
    expect(await store(other.page).getDocument(otherDoc.sha256)).toMatchObject({ id: otherDoc.sha256 });
    await snap(other.page, testInfo, '6-undo-expired');
  });
});

test('in an Incognito window the PDF is shown and nothing is ever saved: the chip says "view only", Ctrl+Alt+S does nothing, no file is written', async ({ context, openViewer, server, sw }, testInfo) => {
  await context.addInitScript(() => {
    try {
      Object.defineProperty(chrome.extension, 'inIncognitoContext', { get: () => true, configurable: true });
    } catch {
      // a page that is not an extension page has no chrome.extension; only the viewer matters
    }
  });
  const page = await openViewer(server.url(SAMPLE_PATH));
  await waitReady(page);
  await expect(headerButton(page, CHIP.incognito)).toBeVisible();
  await expect(headerButton(page, CHIP.incognito), 'the chip is not a button anyone can press').toBeDisabled();
  await snap(page, testInfo, '7-incognito');

  await page.keyboard.press('Control+Alt+s');
  await save(page).firstMark().catch(() => undefined); // what the first mark would call: it must do nothing
  await page.waitForTimeout(1500);

  await expect(headerButton(page, CHIP.incognito)).toBeVisible();
  await expect(headerButton(page, CHIP.saved)).toHaveCount(0);
  expect(await save(page).state()).toMatchObject({ kind: 'incognito' });
  expect(await save(page).documentId()).toBeNull();
  expect(await save(page).blobStore(), 'no copy store in Incognito').toBe('null');
  expect(await offscreenCount(sw), 'the library was never woken').toBe(0);
  expect(await listOpfs(sw, 'pdf'), 'no stored copy').toEqual([]);
  expect(await opfsFilesContaining(sw, hostPort(server)), 'nothing about this PDF in any file').toEqual([]);
  expect(await opfsFilesContaining(sw, SAMPLE_WORDS)).toEqual([]);
});

test('a re-download that differs only by its download stamp is the first copy: saved, same notes, and nothing copied; a different paper is not', async ({ openViewer, server }, testInfo) => {
  test.setTimeout(120_000);
  const FIRST = { ip: '203.0.113.7', date: 'Tue, 12 Mar 2019 10:11:12 UTC' };
  const AGAIN = { ip: '198.51.100.99', date: 'Fri, 03 Jan 2025 21:05:44 UTC' };
  server.serveSequence('/s/jstor-first.pdf', [await makeStampedPdf(FIRST)]);
  server.serveSequence('/s/jstor-again.pdf', [await makeStampedPdf(AGAIN)]);
  server.serveSequence('/s/jstor-other-paper.pdf', [await makeStampedPdf(AGAIN, 'other-body')]);

  const first = await openDecided(openViewer, server.url('/s/jstor-first.pdf'));
  const firstDoc = (await rt(first.page).doc())!;
  expect(first.state.kind).toBe('unsure');
  await first.page.keyboard.press('Control+Alt+s');
  await expect(headerButton(first.page, CHIP.saved)).toBeVisible();
  expect(await store(first.page).stats()).toMatchObject({ documents: 1, aliases: 0, pageText: 8 });

  const again = await openDecided(openViewer, server.url('/s/jstor-again.pdf'));
  const againDoc = (await rt(again.page).doc())!;
  await snap(again.page, testInfo, '8-stamped-re-download');
  expect(againDoc.sha256, 'other bytes, so another fingerprint').not.toBe(firstDoc.sha256);
  expect(again.state, 'but the same document').toMatchObject({ kind: 'saved', documentId: firstDoc.sha256, undoable: false });
  await expect(headerButton(again.page, CHIP.saved)).toBeVisible();
  await expect(headerButton(again.page, CHIP.unsure)).toHaveCount(0);
  expect(await save(again.page).documentId()).toBe(firstDoc.sha256);
  expect(await store(again.page).stats(), 'one document and an alias; the new place is recorded; nothing is copied').toMatchObject({ documents: 1, aliases: 1, locations: 2, history: 1, pageText: 8 });
  expect(await store(again.page).call('resolveFingerprint', againDoc.sha256)).toBe(firstDoc.sha256);
  expect((await listOpfs(again.page, 'pdf')).map((f) => f.path), 'the stamped copy is not stored again').toEqual([blobPathOf(firstDoc.sha256)]);
  expect(pathsOf(await store(again.page).listLocations(firstDoc.sha256))).toEqual(['/s/jstor-again.pdf', '/s/jstor-first.pdf']);

  const third = await openDecided(openViewer, server.url('/s/jstor-again.pdf'));
  expect(third.state, 'the next visit finds the alias by its fingerprint').toMatchObject({ kind: 'saved', documentId: firstDoc.sha256 });
  expect(await store(third.page).stats()).toMatchObject({ documents: 1, aliases: 1 });

  const other = await openDecided(openViewer, server.url('/s/jstor-other-paper.pdf'));
  expect(other.state.kind, 'a genuinely different paper is a different document').toBe('unsure');
  await expect(headerButton(other.page, CHIP.unsure)).toBeVisible();
  expect(await store(other.page).stats(), 'and it leaves nothing').toMatchObject({ documents: 1, aliases: 1, locations: 2 });
});

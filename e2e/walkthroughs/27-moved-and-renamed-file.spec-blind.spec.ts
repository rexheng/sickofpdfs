// Gate 1, Phase 3 plan, item 8: "Moved and renamed file."
//   "One library entry, two places. (Phase 1 covers identity; this checks the library shows it once.)"
// Spec, "How it feels to use" 9: 'You move, rename or re-download a file. Same contents, same fingerprint, same notes ... The library
// records the new location.' Identity rules 1 and 5: "A document is its fingerprint ... The same bytes from any link or folder are the same
// document with the same notes." "Each document keeps its locations (links and file paths, first and last seen)." Library: "My library:
// Every saved reading".
//
// "Attention Is All You Need" is copied to two folders under two names (like a download that was moved and renamed). Each is opened the way
// a double-click opens it: at its own file:// address, which the takeover sends to the viewer. A note is made on the first. The library must
// then show ONE reading, with the note, and the second copy must show the same note; the fixture server's address is a third place.
//
// No guard: it runs on the stand-in filter too (the paper is saved with the chip's "Save?" until the real filter does it).
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { copyFixture, expect, test } from '../support/test';
import { store as storeOf } from '../support/store-probe.spec-blind';
import { LINES, ATTENTION as ATTENTION_FX, cardWith, libraryId, postNote, saveFirst } from './support/marks.spec-blind';
import { openLocalFile, readyForMarks } from './support/local-file.spec-blind';
import { ATTENTION, goTo, listRows, openLibrary, rowFor, shaOf, shotOf, waitForStore, waitViewerReady } from './support/library-p3.spec-blind';

test.setTimeout(240_000);

const NOTE = 'Seen in two folders, one set of notes';

test('the same paper in two folders under two names is one reading with one set of notes, and the library shows it once', async ({ context, openViewer, server, tmp }, testInfo) => {
  const first = await copyFixture(ATTENTION.file, join(tmp, 'Downloads', 'attention.pdf'));
  const second = await copyFixture(ATTENTION.file, join(tmp, 'Papers', 'Week 3 reading (renamed).pdf'));
  const sha = await shaOf(ATTENTION);

  // 1. the first copy: saved, with a note
  const a = await openLocalFile(context, pathToFileURL(first).href);
  await readyForMarks(a);
  const id = await saveFirst(a);
  expect(id, "the document's id is the fingerprint of its bytes").toBe(sha);
  await postNote(a, ATTENTION_FX, LINES.l1, NOTE);
  await shotOf(a, testInfo, '01-first-copy-with-a-note');
  const places = await storeOf(a).call<{ kind: string; raw: string }[]>('listLocations', id);
  expect(places.map((p) => p.kind), 'one place so far: a file').toEqual(['file']);

  // 2. the second copy: another folder, another name, the same bytes
  const b = await openLocalFile(context, pathToFileURL(second).href);
  await readyForMarks(b);
  expect(await libraryId(b), 'it is the same document, already in the library').toBe(sha);
  await expect(b.locator('header').getByRole('button', { name: /saved to library/i }), 'the chip says so').toBeVisible({ timeout: 20_000 });
  await expect(cardWith(b, NOTE), 'and the note is on the second copy').toBeVisible({ timeout: 15_000 });
  await shotOf(b, testInfo, '02-second-copy-same-notes');

  // 3. the fixture server's address is a third place for the same bytes
  const c = await openViewer(server.url(ATTENTION.path));
  await waitViewerReady(c);
  await waitForStore(c);
  expect(await libraryId(c)).toBe(sha);

  // 4. one reading, three places
  await expect
    .poll(async () => (await storeOf(c).call<unknown[]>('listLocations', sha)).length, { message: 'the library records each new place', timeout: 15_000 })
    .toBe(3);
  const all = await storeOf(c).call<{ kind: string; raw: string; firstSeen: number; lastSeen: number }[]>('listLocations', sha);
  expect(all.map((p) => p.kind).sort(), 'two files and one link').toEqual(['file', 'file', 'url']);
  expect(all.some((p) => decodeURIComponent(p.raw).includes('Week 3 reading (renamed).pdf')), 'the renamed file is one of them').toBe(true);
  for (const p of all) expect(p.lastSeen, 'first seen is never after last seen').toBeGreaterThanOrEqual(p.firstSeen);
  const list = await storeOf(c).call<{ total: number; items: { doc: { id: string }; noteCount: number }[] }>('listDocuments', { view: 'all', sort: { by: 'title', dir: 'asc' }, limit: 50 });
  expect(list.total, 'My library holds one reading').toBe(1);
  expect(list.items[0].noteCount, 'with one note').toBe(1);

  // 5. the library shows it once
  const lib = await openLibrary(context, 'library');
  await expect(listRows(lib), 'My library lists it once').toHaveCount(1, { timeout: 15_000 });
  await expect(rowFor(lib, ATTENTION.rowName)).toBeVisible();
  await expect(rowFor(lib, ATTENTION.rowName).getByRole('img', { name: /1 note/i }), 'with its note').toBeVisible();
  await shotOf(lib, testInfo, '03-library-shows-it-once');
  await goTo(lib, 'recent');
  await expect(listRows(lib), 'and Recent lists it once').toHaveCount(1);
});

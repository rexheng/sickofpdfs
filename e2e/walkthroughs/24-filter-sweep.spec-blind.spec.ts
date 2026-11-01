// Gate 1, Phase 3 plan, item 5: "Filter sweep."
//   "Open every non-learning fixture in the real extension: the library stays empty. Open every learning fixture: all but at most one
//    are saved or asked."
// Spec, Release 1 done-when 4: "Learning PDFs are saved automatically. On the research test set and a separate held-out set, zero
// non-learning PDFs (receipts, statements, payslips, tax forms, tickets) are saved." Phase 3 done-when 1: "Zero false saves. ... All 22
// research non-learning files come out `not-learning`. At most 1 of the 22 learning files is not auto-saved (today it is the MIT 14.01
// handout, `unsure`)." Plan, risks: "`unsure` plus a first mark saves (spec) ... the Gate 1 sweep and T1 require all 22 non-learning
// fixtures to be `not-learning`, not merely `unsure`."
//
// The 44 research fixtures (test-assets/classifier/{learning,not-learning}, made by `pnpm fixtures`) are opened one by one in the real
// built extension, as a reader would, and the library is judged at the end by reading the store itself: a document's id is its
// SHA-256 (spec identity rule 1), so "was it saved" is a question about `resolveFingerprint(sha)`, not about wording on a chip.
//
// PRIVACY. For the non-learning files the test also reads the real storage (every table and index, every file in the extension's private file
// storage, localStorage, IndexedDB, the console) for a trace of each file, and the browser's net log after it closes: nothing may have been
// requested except the PDFs themselves. The learning sweep reads the net log too (the tie-breaker and the lookups must send nothing).
//
// Form PDFs (the manifest's Form is AcroForm or XFA) go on to Chrome's own viewer once classified (spec "Forms"), so the tab leaves
// the viewer and the chip cannot be read; for those only the library is judged. Nothing else may leave the viewer.
//
// Guard: FILTER_IN_VIEWER. Two tests, one browser each: the non-learning sweep, then the learning sweep. Each takes minutes.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, opfsList, sha256File, test } from '../support/test';
import { REPO_ROOT } from '../support/launch';
import { TEST_ASSETS } from '../support/server';
import { store as storeOf } from '../support/store-probe.spec-blind';
import { shot } from './support/takeover';
import {
  FILTER_IN_VIEWER,
  NO_FILTER,
  allReadings,
  chipText,
  collectConsole,
  decided,
  note,
  requestUrls,
  researchFixtures,
  sleep,
  stateKind,
  traceProblems,
  waitForStore,
  waitViewerReady,
} from './support/library-p3.spec-blind';

test.use({ networkGate: 'observe' });
test.skip(!FILTER_IN_VIEWER, NO_FILTER);
test.setTimeout(1_800_000);

// The harness wants the net log read before a test ends, even a test that failed early.
test.afterEach(async ({ netgate }) => {
  await netgate.report();
});

/** Asserts the browser requested the PDFs of the sweep (and the tiny probe PDF) and nothing else. */
async function expectOnlyThePdfs(netgate: Parameters<typeof requestUrls>[0], origin: string, label: 'learning' | 'not-learning'): Promise<void> {
  const urls = await requestUrls(netgate);
  const allowed = new Set(['/h/plain.pdf', '/__gate-ping', ...researchFixtures(label).map((n) => `/f/classifier/${label}/${n}`)]);
  const strays = urls.filter((u) => !(u.startsWith(origin) && allowed.has(new URL(u).pathname)));
  expect(strays, 'the browser requested nothing but the PDFs themselves').toEqual([]);
}

interface Manifest {
  items: { path: string; pdf_meta: { Form?: string }; label: string }[];
}
const MANIFEST = JSON.parse(readFileSync(join(REPO_ROOT, 'docs/research/classifier-fixtures/manifest.json'), 'utf8')) as Manifest;
const hasForm = (label: string, name: string): boolean => (MANIFEST.items.find((i) => i.path === `${label}/${name}`)?.pdf_meta.Form ?? 'none') !== 'none';

interface Row {
  name: string;
  /** The save decision the viewer showed, 'left-viewer' for a form PDF that went on to Chrome's viewer. */
  kind: string;
  chip: string;
  saved: boolean;
  seconds: number;
}

async function openOne(openViewer: (u: string) => Promise<Page>, url: string, label: 'learning' | 'not-learning', name: string, testInfo: Parameters<typeof shot>[1]): Promise<Pick<Row, 'kind' | 'chip' | 'seconds'>> {
  const t0 = Date.now();
  const page = await openViewer(url);
  let kind: string | null;
  try {
    kind = await decided(page, 120_000);
  } catch {
    kind = 'never-decided';
  }
  // A learning PDF is saved after its page text is read: a long book takes a few seconds to go from the verdict to "saved".
  if (kind === 'unsure' && label === 'learning') {
    for (let i = 0; i < 40 && (await stateKind(page)) === 'unsure'; i++) await sleep(200);
    kind = (await stateKind(page)) ?? kind;
  }
  const inViewer = page.url().includes('/viewer.html');
  const chip = inViewer ? await chipText(page).catch(() => '') : '';
  if (inViewer) await shot(page, testInfo, `${label}-${name.replace(/\.pdf$/, '')}`);
  const seconds = Math.round((Date.now() - t0) / 100) / 10;
  await page.close();
  return { kind: kind === null ? 'left-viewer' : kind, chip, seconds };
}

async function sweep(label: 'learning' | 'not-learning', openViewer: (u: string) => Promise<Page>, serverUrl: (p: string) => string, probe: Page, testInfo: Parameters<typeof shot>[1]): Promise<Row[]> {
  const rows: Row[] = [];
  for (const name of researchFixtures(label)) {
    const r = await openOne(openViewer, serverUrl(`/f/classifier/${label}/${name}`), label, name, testInfo);
    await waitForStore(probe);
    const sha = await sha256File(join(TEST_ASSETS, 'classifier', label, name));
    const saved = (await storeOf(probe).call<string | null>('resolveFingerprint', sha)) !== null;
    rows.push({ name, ...r, saved });
  }
  testInfo.annotations.push({ type: `${label} sweep`, description: rows.map((r) => `${r.name}: ${r.kind}${r.saved ? ' (in library)' : ''} ${r.seconds}s`).join('\n') });
  return rows;
}

test('every non-learning fixture is left alone: all 22 are "not learning", the library stays empty and holds no copy', async ({ context, openViewer, server, netgate }, testInfo) => {
  const logs = collectConsole(context);
  expect(researchFixtures('not-learning'), 'the 22 research non-learning fixtures are in test-assets (run pnpm fixtures)').toHaveLength(22);
  const probe = await openViewer(server.url('/h/plain.pdf')); // a tiny PDF whose tab carries the store, to read the library with
  await waitViewerReady(probe);
  await waitForStore(probe);

  const rows = await sweep('not-learning', openViewer, (p) => server.url(p), probe, testInfo);

  for (const r of rows) {
    expect.soft(r.saved, `${r.name} must not be in the library`).toBe(false);
    if (r.kind === 'left-viewer') {
      expect.soft(hasForm('not-learning', r.name), `${r.name} left the viewer, which only a form PDF may do`).toBe(true);
    } else {
      expect.soft(r.kind, `${r.name}: the filter must say "not learning", not "not sure" (chip: ${r.chip})`).toBe('not-learning');
      expect.soft(r.chip, `${r.name}: the chip says "Not saved"`).toMatch(/not saved/i);
    }
  }
  const stats = await storeOf(probe).stats();
  expect(stats, 'the library is empty: no document, location, alias, page text or history').toEqual({ documents: 0, aliases: 0, locations: 0, pageText: 0, history: 0, outbox: 0 });
  expect(await opfsList(probe, 'pdf'), 'and keeps no copy of any of them').toEqual([]);
  expect(await opfsList(probe, 'thumbs'), 'or a thumbnail').toEqual([]);
  expect((await allReadings(probe)).length).toBe(0);

  // no trace of any of them anywhere: tables, indexes, files, localStorage, IndexedDB, console
  const problems = new Set<string>();
  for (const name of researchFixtures('not-learning')) {
    const sha = await sha256File(join(TEST_ASSETS, 'classifier', 'not-learning', name));
    for (const p of await traceProblems(probe, { sha, phrases: [], fileName: name, logs: [...logs], noDrafts: true })) problems.add(p);
  }
  expect([...problems], 'none of the 22 left a trace').toEqual([]);
  await expectOnlyThePdfs(netgate, server.origin, 'not-learning');
  note(testInfo, 'non-learning verdicts', rows.map((r) => `${r.name}: ${r.chip || r.kind}`).join(' | '));
});

test('every learning fixture is saved or asked: at most one of the 22 is not saved by itself', async ({ openViewer, server, netgate }, testInfo) => {
  expect(researchFixtures('learning'), 'the 22 research learning fixtures are in test-assets (run pnpm fixtures)').toHaveLength(22);
  const probe = await openViewer(server.url('/h/plain.pdf'));
  await waitViewerReady(probe);
  await waitForStore(probe);

  const rows = await sweep('learning', openViewer, (p) => server.url(p), probe, testInfo);

  for (const r of rows) {
    expect.soft(r.kind, `${r.name} must never be judged "not learning" (chip: ${r.chip})`).not.toBe('not-learning');
    if (r.kind === 'left-viewer') expect.soft(hasForm('learning', r.name), `${r.name} left the viewer, which only a form PDF may do`).toBe(true);
  }
  const notSaved = rows.filter((r) => !r.saved);
  expect(
    notSaved.length,
    `at most 1 of the 22 learning files is not saved by itself; not saved: ${notSaved.map((r) => `${r.name} (${r.kind})`).join(', ')}`,
  ).toBeLessThanOrEqual(1);
  for (const r of notSaved) {
    expect.soft(r.kind, `${r.name} is not saved, so it must at least ask ("Not sure: Save?")`).toMatch(/unsure|left-viewer/);
  }
  const readings = await allReadings(probe);
  expect(readings.length, 'the library holds what was saved').toBe(rows.length - notSaved.length);
  note(testInfo, 'not saved', notSaved.map((r) => r.name).join(', ') || 'none');
  await expectOnlyThePdfs(netgate, server.origin, 'learning');
});

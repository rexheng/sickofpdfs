// Spec-blind tests for Task 30, `resolveIdentity`: who is this PDF? Real store (createStoreApi) over an in-memory SQLite.
//
// Sources:
//   spec, Identity rule 1: "A document is its fingerprint: the SHA-256 of the file's bytes."
//   spec, Identity rule 2: "Same text, new bytes = still the same document ... If new bytes have the same page count and their page text
//     matches a known document ... after stamp lines, IP addresses and dates are removed, the new fingerprint becomes an alias: same notes,
//     nothing copied."
//   spec, Identity rule 3: "A genuinely different file is a different document."
//   contracts section 4, "Identity: when a re-download is the same document (R59)": page counts equal; letters and digits identical after
//     stamps are removed; similarity >= 0.995; each side has real body text (200 letters and digits, 30 a page). "A missed alias costs a
//     re-save; a wrong alias shows the wrong notes."
//   spec, Local traces: "A PDF that isn't saved leaves no history row, thumbnail, search entry or log line."
//   interface file (Tasks 30+31): `resolveIdentity(i, store)` "reads, plus addAlias for a stamp alias; never touchLocation or recordOpen";
//     `IdentityResult = { kind: 'known'; documentId; via: 'fingerprint' | 'alias' } | { kind: 'unknown' }`;
//     "touchLocation and recordOpen have exactly one call site: SaveController.start()".
//   Test data: Task 19's packages/core/test/stamp-samples.ts (pagesWithStamp), the store's own spec-blind helpers.
//
// GUESSES (the interface file does not say; written down in task-30-tests-report.md):
//   G5  `pageTexts` is a function so that it is called only when needed: not for a fingerprint the library already knows, and not when no
//       library document has this page count (the store's countDocumentsWithPageCount exists to let the caller skip the extraction).
//   G6  For a fingerprint that is already recorded as an alias (found by an earlier visit), `via` may be either word: the store's
//       resolveFingerprint answers for documents.id and aliases.sha256 alike. Only a fresh stamp match must say 'alias'.
import { describe, expect, it, vi } from 'vitest';
import type { DocumentId, Sha256 } from '../../../../../packages/core/src/index';
import { bodyPages, pagesWithStamp, stampLines } from '../../../../../packages/core/test/stamp-samples';
import { all, count, tableNames, type Db } from '../../store/db.spec-blind';
import { freshStore, quiet, type StoreEnv } from '../../store/env.spec-blind';
import { ALIAS_1, asPages } from '../../store/library.spec-blind';
import { DOC } from '../../store/rows.spec-blind';
import type { StoreApi } from '../../store/store-api';
import { resolveIdentity } from './resolve-identity';

vi.setConfig({ testTimeout: 30_000 }); // each test builds a whole database in WebAssembly

const FIRST_COPY = { ip: '203.0.113.7', date: 'Tue, 12 Mar 2019 10:11:12 UTC' };
const RE_DOWNLOAD = { ip: '198.51.100.99', date: 'Fri, 03 Jan 2025 21:05:44 UTC' };
const NEW_SHA = 'f1'.repeat(32) as Sha256;
/** What a new alias changes: its row, the sync queue entry for it, and the queue's counter. */
const ALIAS_ROWS = ['aliases', 'outbox', 'sqlite_sequence'];
const WRITERS = ['touchLocation', 'recordOpen', 'saveDocument', 'putPageText', 'forgetDocument'] as const;

/** The library holds one 8-page paper (DOC) whose first copy carries its own download stamp on every page. */
async function libraryWithPaper(): Promise<StoreEnv> {
  const env = await freshStore();
  await env.api.putPageText(DOC, asPages(pagesWithStamp(FIRST_COPY.ip, FIRST_COPY.date)));
  quiet(env);
  return env;
}

/** The store as `resolveIdentity` sees it, with a record of every method it calls. */
function watched(api: StoreApi): { api: StoreApi; calls: string[] } {
  const calls: string[] = [];
  const proxy = new Proxy(api, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls.push(String(key));
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { api: proxy, calls };
}

const replacer = (_k: string, v: unknown) => (v instanceof Uint8Array ? Array.from(v) : typeof v === 'bigint' ? v.toString() : v);
/** Everything in every table except the ones named, as one text. */
const rowsExcept = (db: Db, skip: string[] = []): string =>
  JSON.stringify(
    tableNames(db)
      .filter((t) => !skip.includes(t))
      .map((t) => [t, all(db, `SELECT * FROM "${t}"`)]),
    replacer,
  );

function incoming(pageCount: number, texts: string[], sha256: Sha256 = NEW_SHA) {
  const pageTexts = vi.fn(() => Promise.resolve(texts));
  return { sha256, pageCount, pageTexts };
}

describe('a fingerprint the library already knows', () => {
  it('is the same document, found without reading any page text', async () => {
    const env = await libraryWithPaper();
    const { api, calls } = watched(env.api);
    const input = incoming(8, pagesWithStamp(RE_DOWNLOAD.ip, RE_DOWNLOAD.date), DOC);
    const before = rowsExcept(env.db);

    expect(await resolveIdentity(input, api)).toEqual({ kind: 'known', documentId: DOC, via: 'fingerprint' });

    expect(input.pageTexts, 'G5: extracting text for 600 pages costs seconds; a known fingerprint does not need it').not.toHaveBeenCalled();
    expect(calls.filter((c) => (WRITERS as readonly string[]).includes(c)), 'resolving writes nothing').toEqual([]);
    expect(rowsExcept(env.db), 'not one row changed').toBe(before);
  });

  it('is also found when it was recorded as the alias of a document earlier', async () => {
    const env = await libraryWithPaper();
    await env.api.addAlias(ALIAS_1, DOC, 0.998);
    quiet(env);
    const input = incoming(8, pagesWithStamp(RE_DOWNLOAD.ip, RE_DOWNLOAD.date), ALIAS_1);
    const before = rowsExcept(env.db);

    const result = await resolveIdentity(input, env.api);

    expect(result).toMatchObject({ kind: 'known', documentId: DOC });
    expect(['fingerprint', 'alias'], 'G6').toContain((result as { via: string }).via);
    expect(input.pageTexts).not.toHaveBeenCalled();
    expect(rowsExcept(env.db)).toBe(before);
  });
});

describe('same text, new bytes: a re-download that differs only by its download stamp', () => {
  const rewrapped = (): string[] =>
    // Same letters and digits in the same order; only the line breaks and one comma a page differ (contracts R59 (b): whitespace and
    // punctuation may differ; (c): similarity stays above 0.995, so only a little punctuation).
    bodyPages().map((body) => `${body.split(' ').map((w, i) => (i === 5 ? `${w},` : i % 25 === 24 ? `${w}\n` : w)).join(' ')}\n${stampLines(RE_DOWNLOAD.ip, RE_DOWNLOAD.date)}`);

  it.each([
    { name: 'another IP address and download date', texts: () => pagesWithStamp(RE_DOWNLOAD.ip, RE_DOWNLOAD.date) },
    { name: 'the very same text (other bytes, for example a rewritten file header)', texts: () => pagesWithStamp(FIRST_COPY.ip, FIRST_COPY.date) },
    { name: 'the same words with other line breaks and commas, and another stamp', texts: rewrapped },
  ])('with $name, it is the first copy: a stamp alias, recorded, with nothing else written', async ({ texts }) => {
    const env = await libraryWithPaper();
    const { api, calls } = watched(env.api);
    const input = incoming(8, texts());
    const beforeOthers = rowsExcept(env.db, ALIAS_ROWS);

    expect(await resolveIdentity(input, api)).toEqual({ kind: 'known', documentId: DOC, via: 'alias' });

    // the alias is written, by resolveIdentity itself (the next open finds it by fingerprint)
    expect(all(env.db, 'SELECT sha256, document_id, similarity FROM aliases')).toEqual([{ sha256: NEW_SHA, document_id: DOC, similarity: expect.any(Number) as number }]);
    const [{ similarity }] = all(env.db, 'SELECT similarity FROM aliases') as { similarity: number }[];
    expect(similarity).toBeGreaterThanOrEqual(0.995);
    expect(similarity).toBeLessThanOrEqual(1);
    expect(await env.api.resolveFingerprint(NEW_SHA)).toBe(DOC);
    expect(await env.api.stats()).toMatchObject({ documents: 1, aliases: 1 });

    // and nothing more: no new place, no history row, no copy of the document, no text
    expect(calls.filter((c) => (WRITERS as readonly string[]).includes(c)), 'touchLocation and recordOpen belong to SaveController.start(), the only call site').toEqual([]);
    expect(rowsExcept(env.db, ALIAS_ROWS), 'locations, history, documents and page text are exactly as before').toBe(beforeOthers);
  });

  it('the second visit finds the alias by fingerprint, without extracting the text again', async () => {
    const env = await libraryWithPaper();
    await resolveIdentity(incoming(8, pagesWithStamp(RE_DOWNLOAD.ip, RE_DOWNLOAD.date)), env.api);
    const second = incoming(8, pagesWithStamp(RE_DOWNLOAD.ip, RE_DOWNLOAD.date));

    const result = await resolveIdentity(second, env.api);

    expect(result).toMatchObject({ kind: 'known', documentId: DOC });
    expect(second.pageTexts, 'G5').not.toHaveBeenCalled();
    expect(count(env.db, 'aliases')).toBe(1);
  });

  it('two tabs opening the same stamped re-download at once agree, and make one alias', async () => {
    const env = await libraryWithPaper();
    const texts = pagesWithStamp(RE_DOWNLOAD.ip, RE_DOWNLOAD.date);

    const [a, b] = await Promise.all([resolveIdentity(incoming(8, texts), env.api), resolveIdentity(incoming(8, texts), env.api)]);

    expect(a).toMatchObject({ kind: 'known', documentId: DOC });
    expect(b).toMatchObject({ kind: 'known', documentId: DOC });
    expect(count(env.db, 'aliases')).toBe(1);
  });
});

describe('a genuinely different file is a different document: unknown, and nothing at all is written', () => {
  const otherPaper = () => pagesWithStamp(RE_DOWNLOAD.ip, RE_DOWNLOAD.date, { body: 'other-body' });
  const oneLetterChanged = () => {
    // an arXiv v2 that corrects one thing: 1 character in 30,000, similarity 0.99997, yet another document (R59 (b))
    const texts = pagesWithStamp(RE_DOWNLOAD.ip, RE_DOWNLOAD.date);
    texts[3] = `${texts[3].slice(0, 100)}${texts[3][100] === 'q' ? 'z' : 'q'}${texts[3].slice(101)}`;
    return texts;
  };
  const onePageReplaced = () => {
    const texts = pagesWithStamp(RE_DOWNLOAD.ip, RE_DOWNLOAD.date);
    texts[3] = pagesWithStamp(RE_DOWNLOAD.ip, RE_DOWNLOAD.date, { body: 'other-body' })[3];
    return texts;
  };

  it.each([
    { name: 'another paper with the same page count', pageCount: 8, texts: otherPaper },
    { name: 'the same paper with one letter changed', pageCount: 8, texts: oneLetterChanged },
    { name: 'the same paper with one page replaced', pageCount: 8, texts: onePageReplaced },
    { name: 'the same paper with a page more', pageCount: 9, texts: () => pagesWithStamp(RE_DOWNLOAD.ip, RE_DOWNLOAD.date, { pages: 9 }) },
    { name: 'a scan whose pages have no text', pageCount: 8, texts: () => Array.from({ length: 8 }, () => '') },
    { name: 'pages that hold nothing but the stamp', pageCount: 8, texts: () => Array.from({ length: 8 }, () => stampLines(RE_DOWNLOAD.ip, RE_DOWNLOAD.date)) },
  ])('$name', async ({ pageCount, texts }) => {
    const env = await libraryWithPaper();
    const { api, calls } = watched(env.api);
    const before = rowsExcept(env.db);

    expect(await resolveIdentity(incoming(pageCount, texts()), api)).toEqual({ kind: 'unknown' });

    expect(calls.filter((c) => (WRITERS as readonly string[]).includes(c) || c === 'addAlias'), 'an unknown PDF is not written about').toEqual([]);
    expect(rowsExcept(env.db), 'not one row changed: an unsaved PDF leaves no trace').toBe(before);
    expect(await env.api.resolveFingerprint(NEW_SHA)).toBeNull();
  });

  it('an empty library knows nothing: unknown, and the database is untouched', async () => {
    const env = await freshStore({ document: false });
    const before = rowsExcept(env.db);
    expect(await resolveIdentity(incoming(8, pagesWithStamp(RE_DOWNLOAD.ip, RE_DOWNLOAD.date)), env.api)).toEqual({ kind: 'unknown' });
    expect(rowsExcept(env.db)).toBe(before);
  });

  it('a PDF whose page count no library document has is judged without extracting its text (G5: a 600-page book costs seconds to read)', async () => {
    const env = await libraryWithPaper();
    const input = incoming(600, ['never needed']);
    expect(await resolveIdentity(input, env.api)).toEqual({ kind: 'unknown' });
    expect(input.pageTexts).not.toHaveBeenCalled();
  });
});

describe('the answer does not depend on who else is in the library', () => {
  it('finds the right document among several with the same page count', async () => {
    const env = await libraryWithPaper();
    const second = 'ee'.repeat(32) as DocumentId;
    await env.api.saveDocument({ id: second, byteSize: 1000, pageCount: 8, title: 'Another', authors: [], pdfId: null, hasText: true, encrypted: false, blobStored: true, saveReasons: [], location: null, openedAt: 1 });
    await env.api.putPageText(second, asPages(pagesWithStamp('192.0.2.1', 'Mon, 01 Jan 2024 00:00:00 UTC', { body: 'other-body' })));
    quiet(env);

    expect(await resolveIdentity(incoming(8, pagesWithStamp(RE_DOWNLOAD.ip, RE_DOWNLOAD.date, { body: 'other-body' })), env.api)).toMatchObject({ kind: 'known', documentId: second });
    expect(await resolveIdentity(incoming(8, pagesWithStamp(RE_DOWNLOAD.ip, RE_DOWNLOAD.date), 'e2'.repeat(32) as Sha256), env.api)).toMatchObject({ kind: 'known', documentId: DOC });
  });
});

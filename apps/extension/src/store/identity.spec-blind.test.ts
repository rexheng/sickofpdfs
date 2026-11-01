// Spec-blind tests for Task 28, who a PDF is: fingerprints, aliases (the "same text, new bytes" rule), and findStampAlias.
//
// Sources:
//   spec, Identity rule 1: "A document is its fingerprint: the SHA-256 of the file's bytes".
//   spec, Identity rule 2: "If new bytes have the same page count and their page text matches a known document at 99.5% or more after
//     stamp lines, IP addresses and dates are removed, the new fingerprint becomes an alias: same notes, nothing copied."
//     (JSTOR prints "This content downloaded from <IP> on <date>" on every page.)
//   spec, Identity rule 3: "A genuinely different file is a different document."
//   interface file (Task 28): resolveFingerprint "documents.id or aliases.sha256"; findStampAlias "reads only";
//     addAlias(sha256, documentId, similarity); the normative aliases table (sha256 and document_id; similarity between 0.995 and 1;
//     the document must exist).
//   CLAUDE.md: "no lost notes": two different documents must never share notes.
// Real store over real SQLite (in memory). findStampAlias is judged by what it answers and by the database being byte-for-byte the same.
import { describe, expect, it, vi } from 'vitest';
import type { DocumentId } from '../../../../packages/core/src/index';
import { all, count } from './db.spec-blind';
import { freshStore, type StoreEnv } from './env.spec-blind';
import { ALIAS_1, ALIAS_2, GHOST, asPages, bodyOf, snapshot, stampedPages } from './library.spec-blind';
import { DOC, DOC2, SAMPLE_INPUT, SAMPLE_INPUT_2 } from './rows.spec-blind';

vi.setConfig({ testTimeout: 30_000 }); // each test builds a whole database in WebAssembly; a busy machine needs more than 5 s

describe('fingerprints and aliases', () => {
  it('a fingerprint resolves to its document whether it is the document id or a recorded alias, and an unknown one resolves to nothing', async () => {
    const env = await freshStore();
    expect(await env.api.resolveFingerprint(DOC)).toBe(DOC);
    expect(await env.api.resolveFingerprint(ALIAS_1)).toBeNull();

    await env.api.addAlias(ALIAS_1, DOC, 0.998);

    expect(await env.api.resolveFingerprint(ALIAS_1)).toBe(DOC);
    expect(await env.api.resolveFingerprint(DOC)).toBe(DOC);
    expect(await env.api.resolveFingerprint(ALIAS_2)).toBeNull();
    expect(all(env.db, 'SELECT sha256, document_id, similarity FROM aliases')).toEqual([{ sha256: ALIAS_1, document_id: DOC, similarity: 0.998 }]);
    expect(await env.api.stats()).toMatchObject({ aliases: 1 });
  });

  it('noting the same alias twice is harmless (two tabs open the same stamped re-download): one alias, no error', async () => {
    const env = await freshStore();
    await env.api.addAlias(ALIAS_1, DOC, 0.998);
    await expect(env.api.addAlias(ALIAS_1, DOC, 0.998)).resolves.toBeUndefined();
    expect(count(env.db, 'aliases')).toBe(1);
    expect(await env.api.resolveFingerprint(ALIAS_1)).toBe(DOC);
  });

  it.each([
    { name: 'a similarity below the 99.5% rule', similarity: 0.99, target: DOC },
    { name: 'a similarity of nothing', similarity: 0, target: DOC },
    { name: 'a similarity above 1', similarity: 1.01, target: DOC },
    { name: 'a document that was never saved', similarity: 0.999, target: GHOST },
  ])('refuses an alias with $name, and stores nothing', async ({ similarity, target }) => {
    const env = await freshStore();
    await expect(env.api.addAlias(ALIAS_1, target, similarity)).rejects.toBeDefined();
    expect(count(env.db, 'aliases')).toBe(0);
    expect(await env.api.resolveFingerprint(ALIAS_1)).toBeNull();
    expect(env.changes()).toEqual([]);
  });

  it('counts the saved documents that have a page count', async () => {
    const env = await freshStore(); // DOC: 8 pages
    await env.api.saveDocument({ ...SAMPLE_INPUT_2, pageCount: 8 });
    await env.api.saveDocument({ ...SAMPLE_INPUT, id: 'ee'.repeat(32) as DocumentId, pageCount: 3 });
    expect(await env.api.countDocumentsWithPageCount(8)).toBe(2);
    expect(await env.api.countDocumentsWithPageCount(3)).toBe(1);
    expect(await env.api.countDocumentsWithPageCount(99)).toBe(0);
  });
});

describe('findStampAlias: "same text, new bytes"', () => {
  const FIRST_COPY = { ip: '203.0.113.7', date: 'Tue, 12 Mar 2019 10:11:12 UTC' };
  const RE_DOWNLOAD = { ip: '198.51.100.99', date: 'Fri, 03 Jan 2025 21:05:44 UTC' };

  /** The library holds one 8-page paper whose first copy carries its own download stamp on every page. */
  async function libraryWithPaper(): Promise<StoreEnv> {
    const env = await freshStore();
    await env.api.putPageText(DOC, asPages(stampedPages(1, 8, FIRST_COPY.ip, FIRST_COPY.date)));
    env.db.exec('DELETE FROM outbox');
    env.publish.mockClear();
    return env;
  }

  it.each([
    { name: 'the same pages with a different IP address and download date', texts: () => stampedPages(1, 8, RE_DOWNLOAD.ip, RE_DOWNLOAD.date) },
    { name: 'the very same text (other bytes, for example a rewritten file header)', texts: () => stampedPages(1, 8, FIRST_COPY.ip, FIRST_COPY.date) },
  ])('finds the known document for $name, and says how alike they are', async ({ texts }) => {
    const env = await libraryWithPaper();
    const hit = await env.api.findStampAlias(8, texts());
    expect(hit).not.toBeNull();
    expect(hit!.documentId).toBe(DOC);
    expect(hit!.similarity).toBeGreaterThanOrEqual(0.995);
    expect(hit!.similarity).toBeLessThanOrEqual(1);
  });

  it('only reads: asking changes no row, no index, no queue and announces nothing', async () => {
    const env = await libraryWithPaper();
    const before = snapshot(env.db);

    await env.api.findStampAlias(8, stampedPages(1, 8, RE_DOWNLOAD.ip, RE_DOWNLOAD.date)); // a match
    await env.api.findStampAlias(8, stampedPages(2, 8, RE_DOWNLOAD.ip, RE_DOWNLOAD.date)); // no match
    await env.api.findStampAlias(9, stampedPages(1, 9, RE_DOWNLOAD.ip, RE_DOWNLOAD.date)); // no candidate

    expect(snapshot(env.db)).toBe(before);
    expect(count(env.db, 'aliases'), 'it is the caller who records an alias, with addAlias').toBe(0);
    expect(env.changes()).toEqual([]);
  });

  const changedPage = (): string[] => {
    const texts = stampedPages(1, 8, RE_DOWNLOAD.ip, RE_DOWNLOAD.date);
    texts[3] = `${bodyOf(77, 3)}\nThis content downloaded from ${RE_DOWNLOAD.ip} on ${RE_DOWNLOAD.date}`; // one whole page is different text
    return texts;
  };
  it.each([
    { name: 'a different page count', pageCount: 9, texts: () => stampedPages(1, 9, RE_DOWNLOAD.ip, RE_DOWNLOAD.date) },
    { name: 'a different paper with the same page count', pageCount: 8, texts: () => stampedPages(2, 8, RE_DOWNLOAD.ip, RE_DOWNLOAD.date) },
    { name: 'one page of eight replaced by different text (a revised edition is another document)', pageCount: 8, texts: changedPage },
    { name: 'a scan with no text at all', pageCount: 8, texts: () => Array.from({ length: 8 }, () => '') },
    { name: 'page text that is only the stamp', pageCount: 8, texts: () => Array.from({ length: 8 }, () => `${'This content downloaded from 198.51.100.99 on Fri, 03 Jan 2025 21:05:44 UTC'}\nAll use subject to https://about.jstor.org/terms`) },
  ])('is not fooled by $name: it answers nothing, so the file stays a document of its own', async ({ pageCount, texts }) => {
    const env = await libraryWithPaper();
    expect(await env.api.findStampAlias(pageCount, texts())).toBeNull();
  });

  it('never joins two different scans: a library holding a scan (no text) answers nothing for a new scan of the same length', async () => {
    const env = await libraryWithPaper();
    await env.api.saveDocument({ ...SAMPLE_INPUT_2, pageCount: 5, hasText: false });
    await env.api.putPageText(DOC2, asPages(['', '', '', '', '']));
    expect(await env.api.findStampAlias(5, ['', '', '', '', ''])).toBeNull();
    expect(await env.api.findStampAlias(5, ['', '', '', '', ' \n'])).toBeNull();
    expect(await env.api.resolveFingerprint(DOC2)).toBe(DOC2);
  });
});

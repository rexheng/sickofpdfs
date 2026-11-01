// Test support only: a filled schema v1 database, the way an owner who used Phase 1 and a few Phase 2 builds would have
// it. Rows are inserted by plain SQL, so v1's own triggers (outbox, FTS) run, and the outbox is not empty.
import type { Db } from './db.spec-blind';
import { createV1 } from './v1-fixture.spec-blind';
import { DOC, DOC2, textAnchor } from './rows.spec-blind';

const H = (n: number) => `${String(1_700_000_000_000 + n).padStart(13, '0')}-0000-devA`;
const j = JSON.stringify;

/** v1 anchors: no textSource, no objectIndices. They must read back exactly like this after the upgrade. */
export const V1_ANCHORS = {
  textA: textAnchor(0, 100, 124, 'difference-in-differences'),
  textB: { ...textAnchor(0, 300, 340, 'placebo test'), end: { page: 1, index: 12 }, rects: [{ page: 0, rects: [[0.1, 0.9, 0.9, 0.95]] }, { page: 1, rects: [[0.1, 0.05, 0.4, 0.08]] }] },
  area: { kind: 'area' as const, page: 1, rect: [0.1, 0.1, 0.5, 0.4] as [number, number, number, number], dHash: '00ff00ff00ff00ff' },
  page: { kind: 'page' as const, page: 2 },
  doc: { kind: 'document' as const },
};
export const CLAUDE_META = { kind: 'claude-reply', v: 1, role: 'default', status: 'done', error: null, questionId: 'c1', citations: [], webSources: [], usage: null, scope: 'passages', figureLabels: [], via: 'viewer', fieldFromAFutureBuild: { keep: 'me' } };

export function fillV1(db: Db): void {
  createV1(db);
  const doc = (id: string, title: string, n: number) =>
    db.exec({ sql: `INSERT INTO documents(id, page_count, byte_size, title, authors, has_text, created_at, updated_at, rev, hlc) VALUES (?, 8, 1000, ?, '["A. Author"]', 1, ?, ?, 2, ?)`, bind: [id, title, 1000 + n, 1000 + n, H(n)] });
  doc(DOC, 'Parallel trends in practice', 1);
  doc(DOC2, 'Another paper', 2);
  db.exec({ sql: "INSERT INTO aliases(sha256, document_id, similarity, created_at, hlc) VALUES (?, ?, 0.998, 5, ?)", bind: ['ef'.repeat(32), DOC, H(3)] });
  db.exec({ sql: "INSERT INTO locations(id, document_id, kind, canonical, raw, first_seen, last_seen, hlc) VALUES (?, ?, 'url', 'https://example.org/a.pdf', 'https://example.org/a.pdf', 1, 2, ?)", bind: ['11'.repeat(32), DOC, H(4)] });
  db.exec({ sql: "INSERT INTO page_text(document_id, page_index, text) VALUES (?, 0, 'the difference-in-differences estimator and parallel trends'), (?, 1, 'placebo test results')", bind: [DOC, DOC] });
  db.exec({ sql: "INSERT INTO history(document_id, first_opened, last_opened, open_count, reading_ms, hlc) VALUES (?, 10, 20, 3, 5000, ?)", bind: [DOC, H(5)] });
  db.exec({ sql: "INSERT INTO settings(key, value, rev, hlc) VALUES ('marks.lastColor', '3', 1, ?), ('ui.rail', 'true', 0, ?)", bind: [H(6), H(6)] });
  db.exec({ sql: "INSERT INTO page_figures(document_id, page_index, detector_version, figures) VALUES (?, 0, '1', '[{\"index\":0}]')", bind: [DOC] });

  const mark = (id: string, style: string, color: number | null, anchor: unknown, page: number, sortKey: number, n: number, rev = 0) =>
    db.exec({ sql: 'INSERT INTO marks(id, document_id, style, color, anchor, page_index, sort_key, created_at, updated_at, rev, hlc) VALUES (?,?,?,?,?,?,?,?,?,?,?)', bind: [id, DOC, style, color, j(anchor), page, sortKey, 100 + n, 100 + n, rev, H(10 + n)] });
  mark('m1', 'highlight', 2, V1_ANCHORS.textA, 0, 0.2, 1, 3);
  mark('m2', 'underline', 4, V1_ANCHORS.textB, 0, 0.9, 2);
  mark('m3', 'area', null, V1_ANCHORS.area, 1, 0.1, 3);
  mark('m4', 'bold', null, V1_ANCHORS.textA, 0, 0.2, 4);
  db.exec("UPDATE marks SET deleted_at = 999 WHERE id = 'm4'");

  const thread = (id: string, anchor: unknown, page: number | null, sortKey: number | null, n: number) =>
    db.exec({ sql: 'INSERT INTO threads(id, document_id, anchor, page_index, sort_key, created_at, updated_at, rev, hlc) VALUES (?,?,?,?,?,?,?,1,?)', bind: [id, DOC, j(anchor), page, sortKey, 200 + n, 200 + n, H(20 + n)] });
  thread('t1', V1_ANCHORS.textA, 0, 0.2, 1);
  thread('t2', V1_ANCHORS.page, 2, 0, 2);
  thread('t3', V1_ANCHORS.doc, null, null, 3);
  thread('t4', V1_ANCHORS.page, 2, 0, 4);
  db.exec("UPDATE threads SET deleted_at = 998 WHERE id = 't4'");

  const comment = (id: string, thread: string, author: string, body: string, n: number, meta: unknown = {}, draftOfTab: string | null = null) =>
    db.exec({ sql: 'INSERT INTO comments(id, thread_id, document_id, author, body, draft_of_tab, meta, created_at, hlc) VALUES (?,?,?,?,?,?,?,?,?)', bind: [id, thread, DOC, author, body, draftOfTab, j(meta), 300 + n, H(30 + n)] });
  comment('c1', 't1', 'me', 'Why is parallel trends plausible here?', 1);
  comment('c2', 't1', 'me', 'Because of the placebo test.', 2);
  comment('c3', 't1', 'claude', 'It rests on the pre-period fit.', 3, CLAUDE_META);
  comment('c4', 't2', 'me', 'page note about a zebra', 4);
  comment('c5', 't1', 'me', 'unsent thought about quokkas', 5, {}, 'old-tab-1');
  comment('c6', 't1', 'me', 'deleted okapi remark', 6);
  db.exec("UPDATE comments SET deleted_at = 997 WHERE id = 'c6'");
}

/** The ids a reader should see through listAnnotations(DOC) on the upgraded database. */
export const V1_LIVE = { marks: ['m1', 'm2', 'm3'], threads: ['t1', 't2', 't3'], comments: ['c1', 'c2', 'c3', 'c4'] };
export const V1_TABLES = ['documents', 'aliases', 'locations', 'page_text', 'marks', 'threads', 'comments', 'history', 'settings', 'page_figures', 'outbox'];

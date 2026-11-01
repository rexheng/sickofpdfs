// Test support only (spec-blind tests for the library side of the store: documents, aliases, locations, page text, Forget).
// Written from the spec and the interface, without any of the code under test. Plain data builders and two database probes.
import type { DocumentId, Sha256 } from '../../../../packages/core/src/index';
import { all, tableNames, type Db } from './db.spec-blind';

export const ALIAS_1 = 'a1'.repeat(32) as Sha256;
export const ALIAS_2 = 'a2'.repeat(32) as Sha256;
/** A document id that was never saved. */
export const GHOST = 'ef'.repeat(32) as DocumentId;
export const ZERO_STATS = { documents: 0, aliases: 0, locations: 0, pageText: 0, history: 0, outbox: 0 };

const VOCABULARY = (
  'estimator treatment control outcome policy variance sample cohort baseline shock elasticity regression panel pooled clustered ' +
  'robust bandwidth discontinuity threshold instrument weak strong exclusion monotonicity compliers attrition spillover mechanism ' +
  'heterogeneity subgroup coverage inference bootstrap permutation balanced leads lags dynamic event window donor synthetic weights ' +
  'penalty shrinkage kernel density quantile median skewness tails outliers imputation missing censored duration hazard survival ' +
  'welfare mobility inequality taxation incidence labour supply schooling returns apprenticeship migration remittances trade'
).split(' ');

/**
 * Plain, repeatable text for page `page` of the paper numbered `seed`. Two different seeds, or two different pages, give
 * different text. No word of it is one of the "needle" words the tests plant.
 */
export function bodyOf(seed: number, page: number, words = 90): string {
  let x = (seed * 7919 + page * 104_729 + 12_345) >>> 0;
  const out: string[] = [];
  for (let i = 0; i < words; i++) {
    x = (Math.imul(x, 1_103_515_245) + 12_345) >>> 0;
    out.push(VOCABULARY[(x >>> 8) % VOCABULARY.length]);
  }
  return out.join(' ');
}

/** The two lines JSTOR prints at the foot of every page of a download (spec, Identity rule 2). */
export const stampLines = (ip: string, date: string): string => `This content downloaded from ${ip} on ${date}\nAll use subject to https://about.jstor.org/terms`;

/** The text of a whole paper as its pages come out of the engine, with a download stamp at the foot of each page. */
export const stampedPages = (seed: number, pages: number, ip: string, date: string): string[] =>
  Array.from({ length: pages }, (_, p) => `${bodyOf(seed, p)}\n${stampLines(ip, date)}`);

/** `putPageText` input from a list of page texts. */
export const asPages = (texts: readonly string[]): { pageIndex: number; text: string }[] => texts.map((text, pageIndex) => ({ pageIndex, text }));

/** Everything in every table (the search index's own tables included), as one text, to compare before and after. */
export function snapshot(db: Db): string {
  const replacer = (_k: string, v: unknown) => (v instanceof Uint8Array ? Array.from(v) : typeof v === 'bigint' ? v.toString() : v);
  return JSON.stringify(
    tableNames(db).map((t) => [t, all(db, `SELECT * FROM "${t}"`)]),
    replacer,
  );
}

/** Throws if a search index disagrees with the rows it indexes (a Forget that edited the index badly shows up here). */
export function assertIndexesSound(db: Db): void {
  db.exec("INSERT INTO page_text_fts(page_text_fts, rank) VALUES('integrity-check', 1)");
  db.exec("INSERT INTO documents_fts(documents_fts) VALUES('integrity-check')");
  db.exec("INSERT INTO comments_fts(comments_fts) VALUES('integrity-check')");
}

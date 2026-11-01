// How much of an input the filter reads. A real page holds 2,000 to 8,000 characters and the largest real sample (10
// pages) about 61,000, so these limits never touch a real PDF. They exist so that a hostile or broken one cannot make the
// filter slow: every pattern in this package is linear in the text it is given, and this keeps that text bounded.

/** Characters read from one page: the first 20,000. */
export const PAGE_CHAR_CAP = 20_000;
/** Characters read from all sampled pages together. */
export const TOTAL_CHAR_CAP = 120_000;
/** A file name, title, creator or producer is cut to this length. */
export const FIELD_CHAR_CAP = 500;
/** A link is cut to this length before it is parsed. The host comes first, so it survives the cut. */
export const LINK_CHAR_CAP = 4_000;

/** The pages cut to PAGE_CHAR_CAP each and TOTAL_CHAR_CAP together; pages after the budget are empty. */
export function capPages(pages: readonly string[]): string[] {
  let left = TOTAL_CHAR_CAP;
  return pages.map((page) => {
    if (typeof page !== 'string') return '';
    const cut = page.slice(0, Math.min(PAGE_CHAR_CAP, left));
    left -= cut.length;
    return cut;
  });
}

export function capField(value: string | null | undefined): string {
  return typeof value === 'string' && value.length > FIELD_CHAR_CAP ? value.slice(0, FIELD_CHAR_CAP) : (value ?? '');
}

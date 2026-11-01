// "Search" in the mark-up menu: the selected words in Google Scholar, in a new tab. When the selection holds a DOI or an
// arXiv id (a reference in a bibliography, say), it opens that paper instead (spec "Marks", plan S13).
//
// Privacy: nothing is sent until the person picks Search, and then only the selected words go, to the one site named
// in the menu. The new tab is opened by Chrome (chrome.tabs.create), so no Referer and no viewer address (which holds
// the PDF's own address) go with it.

/** Where Search goes for some selected text, and what the menu calls it. */
export interface SearchTarget {
  kind: 'doi' | 'arxiv' | 'scholar';
  url: string;
  /** The menu row's label: says plainly where the tab will go. */
  label: string;
}

/** Longest query sent to Google Scholar: a long selection is cut at a word boundary. */
const MAX_QUERY_CHARS = 300;

/** A DOI: "10." then a registrant code, a slash and a suffix with no spaces (old Wiley DOIs hold "<" and ">"). */
const DOI = /\b(10\.\d{4,9}\/[^\s"]+)/iu;
/** arXiv ids: new style 1512.03385 (YYMM.NNNNN), with an optional version; old style hep-th/9901001. */
const ARXIV_NEW = /(?<![\d.])(\d{2}(?:0[1-9]|1[0-2])\.\d{4,5}(?:v\d+)?)(?![\d])/u;
const ARXIV_OLD = /\b([a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)\b/u;
/** The selection names arXiv ("arXiv:1512.03385", "arXiv preprint", an arxiv.org link): only then is a number an id. */
const ARXIV_MARK = /arxiv/iu;

/** The selection's words, on one line: line breaks and runs of spaces become one space. */
export function cleanQuery(text: string): string {
  return text.replace(/[\s\u00ad\ufffe]+/gu, ' ').trim();
}

/** Strips what follows a DOI in running text: a closing bracket, a full stop or a comma. */
function trimDoi(doi: string): string {
  let d = doi;
  for (;;) {
    const next = d.replace(/[.,;:]+$/u, '');
    // A closing bracket belongs to the DOI only when the DOI opened one, as in 10.1002/(SICI)…<693::AID-ASI4>3.0.CO;2-0
    const unbalanced = /[)\]>]$/u.test(next) && (next.match(/[([<]/gu)?.length ?? 0) < (next.match(/[)\]>]/gu)?.length ?? 0);
    const trimmed = unbalanced ? next.slice(0, -1) : next;
    if (trimmed === d) return d;
    d = trimmed;
  }
}

function cut(query: string, max: number): string {
  if (query.length <= max) return query;
  const head = query.slice(0, max);
  const space = head.lastIndexOf(' ');
  return space > max / 2 ? head.slice(0, space) : head;
}

/** Where Search goes for `text`. Null when there is nothing to search for. */
export function searchTarget(text: string): SearchTarget | null {
  const query = cleanQuery(text);
  if (query === '') return null;
  const doi = DOI.exec(query);
  if (doi?.[1] !== undefined) {
    const id = trimDoi(doi[1]);
    const path = id.split('/').map(encodeURIComponent).join('/');
    return { kind: 'doi', url: `https://doi.org/${path}`, label: 'Open the paper (doi.org)' };
  }
  if (ARXIV_MARK.test(query)) {
    const id = ARXIV_NEW.exec(query)?.[1] ?? ARXIV_OLD.exec(query)?.[1];
    if (id !== undefined) return { kind: 'arxiv', url: `https://arxiv.org/abs/${id}`, label: 'Open the paper (arXiv)' };
  }
  const q = cut(query, MAX_QUERY_CHARS);
  return { kind: 'scholar', url: `https://scholar.google.com/scholar?q=${encodeURIComponent(q)}`, label: 'Search Google Scholar' };
}

/** Opens the target in a new tab next to this one. */
export async function openSearch(target: SearchTarget): Promise<void> {
  try {
    const here = await chrome.tabs.getCurrent();
    await chrome.tabs.create({ url: target.url, active: true, ...(here?.index !== undefined ? { index: here.index + 1 } : {}), ...(here?.id !== undefined ? { openerTabId: here.id } : {}) });
  } catch {
    // Outside an extension page (never in the product): a plain new tab, still without a Referer.
    window.open(target.url, '_blank', 'noopener,noreferrer');
  }
}

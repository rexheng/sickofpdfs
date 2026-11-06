// Turns the citations Claude returns into the page chips and source chips the thread shows.
//
// Two kinds come back for our own text: `content_block_location` (a block of a custom-content document: the map, a figure
// pack, the passages) and `search_result_location` (a block of a search_result a client tool returned). Both point at
// `blocks[i]` through `CitableBlock.via` (contract addition A5). A third, `web_search_result_location`, is a web page.
//
// Rules: an index that points at no block is dropped and never guessed; citing the same passage again reuses its number.
import type { CitableBlock, PageCitation, WebSource } from './types';

const QUOTE_MAX = 240;
const WEB_TITLE_MAX = 200;
const WEB_CITED_MAX = 300;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => v !== null && typeof v === 'object';
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** "[p. 4] The rest." becomes "The rest.": the page tag is ours, and the chip already says the page. */
function stripPageTags(text: string): string {
  return text.replace(/(^|\n)\[p\. \d+\] ?/g, '$1').trim();
}

export type ResolvedCitation =
  | { kind: 'page'; citation: PageCitation; isNew: boolean }
  | { kind: 'web'; source: WebSource; isNew: boolean };

export interface CitationBook {
  /** One raw citation from the API. Returns the links it makes, in page order; an empty list when it points at nothing we sent. */
  resolve(raw: unknown): ResolvedCitation[];
  citations(): PageCitation[];
  webSources(): WebSource[];
}

/** Whether a block has a place in the request we can look up (A5). Blocks made without `via` are treated as one flat list. */
function lookup(blocks: readonly CitableBlock[]) {
  const flat = blocks.every((b) => b.via === undefined);
  const find = (kind: 'document' | 'search_result', index: number, start: number, end: number): CitableBlock[] => {
    if (flat) return kind === 'document' ? blocks.slice(start, end) : [];
    return blocks.filter((b) => b.via !== undefined && b.via.kind === kind && b.via.index === index && b.via.block >= start && b.via.block < end);
  };
  return { find, flat };
}

/** Which blocks a raw `content_block_location` or `search_result_location` covers. */
function coveredBlocks(raw: Rec, find: ReturnType<typeof lookup>['find'], flat: boolean): CitableBlock[] {
  const start = raw.start_block_index;
  const end = raw.end_block_index;
  if (!isInt(start) || !isInt(end) || start < 0 || end <= start) return [];
  if (raw.type === 'content_block_location') {
    const doc = raw.document_index;
    if (!isInt(doc) || doc < 0) return [];
    const hit = find('document', doc, start, end);
    // A flat list has no document numbers; its blocks are addressed by block index alone, and only a real range is valid.
    return flat && hit.length !== end - start ? [] : hit;
  }
  if (raw.type === 'search_result_location') {
    const idx = raw.search_result_index;
    if (!isInt(idx) || idx < 0) return [];
    return find('search_result', idx, start, end);
  }
  return [];
}

export function createCitationBook(blocks: readonly CitableBlock[]): CitationBook {
  const { find, flat } = lookup(blocks);
  const pages = new Map<string, PageCitation>();
  const webs = new Map<string, WebSource>();

  /** `group` has at least one block (the caller makes groups from blocks it has). */
  function page(first: CitableBlock, group: CitableBlock[], quote: string): ResolvedCitation {
    const start = Math.min(...group.map((b) => b.start));
    const end = Math.max(...group.map((b) => b.end));
    const key = `${first.textSource}|${first.pageIndex}|${start}|${end}`;
    const known = pages.get(key);
    if (known) return { kind: 'page', citation: known, isNew: false };
    const citation: PageCitation = { n: pages.size + 1, pageIndex: first.pageIndex, start, end, textSource: first.textSource, quote };
    pages.set(key, citation);
    return { kind: 'page', citation, isNew: true };
  }

  return {
    resolve(raw) {
      if (!isRec(raw)) return [];
      if (raw.type === 'web_search_result_location') {
        const url = typeof raw.url === 'string' ? raw.url : '';
        let ok: boolean;
        try {
          const u = new URL(url);
          ok = u.protocol === 'https:' || u.protocol === 'http:';
        } catch {
          ok = false;
        }
        if (!ok) return [];
        const known = webs.get(url);
        if (known) return [{ kind: 'web', source: known, isNew: false }];
        const title = typeof raw.title === 'string' && raw.title.trim() ? clip(raw.title.trim(), WEB_TITLE_MAX) : new URL(url).hostname;
        const cited = typeof raw.cited_text === 'string' && raw.cited_text.trim() ? clip(raw.cited_text.trim(), WEB_CITED_MAX) : null;
        const source: WebSource = { n: webs.size + 1, url, title, citedText: cited };
        webs.set(url, source);
        return [{ kind: 'web', source, isNew: true }];
      }
      const covered = coveredBlocks(raw, find, flat);
      if (covered.length === 0) return [];
      const quote = clip(stripPageTags(typeof raw.cited_text === 'string' ? raw.cited_text : ''), QUOTE_MAX);
      // Blocks next to each other on the same page merge into one passage; a span over two pages makes two.
      const groups: { head: CitableBlock; blocks: CitableBlock[] }[] = [];
      for (const b of covered) {
        const last = groups.at(-1);
        if (last && last.head.pageIndex === b.pageIndex && last.head.textSource === b.textSource) last.blocks.push(b);
        else groups.push({ head: b, blocks: [b] });
      }
      return groups.map((g) => page(g.head, g.blocks, quote));
    },
    citations: () => [...pages.values()],
    webSources: () => [...webs.values()],
  };
}

/**
 * The Markdown link for a page citation: `[Page 4](cite:1)` (R74: "Page N" everywhere, so the Notes page, exports and search snippets
 * read it the same way). Replies stored before 6 Nov say `[p. 4](cite:1)`; both forms are read. Page numbers are 1-based; `pageIndex` is 0-based.
 */
export function pageLink(c: PageCitation): string {
  return `[Page ${c.pageIndex + 1}](cite:${c.n})`;
}

/** The Markdown link for a web source: `[source](web:2)`. */
export function webLink(s: WebSource): string {
  return `[source](web:${s.n})`;
}

/**
 * A stored reply body, as plain text for Claude when a thread is rebuilt after a reload. The `cite:` and `web:` links mean
 * nothing to Claude and cost tokens, so page chips become "(Page 4)" (an older reply's "[p. 4]" too) and source chips disappear.
 */
export function replyBodyToPlainText(body: string): string {
  return body
    .replace(/\[(?:Page|p\.) (\d+)\]\(cite:\d+\)/g, '(Page $1)')
    .replace(/[ \t]?\[[^\]]*\]\(web:\d+\)/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

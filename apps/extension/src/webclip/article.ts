// "Save this page to library" (spec R103): the article a web page holds, as the page script reads it (reader.ts) and the
// typesetter lays it out (typeset.ts). It is plain data, so it crosses from the page to the extension as it is.
//
// The page is read only when the owner clicks "Save this page to library". Nothing in here is sent anywhere.

/** A stretch of text with one style. `href` makes it a link. A `br` is a line break inside a paragraph. */
export type Inline =
  | { text: string; bold?: boolean; italic?: boolean; code?: boolean; sup?: boolean; sub?: boolean; href?: string }
  | { br: true };

/** A picture in the article: which `<img>` of the page it is (its index in `document.images`), and how big it is there. */
export interface ImageRef {
  /** The index of the live `<img>` in the page's `document.images`, so its pixels can be read later. */
  ref: number;
  /** The address the article names for it (lazy pictures: the real one, not the placeholder). */
  src: string;
  alt: string;
  /** Its size in CSS px, when the page says (0 when not known). */
  width: number;
  height: number;
}

export interface ListItem {
  blocks: Block[];
}

export interface TableRow {
  header: boolean;
  cells: Inline[][];
}

export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; runs: Inline[] }
  | { kind: 'paragraph'; runs: Inline[] }
  | { kind: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'code'; text: string }
  | { kind: 'figure'; images: ImageRef[]; caption: Inline[] }
  | { kind: 'table'; rows: TableRow[] }
  | { kind: 'rule' };

export interface Article {
  /** The page's own address, without its `#…` part; the canonical link when it is on the same site. */
  url: string;
  title: string;
  /** As the page writes it ("By Ada Lovelace"); null when it names nobody. */
  byline: string | null;
  /** The names in the byline. */
  authors: string[];
  siteName: string | null;
  /** When it was published, as an ISO date or the page's own words; null when the page does not say. */
  published: string | null;
  /** The page's language (`en-GB`), or null. */
  lang: string | null;
  blocks: Block[];
  /** How many words the article has. */
  words: number;
}

/** What the page script answers. */
export type ReadResult =
  | { kind: 'article'; article: Article }
  /** A PDF shown by Chrome's own viewer (a very large file, or one a form posted). */
  | { kind: 'pdf' }
  /** No article: a web app, a sign-in page, a list of links. */
  | { kind: 'none' };

/** What reading one picture gives: a JPEG or PNG at most 1,600 px wide, as a data URL; or why it could not be read. */
export type ImageResult = { ok: true; dataUrl: string; width: number; height: number } | { ok: false };

/** The widest a picture is kept (spec R103). */
export const MAX_IMAGE_PX = 1600;

/** The names of the global the page script leaves in its own (isolated) world, for reading the pictures afterwards. */
export const PAGE_GLOBAL = '__sopWebclip';

const isText = (r: Inline): r is Extract<Inline, { text: string }> => 'text' in r;

/** The plain text of some runs. */
export function textOfRuns(runs: readonly Inline[]): string {
  return runs.map((r) => (isText(r) ? r.text : '\n')).join('');
}

/** Every block, depth first (list items and quotes opened up). */
export function* allBlocks(blocks: readonly Block[]): Generator<Block> {
  for (const b of blocks) {
    yield b;
    if (b.kind === 'list') for (const item of b.items) yield* allBlocks(item.blocks);
    if (b.kind === 'quote') yield* allBlocks(b.blocks);
  }
}

/**
 * The article's words as one string, spaces collapsed: what "the article text changed" compares (spec R103: a page that changed
 * since is saved as a new version). Pictures, links and styles do not count; the date the page was saved never enters it.
 */
export function articleText(a: Pick<Article, 'title' | 'blocks'>): string {
  const parts: string[] = [a.title];
  for (const b of allBlocks(a.blocks)) {
    if (b.kind === 'heading' || b.kind === 'paragraph') parts.push(textOfRuns(b.runs));
    else if (b.kind === 'code') parts.push(b.text);
    else if (b.kind === 'figure') parts.push(textOfRuns(b.caption));
    else if (b.kind === 'table') for (const row of b.rows) for (const cell of row.cells) parts.push(textOfRuns(cell));
  }
  return parts.join(' ').replace(/\s+/gu, ' ').trim();
}

/** Every picture of the article, in reading order. */
export function articleImages(a: Pick<Article, 'blocks'>): ImageRef[] {
  const out: ImageRef[] = [];
  for (const b of allBlocks(a.blocks)) if (b.kind === 'figure') out.push(...b.images);
  return out;
}

/** The SHA-256 of the article's words, as hex (Web Crypto: the extension pages and the page script both have it). */
export async function articleTextHash(a: Pick<Article, 'title' | 'blocks'>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(articleText(a)));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The names in a byline: "By Ada Lovelace and Charles Babbage" → both names. Words that are not names ("5 min read",
 * "Follow", a date, "Updated …") and anything after a middle dot or a bar are left out. At most 6 names.
 */
export function bylineAuthors(byline: string | null): string[] {
  if (byline === null) return [];
  const first = byline.split(/[·|•\n]/u)[0] ?? '';
  const cleaned = first
    .replace(/^\s*(?:written\s+)?by\s+/iu, '')
    .replace(/\b(?:updated|published|posted)\b.*$/iu, '')
    .trim();
  const names = cleaned
    .split(/\s*(?:,|&|\band\b|\bwith\b)\s*/iu)
    .map((n) => n.replace(/\s+/gu, ' ').trim())
    .filter((n) => n.length >= 2 && n.length <= 60 && /\p{L}/u.test(n) && !/\d/u.test(n) && !/^(?:follow|staff|admin|editor|editors)$/iu.test(n));
  return [...new Set(names)].slice(0, 6);
}

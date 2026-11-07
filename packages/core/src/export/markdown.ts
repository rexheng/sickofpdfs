// The Markdown export of a document's notes (contracts §5): Ctrl+Shift+E, and `notes/<title-slug>-<sha[0..8]>.md` in a backup.
// Pure: no clock, no engine, no randomness, so the same rows always give the same text.
//
// Layout
//   ---                              front matter: title, authors, doi, arxiv, source, course, recognised_text, sickofpdfs { documentId, format }
//   # Title
//   ## Document notes                notes on the whole document, first
//   ## Page N                        one section for each page that has notes, in page order; inside, top to bottom
//
// An item is the passage as a blockquote (bold as **…**, strikethrough as ~~…~~), then one line of labels and a link back
// ("Highlight (yellow) · [p. 4](…#page=4)"), then the comment as a bullet with its replies indented under it. A reply from
// Claude starts "Claude:". A highlight or underline over the same words as a comment is shown on that comment's item.
//
// Links back. A document with a web link gets `<link>#page=N`. A document opened from a file gets
// `<viewerBase>?doc=<id>#page=N`. `[p. 4](cite:1)` in a Claude reply becomes `[p. 4](<link back to page 4>)`, and
// `[source](web:2)` becomes a link to that source's address.
//
// Safety. Everything from a PDF or from a note is untrusted. The export never writes raw HTML: a `<` that could start a tag
// becomes `&lt;`, an image becomes a plain link, a link other than http(s) or mailto loses its link, and a quote can only
// ever be a blockquote (its Markdown marks are escaped, so it cannot become a heading, a list or a code block).
// Code (spans and fences) is copied as it is. Maths (`$…$`, `$$…$$`) is copied as written, with a `<` in it as TeX's `\lt `.
// Front matter values are always double-quoted YAML strings.
import type { Anchor } from '../model/anchor';
import type { ExportComment, ExportDocument, ExportMark, ExportThread } from './markdown-input';

/** `sickofpdfs.format` in the front matter. */
export const MARKDOWN_FORMAT = 1;

/** The title of a document that has none. */
export const UNTITLED = 'Untitled';

const DEFAULT_VIEWER = 'viewer.html';
const COLOUR_NAMES: Readonly<Record<number, string>> = { 1: 'yellow', 2: 'green', 3: 'blue', 4: 'pink', 5: 'orange' };
const SLUG_MAX = 60;
const SEP = ' \u00b7 ';

// ---- file name -------------------------------------------------------------------------------------------------------

/**
 * The name of a document's notes file: `<title-slug>-<first 8 of the fingerprint>.md`, for example
 * `attention-is-all-you-need-bdfaa68d.md`. The slug is lower case; letters and numbers of any script stay, accents on Latin,
 * Greek and Cyrillic letters go, and every other run of characters becomes one `-`. It is at most 60 characters and `untitled`
 * when nothing is left. The caller puts the file in `notes/`.
 */
export function notesFileName(title: string | null | undefined, sha: string): string {
  const folded = String(title ?? '').normalize('NFKD').replace(/[\u0300-\u036f]+/g, '').normalize('NFC').toLowerCase();
  const words = folded.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
  let slug = [...words].slice(0, SLUG_MAX).join('').replace(/-+$/g, '');
  if (slug === '') slug = 'untitled';
  const tag = String(sha).toLowerCase().replace(/[^0-9a-z]/g, '').slice(0, 8);
  return `${slug}-${tag}.md`;
}

// ---- small text helpers ----------------------------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

const oneLine = (s: unknown): string => (typeof s === 'string' ? s.replace(CONTROL, '').replace(/\s+/g, ' ').trim() : '');

/** A YAML double-quoted string: JSON's escapes are valid YAML, plus the line separators YAML would otherwise fold. */
function yamlString(s: string): string {
  return JSON.stringify(s).replace(/[\u007f-\u009f\u2028\u2029\ufeff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** Text that must read as typed: Markdown marks are escaped, `&` that would read as an entity and `<` that would open a tag are made safe. */
function escapeInline(text: string): string {
  return text
    .replace(/&(?=#?[A-Za-z0-9]+;)/g, '&amp;')
    .replace(/<(?=[A-Za-z/!?])/g, '&lt;')
    .replace(/[\\`*_[\]~]/g, (c) => `\\${c}`);
}

/** The first character of a line is a block mark (heading, quote, list, rule, fence): make it plain text. */
function escapeLineStart(line: string): string {
  return line.replace(/^([#>+\-=])/, '\\$1').replace(/^(\d+)([.)])(?=\s|$)/, '$1\\$2');
}

/** A web address that is safe as a Markdown link target: no space, parenthesis, angle bracket, quote or backslash. */
function linkTarget(url: string): string {
  return url.replace(CONTROL, '').trim().replace(/[\s()<>\\"`]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

function isHttp(url: unknown): url is string {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) return false;
  try {
    new URL(url.trim());
    return true;
  } catch {
    return false;
  }
}

// ---- links back ------------------------------------------------------------------------------------------------------

const withoutFragment = (u: string): string => {
  const at = u.indexOf('#');
  return at < 0 ? u : u.slice(0, at);
};

/** The address that opens the document at a page (1-based): the web link, or the viewer with `doc`. */
function linkBack(doc: ExportDocument, page1: number): string {
  if (isHttp(doc.sourceLink)) return `${withoutFragment(doc.sourceLink.trim())}#page=${page1}`;
  const base = withoutFragment(oneLine(doc.viewerBase) || DEFAULT_VIEWER).split('?')[0] ?? DEFAULT_VIEWER;
  return `${base}?doc=${encodeURIComponent(doc.id)}#page=${page1}`;
}

// ---- a note's body ---------------------------------------------------------------------------------------------------

interface Refs {
  citations: readonly { n: number; pageIndex: number }[];
  webSources: readonly { n: number; url: string }[];
}

function refsOf(meta: unknown): Refs {
  const m = (typeof meta === 'object' && meta !== null ? meta : {}) as { citations?: unknown; webSources?: unknown };
  const list = <T>(v: unknown, ok: (x: unknown) => x is T): T[] => (Array.isArray(v) ? v.filter(ok) : []);
  const isRec = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null;
  return {
    citations: list(m.citations, (x): x is { n: number; pageIndex: number } => isRec(x) && typeof x.n === 'number' && typeof x.pageIndex === 'number' && Number.isInteger(x.pageIndex)),
    webSources: list(m.webSources, (x): x is { n: number; url: string } => isRec(x) && typeof x.n === 'number' && typeof x.url === 'string'),
  };
}

const CODE_SPAN = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g;
const AUTOLINK = /<(?:https?:\/\/[^\s<>]+)>/gi;
/** One Markdown link or image: `[text](target)` / `![alt](target)`. The text may hold one level of brackets. */
const LINK = /(!?)\[((?:[^[\]\\]|\\.|\[[^\]]*\])*)\]\(\s*<?([^()\s>]*(?:\([^()]*\)[^()\s>]*)*)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
const REF_DEF = /^(\s{0,3})\[[^\]]+\]:\s*<?(\S+)/;

/** Whether a link target is one we keep: http(s) or mailto, or no scheme at all. Backslashes and entities are read as a renderer would. */
function safeTarget(target: string): boolean {
  const probe = target
    .replace(/\\(.)/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(Math.min(parseInt(h, 16), 0x10ffff)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Math.min(Number(d), 0x10ffff)))
    .replace(/&colon;/gi, ':')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0020]/g, '');
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(probe)?.[1]?.toLowerCase();
  if (scheme === undefined) return true;
  return scheme === 'http' || scheme === 'https' || scheme === 'mailto';
}

interface Ctx {
  doc: ExportDocument;
  refs: Refs;
}

function rewriteLink(bang: string, label: string, target: string, ctx: Ctx): string {
  const t = target.trim();
  const plain = label.trim();
  const cite = /^cite:(\d+)$/.exec(t);
  if (cite && bang === '') {
    const n = Number(cite[1]);
    const known = ctx.refs.citations.find((c) => c.n === n);
    const fromLabel = /(\d+)/.exec(plain)?.[1];
    const page1 = known ? known.pageIndex + 1 : fromLabel !== undefined ? Number(fromLabel) : 0;
    if (!Number.isSafeInteger(page1) || page1 < 1) return plain;
    return `[p. ${page1}](${linkTarget(linkBack(ctx.doc, page1))})`;
  }
  const web = /^web:(\d+)$/.exec(t);
  if (web && bang === '') {
    const known = ctx.refs.webSources.find((s) => s.n === Number(web[1]));
    if (!known || !isHttp(known.url)) return plain;
    return `[${plain || 'source'}](${linkTarget(known.url)})`;
  }
  if (t === '' || !safeTarget(t)) return plain;
  // an image is shown as a plain link, so opening the export never loads anything
  return `[${plain || (bang === '!' ? 'image' : t)}](${linkTarget(t)})`;
}

/**
 * A formula on one line: `$$…$$`, or `$…$` that opens before a character that is not a space and closes after one, and
 * not before a digit (the reply view reads maths by the same rules, ClaudeMaths.tsx).
 */
const MATH_SPAN = /\$\$(?:[^$\\]|\\.|\$(?!\$))+?\$\$|\$(?=[^\s$])(?:[^$\\]|\\.)+?(?<=[^\s\\])\$(?!\d)/g;
/** "$5 and $10": a span that starts with a digit and has a space in it is money. */
const isMoney = (m: string): boolean => !m.startsWith('$$') && /^\$\d/.test(m) && /\s/.test(m);

/** One line of a note: links rewritten, raw HTML made harmless, code spans, maths and web autolinks left alone. */
function renderInline(line: string, ctx: Ctx): string {
  const refDef = REF_DEF.exec(line);
  if (refDef && !safeTarget(refDef[2] ?? '')) return `\\${line.trimStart()}`;

  const stash: string[] = [];
  const hold = (s: string): string => `\uE000${stash.push(s) - 1}\uE001`;
  let s = line.replace(/[\uE000\uE001]/g, '');
  s = s.replace(CODE_SPAN, (m) => hold(m));
  // Maths (`$…$`, `$$…$$`, as Claude writes it) is kept as it is written, the form papers use, except that a `<` becomes
  // TeX's own `\lt `: the same symbol, and never the start of an HTML tag. "$5 and $10" is money, not maths.
  s = s.replace(MATH_SPAN, (m) => (isMoney(m) ? m : hold(m.replace(/</g, '\\lt '))));
  s = s.replace(AUTOLINK, (m) => hold(m));
  s = s.replace(LINK, (_m, bang: string, label: string, target: string) => rewriteLink(bang, label, target, ctx));
  s = s.replace(/\\</g, '&lt;').replace(/<(?=[A-Za-z/!?])/g, '&lt;');
  for (let guard = 0; guard < 4 && /\uE000\d+\uE001/.test(s); guard++) s = s.replace(/\uE000(\d+)\uE001/g, (_m, n: string) => stash[Number(n)] ?? '');
  return s;
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

/** A note's Markdown as lines, trimmed at both ends. Fenced code is copied as it is. */
function renderBody(body: string, ctx: Ctx): string[] {
  const lines = body.replace(/\r\n?/g, '\n').replace(CONTROL, '').split('\n').map((l) => l.replace(/[ \t]+$/, ''));
  while (lines.length > 0 && lines[0] === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const out: string[] = [];
  let fence: string | null = null;
  for (const raw of lines) {
    const m = FENCE.exec(raw);
    if (fence !== null) {
      out.push(raw);
      if (m && raw.trim() === m[1] && m[1].charAt(0) === fence.charAt(0) && m[1].length >= fence.length) fence = null;
      continue;
    }
    if (m) {
      fence = m[1] ?? null;
      out.push(raw);
      continue;
    }
    if (raw === '' && out[out.length - 1] === '') continue;
    out.push(raw === '' ? '' : renderInline(raw, ctx));
  }
  return out;
}

/** The first line begins with something that only means that at the start of a line (so a label cannot go in front of it). */
const BLOCK_START = /^\s*(?:[#>|]|[-+*]\s|\d+[.)]\s|={2,}|-{2,}|`{3,}|~{3,})/;

/** A comment as list lines. `bullet` starts the first line, `indent` every other non-empty one. */
function commentLines(c: ExportComment, bullet: string, indent: string, ctx: Ctx): string[] {
  const body = renderBody(typeof c.body === 'string' ? c.body : '', { doc: ctx.doc, refs: refsOf(c.meta) });
  if (body.length === 0) return [];
  const meta = (typeof c.meta === 'object' && c.meta !== null ? c.meta : {}) as { kind?: unknown };
  const label = c.author === 'claude' ? 'Claude:' : meta.kind === 'conflict-copy' ? 'Edited on another device:' : '';
  const lines = [...body];
  if (label !== '') {
    if (BLOCK_START.test(lines[0] ?? '')) lines.unshift(label);
    else lines[0] = `${label} ${lines[0] ?? ''}`;
  }
  return lines.map((l, i) => (i === 0 ? `${bullet}${l}` : l === '' ? '' : `${indent}${l}`));
}

// ---- items -----------------------------------------------------------------------------------------------------------

interface Item {
  /** 0-based; null for a note on the whole document. */
  page: number | null;
  sortKey: number | null;
  createdAt: number;
  id: string;
  quote: string | null;
  bold: boolean;
  strike: boolean;
  labels: string[];
  comments: ExportComment[];
  /** The quote is recognised text from a scan. */
  scan: boolean;
}

const cmpText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

function byReading(a: Item, b: Item): number {
  return (a.sortKey ?? -1) - (b.sortKey ?? -1) || a.createdAt - b.createdAt || cmpText(a.id, b.id);
}

function pageOf(anchor: Anchor | undefined, fallback: number | null | undefined): number | null {
  const ok = (p: unknown): p is number => typeof p === 'number' && Number.isInteger(p) && p >= 0;
  if (!anchor || typeof anchor !== 'object' || anchor.kind === 'document') return null;
  if (anchor.kind === 'text') return ok(anchor.start?.page) ? anchor.start.page : ok(fallback) ? fallback : null;
  if (anchor.kind === 'area' || anchor.kind === 'figure' || anchor.kind === 'point' || anchor.kind === 'page') return ok(anchor.page) ? anchor.page : ok(fallback) ? fallback : null;
  return ok(fallback) ? fallback : null;
}

const rangeKey = (a: Anchor | undefined): string | null =>
  a && a.kind === 'text' && a.start && a.end ? `${a.start.page}:${a.start.index}-${a.end.page}:${a.end.index}` : null;

const textQuote = (a: Anchor | undefined): string | null => (a && a.kind === 'text' && typeof a.quote?.quote === 'string' && a.quote.quote.trim() !== '' ? a.quote.quote : null);

/** True when the quote was read off a scan (the anchor's text source is 'ocr:<engine>@<version>'). */
const fromScan = (a: Anchor | undefined): boolean => a !== undefined && a.kind === 'text' && typeof a.textSource === 'string' && a.textSource.startsWith('ocr:') && textQuote(a) !== null;

/** The label on a note that came from the PDF's own annotations. */
export const IMPORTED_LABEL = 'Imported from the PDF';
/** The label on a quote that is recognised text. */
export const RECOGNISED_LABEL = 'Recognised text';
/** The front matter note when any quote is recognised text. */
export const RECOGNISED_NOTE = 'Some quotes are recognised text from a scan, so a word may be misread. Check them against the page.';

const isImportedComment = (c: ExportComment): boolean => (typeof c.meta === 'object' && c.meta !== null ? (c.meta as { kind?: unknown }).kind === 'pdf-import' : false);

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** "Highlight (yellow)", "Underline (blue)"; null for the styles that show in the quote itself (bold, strikethrough). */
function styleLabel(m: ExportMark): string | null {
  if (m.style !== 'highlight' && m.style !== 'underline') return null;
  const colour = typeof m.color === 'number' ? COLOUR_NAMES[m.color] : undefined;
  return colour ? `${cap(m.style)} (${colour})` : cap(m.style);
}

const figureName = (a: Anchor | undefined): string => (a && a.kind === 'figure' && oneLine(a.figure?.label) !== '' ? oneLine(a.figure.label) : 'Figure');

/** What an area, figure, pin or page note is called on its item (text notes have a quote instead). */
function placeLabel(a: Anchor | undefined): string | null {
  if (!a) return null;
  switch (a.kind) {
    case 'area':
      return 'Area note';
    case 'figure':
      return `${figureName(a)} note`;
    case 'point':
      return 'Pin';
    case 'page':
      return 'Page note';
    default:
      return null;
  }
}

function itemsOf(marks: readonly ExportMark[], threads: readonly ExportThread[], comments: readonly ExportComment[], imported: ReadonlySet<string>): Item[] {
  // comments of each thread, oldest first; a draft, a deleted one, one with nothing in it and a Claude reply still being written are left out
  const byThread = new Map<string, ExportComment[]>();
  for (const c of comments) {
    if (!c || c.deletedAt != null || c.draftOfTab != null) continue;
    if (typeof c.body !== 'string' || c.body.trim() === '') continue;
    const meta = (typeof c.meta === 'object' && c.meta !== null ? c.meta : {}) as { kind?: unknown; status?: unknown };
    if (meta.kind === 'claude-reply' && meta.status !== undefined && meta.status !== 'done') continue;
    const list = byThread.get(c.threadId);
    if (list) list.push(c);
    else byThread.set(c.threadId, [c]);
  }
  for (const list of byThread.values()) list.sort((a, b) => num(a.createdAt, 0) - num(b.createdAt, 0) || cmpText(a.id, b.id));

  // live marks, grouped: every mark on exactly the same words is one group; any other mark is a group of its own
  const groups = new Map<string, ExportMark[]>();
  const liveMarks = marks.filter((m) => m && m.deletedAt == null).sort((a, b) => num(a.createdAt, 0) - num(b.createdAt, 0) || cmpText(a.id, b.id));
  for (const m of liveMarks) {
    const key = rangeKey(m.anchor) ?? `mark:${m.id}`;
    const list = groups.get(key);
    if (list) list.push(m);
    else groups.set(key, [m]);
  }
  const claimed = new Set<string>();

  const decorate = (group: ExportMark[] | undefined): Pick<Item, 'bold' | 'strike' | 'labels'> => {
    const labels: string[] = [];
    let bold = false;
    let strike = false;
    for (const m of group ?? []) {
      if (m.style === 'bold') bold = true;
      else if (m.style === 'strike') strike = true;
      const l = styleLabel(m);
      if (l !== null && !labels.includes(l)) labels.push(l);
    }
    return { bold, strike, labels };
  };

  const items: Item[] = [];

  for (const t of threads) {
    if (!t || t.deletedAt != null || t.draftOfTab != null) continue;
    const cs = byThread.get(t.id);
    if (!cs || cs.length === 0) continue;
    const key = rangeKey(t.anchor);
    const group = key !== null ? groups.get(key) : undefined;
    if (key !== null && group) claimed.add(key);
    const place = placeLabel(t.anchor);
    const d = decorate(group);
    items.push({
      page: pageOf(t.anchor, t.pageIndex),
      sortKey: typeof t.sortKey === 'number' && Number.isFinite(t.sortKey) ? t.sortKey : null,
      createdAt: num(t.createdAt, 0),
      id: t.id,
      quote: textQuote(t.anchor),
      ...d,
      labels: [...(place !== null ? [place] : []), ...d.labels, ...(fromScan(t.anchor) ? [RECOGNISED_LABEL] : []), ...(imported.has(t.id) || cs.some(isImportedComment) || (group ?? []).some((m) => imported.has(m.id)) ? [IMPORTED_LABEL] : [])],
      comments: cs,
      scan: fromScan(t.anchor),
    });
  }

  for (const [key, group] of groups) {
    if (claimed.has(key)) continue;
    const first = group[0];
    const a = first.anchor;
    const place = a && (a.kind === 'area' || a.kind === 'figure') ? (a.kind === 'figure' ? `${figureName(a)} mark` : 'Area mark') : null;
    const d = decorate(group);
    items.push({
      page: pageOf(a, first.pageIndex),
      sortKey: typeof first.sortKey === 'number' && Number.isFinite(first.sortKey) ? first.sortKey : null,
      createdAt: Math.min(...group.map((m) => num(m.createdAt, 0))),
      id: first.id,
      quote: textQuote(a),
      ...d,
      labels: [...(place !== null ? [place] : []), ...d.labels, ...(fromScan(a) ? [RECOGNISED_LABEL] : []), ...(group.some((m) => imported.has(m.id)) ? [IMPORTED_LABEL] : [])],
      comments: [],
      scan: fromScan(a),
    });
  }
  return items;
}

/** The passage as a blockquote. Every line is escaped and prefixed, so nothing in it can leave the quote. */
function quoteLines(quote: string, bold: boolean, strike: boolean): string[] {
  const raw = quote.replace(/\r\n?/g, '\n').split('\n').map(oneLine);
  while (raw.length > 0 && raw[0] === '') raw.shift();
  while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  const out: string[] = [];
  for (const l of raw) {
    if (l === '') {
      if (out[out.length - 1] !== '>') out.push('>');
      continue;
    }
    let text = escapeLineStart(escapeInline(l));
    if (bold) text = `**${text}**`;
    if (strike) text = `~~${text}~~`;
    out.push(`> ${text}`);
  }
  return out;
}

function itemLines(item: Item, doc: ExportDocument): string[] {
  const ctx: Ctx = { doc, refs: { citations: [], webSources: [] } };
  const blocks: string[][] = [];
  if (item.quote !== null) {
    const q = quoteLines(item.quote, item.bold, item.strike);
    if (q.length > 0) blocks.push(q);
  }
  if (item.page !== null) {
    const link = `[p. ${item.page + 1}](${linkTarget(linkBack(doc, item.page + 1))})`;
    blocks.push([[...item.labels.map(escapeInline), link].join(SEP)]);
  } else if (item.labels.length > 0) {
    blocks.push([item.labels.map(escapeInline).join(SEP)]);
  }
  const [root, ...replies] = item.comments;
  if (root) {
    const list = commentLines(root, '- ', '  ', ctx);
    for (const r of replies) list.push(...commentLines(r, '  - ', '    ', ctx));
    if (list.length > 0) blocks.push(list);
  }
  const out: string[] = [];
  blocks.forEach((b, i) => {
    if (i > 0) out.push('');
    out.push(...b);
  });
  return out;
}

// ---- the document ----------------------------------------------------------------------------------------------------

function frontMatter(doc: ExportDocument, title: string, scan: boolean): string[] {
  const lines = ['---', `title: ${yamlString(title)}`];
  const authors = (Array.isArray(doc.authors) ? doc.authors : []).map(oneLine).filter((a) => a !== '');
  if (authors.length > 0) {
    lines.push('authors:');
    for (const a of authors) lines.push(`  - ${yamlString(a)}`);
  } else {
    lines.push('authors: []');
  }
  const doi = oneLine(doc.doi);
  if (doi !== '') lines.push(`doi: ${yamlString(doi)}`);
  const arxiv = oneLine(doc.arxivId);
  if (arxiv !== '') lines.push(`arxiv: ${yamlString(arxiv)}`);
  if (isHttp(doc.sourceLink)) lines.push(`source: ${yamlString(oneLine(doc.sourceLink))}`);
  const courses = [...new Set((Array.isArray(doc.courses) ? doc.courses : []).map(oneLine).filter((c) => c !== ''))].sort(cmpText);
  if (courses.length === 1) lines.push(`course: ${yamlString(courses[0])}`);
  else if (courses.length > 1) {
    lines.push('course:');
    for (const c of courses) lines.push(`  - ${yamlString(c)}`);
  }
  if (scan) lines.push(`recognised_text: ${yamlString(RECOGNISED_NOTE)}`);
  lines.push('sickofpdfs:', `  documentId: ${yamlString(String(doc.id))}`, `  format: ${MARKDOWN_FORMAT}`, '---');
  return lines;
}

/**
 * A document's notes as Markdown. Deleted rows and drafts are left out, and so are Claude replies that are not finished.
 * Marks with no comment are listed too, so a reading's highlights are all in the file. Never throws on odd rows.
 */
export function exportMarkdown(
  doc: ExportDocument,
  marks: readonly ExportMark[],
  threads: readonly ExportThread[],
  comments: readonly ExportComment[],
): string {
  const title = oneLine(doc.title) || UNTITLED;
  const items = itemsOf(marks ?? [], threads ?? [], comments ?? [], doc.importedRowIds ?? new Set<string>());

  const out: string[] = [...frontMatter(doc, title, items.some((i) => i.scan)), '', `# ${escapeInline(title)}`];

  const whole = items.filter((i) => i.page === null).sort(byReading);
  if (whole.length > 0) {
    out.push('', '## Document notes');
    for (const item of whole) out.push('', ...itemLines(item, doc));
  }

  const pages = [...new Set(items.filter((i) => i.page !== null).map((i) => i.page as number))].sort((a, b) => a - b);
  for (const p of pages) {
    out.push('', `## Page ${p + 1}`);
    for (const item of items.filter((i) => i.page === p).sort(byReading)) out.push('', ...itemLines(item, doc));
  }
  return `${out.join('\n')}\n`;
}

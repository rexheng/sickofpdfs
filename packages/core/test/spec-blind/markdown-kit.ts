// Test support only (spec-blind tests for T2, the Markdown export). Written from the spec ("Export and import": "Export notes
// writes Markdown with quotes, page numbers and links back"), contracts section 5 ("Markdown export") and section 3 (replies
// cite with `[p. 4](cite:1)` and `[source](web:2)`), and the Phase 3 plan's "Test packs". It never saw the code.
//
// Two jobs:
//   1. ONE place that calls `exportMarkdown`, so a different argument shape is a one-line fix here. The contract gives
//      `exportMarkdown(doc, marks, threads, comments): string` and says the front matter holds a "source link" and that the
//      link back is "the canonical web link plus #page=N; for a file-only document the viewer link with doc and page". It does
//      not say where the export gets the document's links from. GUESS: the first argument is the document row plus where it
//      was seen (`locations`), and a fifth argument may carry the viewer page address. The adapter passes every plausible
//      shape at once; the triage trims it to the real one.
//   2. A small reader of the result: front matter, `## Page N` sections, blockquotes, YAML scalars. It reads what the text
//      IS, not which line a thing is on, so the export may lay its items out any way it likes.
import type { CommentRow, DocumentRow, LocationRow, MarkRow, ThreadRow } from '../../src/model/rows';
import * as markdown from '../../src/export/markdown';
import { deepFreeze, documentRow, locationRow } from './p3-rows';

// ---------------------------------------------------------------------------------------------------------------
// Calling the export

/** Where the document was seen: canonical links. `web` is an https link, `file` a file URL on the owner's computer. */
export interface SeenAt {
  web?: string | null;
  file?: string | null;
}

export interface ExportCase {
  doc?: DocumentRow;
  seen?: SeenAt;
  marks?: MarkRow[];
  threads?: ThreadRow[];
  comments?: CommentRow[];
}

/** The extension's viewer page, as `chrome.runtime.getURL('viewer.html')` would give it. */
export const VIEWER_BASE = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/viewer.html';

type ExportMarkdownFn = (doc: unknown, marks: readonly MarkRow[], threads: readonly ThreadRow[], comments: readonly CommentRow[]) => string;
const exportMarkdown = (markdown as Record<string, unknown>).exportMarkdown as ExportMarkdownFn;

export const WEB = 'https://example.org/papers/did.pdf';
export const FILE_URL = 'file:///C:/Users/ada/Private%20Folder/did.pdf';

/** Runs the export on deep-frozen inputs, so an export that edits what it was given throws. */
export function exportMd(c: ExportCase = {}): string {
  const row = c.doc ?? documentRow();
  const seen = c.seen ?? { web: WEB };
  const locations: LocationRow[] = [];
  if (seen.web) locations.push(locationRow(row.id, { kind: 'url', canonical: seen.web }));
  if (seen.file) locations.push(locationRow(row.id, { kind: 'file', canonical: seen.file }));
  const best = locations.find((l) => l.kind === 'url') ?? locations[0] ?? null;
  // triage: the export reads the document row plus `sourceLink` (the canonical link; only http(s) counts) and `viewerBase`.
  // The best location is passed as it is, so a file-only document hands over its file URL and the export must not write it.
  const docArg = { ...row, sourceLink: best?.canonical ?? null, viewerBase: VIEWER_BASE };
  const marks = c.marks ?? [];
  const threads = c.threads ?? [];
  const comments = c.comments ?? [];
  deepFreeze(docArg);
  deepFreeze(marks);
  deepFreeze(threads);
  deepFreeze(comments);
  return exportMarkdown(docArg, marks, threads, comments);
}

// ---------------------------------------------------------------------------------------------------------------
// Reading the result

export interface Section {
  page: number;
  /** The heading line and everything under it, up to the next heading of level 1 or 2. */
  text: string;
}

export interface Parsed {
  /** The text between the opening `---` and the closing `---`, or null when the export has no front matter. */
  front: string | null;
  /** Everything after the front matter. */
  body: string;
  /** Body lines before the first `## Page N` heading. */
  preface: string;
  sections: Section[];
  /** Every line of the body that starts with one or two `#` and a space: the document's own structure. */
  headings: string[];
}

const PAGE_HEADING = /^##[ \t]+\[?[ \t]*Page[ \t]+(\d+)\b/;
const TOP_HEADING = /^#{1,2}[ \t]/;

export function parse(md: string): Parsed {
  const lines = md.split('\n');
  let front: string | null = null;
  let bodyStart = 0;
  if (lines[0]?.trim() === '---') {
    const close = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
    if (close > 0) {
      front = lines.slice(1, close).join('\n');
      bodyStart = close + 1;
    }
  }
  const body = lines.slice(bodyStart);
  const sections: Section[] = [];
  const preface: string[] = [];
  let cur: { page: number; lines: string[] } | null = null;
  const headings: string[] = [];
  for (const line of body) {
    if (TOP_HEADING.test(line)) headings.push(line);
    const page = PAGE_HEADING.exec(line);
    if (page) {
      if (cur) sections.push({ page: cur.page, text: cur.lines.join('\n') });
      cur = { page: Number(page[1]), lines: [line] };
    } else if (TOP_HEADING.test(line)) {
      if (cur) sections.push({ page: cur.page, text: cur.lines.join('\n') });
      cur = null;
    } else if (cur) {
      cur.lines.push(line);
    } else {
      preface.push(line);
    }
  }
  if (cur) sections.push({ page: cur.page, text: cur.lines.join('\n') });
  return { front, body: body.join('\n'), preface: preface.join('\n'), sections, headings };
}

/** The `## Page N` headings, in the order they appear. */
export const pageNumbers = (p: Parsed): number[] => p.sections.map((s) => s.page);

export function sectionOf(p: Parsed, page: number): Section {
  const s = p.sections.find((x) => x.page === page);
  if (!s) throw new Error(`no "## Page ${page}" section; the export has ${p.sections.map((x) => `Page ${x.page}`).join(', ') || 'no page sections'}`);
  return s;
}

/** The lines of `text` that are blockquote lines, without their `>` marks. */
export function quotePayloads(text: string): string[] {
  return text
    .split('\n')
    .filter((l) => /^[ \t]{0,3}>/.test(l))
    .map((l) => l.replace(/^[ \t]{0,3}(?:>[ \t]?)+/, ''));
}

/** `text` with blockquote marks gone and every run of white space made one space, to compare words and not layout. */
export const words = (text: string): string => text.replace(/^[ \t]{0,3}(?:>[ \t]?)+/gm, '').replace(/\s+/g, ' ').trim();

/** Undoes Markdown backslash escapes and the few HTML entities an escaper may use. */
export function unescapeMd(s: string): string {
  return s
    .replace(/\\([!-/:-@[-`{-~])/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&amp;/g, '&');
}

// ---------------------------------------------------------------------------------------------------------------
// Front matter as YAML (just enough of it: top-level keys with a scalar, a flow list, a block list or a nested block)

export interface FrontKey {
  /** The text after `key:` on its own line. */
  raw: string;
  /** The indented or `- ` lines under it. */
  block: string[];
}

/** The top-level keys of a front-matter block. Throws on a line that cannot belong to a YAML mapping. */
export function frontKeys(front: string): Map<string, FrontKey> {
  const keys = new Map<string, FrontKey>();
  let cur: FrontKey | null = null;
  for (const line of front.split('\n')) {
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    const key = /^([A-Za-z_][\w.-]*):(?:[ \t]+(.*))?$/.exec(line);
    if (key) {
      cur = { raw: (key[2] ?? '').trim(), block: [] };
      keys.set(key[1], cur);
    } else if (cur && (/^[ \t]+\S/.test(line) || /^-[ \t]/.test(line))) {
      cur.block.push(line);
    } else {
      throw new Error(`front matter line is not valid YAML mapping content: ${JSON.stringify(line)}`);
    }
  }
  return keys;
}

/** Reads one YAML scalar the way a YAML reader would. Throws when the text is not a valid scalar (it would break the file). */
export function decodeScalar(raw: string, block: readonly string[] = []): string {
  const t = raw.trim();
  if (t.startsWith('"')) {
    if (t.length < 2 || !t.endsWith('"')) throw new Error(`double-quoted scalar does not end: ${raw}`);
    return JSON.parse(t) as string;
  }
  if (t.startsWith("'")) {
    if (t.length < 2 || !t.endsWith("'")) throw new Error(`single-quoted scalar does not end: ${raw}`);
    return t.slice(1, -1).replace(/''/g, "'");
  }
  if (/^[|>]/.test(t)) {
    const folded = t.startsWith('>');
    const lines = block.map((l) => l.replace(/^[ \t]+/, ''));
    return lines.join(folded ? ' ' : '\n');
  }
  if (/^([[\]{},#&*!|>'"%@`]|[-?:](\s|$))/.test(t) || /:\s/.test(t) || /\s#/.test(t) || t.endsWith(':')) {
    throw new Error(`plain scalar is not valid YAML (needs quotes): ${raw}`);
  }
  return t;
}

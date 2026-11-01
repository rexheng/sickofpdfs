/**
 * A small Markdown reader for note and reply bodies. It returns a tree of plain objects that MarkdownBody turns into
 * React elements, so nothing is ever put into innerHTML: bodies can come from Claude or from claude.ai (contracts:
 * "the UI never renders them as HTML").
 *
 * It reads the light Markdown a note uses: paragraphs, line breaks (one Enter or Shift+Enter is one line break), bullet
 * and numbered lists, quotes, headings (drawn as bold lines), fenced code, and inline **bold**, *italic*, ~~strike~~,
 * `code`, [links](https://…) and bare https:// links. `[p. 4](cite:1)` and `[source](web:2)` become chips. A link to
 * any other scheme keeps its text and drops its target.
 */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'br' }
  | { t: 'strong' | 'em' | 'del'; c: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'link'; href: string; c: Inline[] }
  | { t: 'chip'; kind: 'cite' | 'web'; n: number; label: string };

export type Block =
  | { t: 'p' | 'h'; c: Inline[] }
  | { t: 'ul'; items: Inline[][] }
  | { t: 'ol'; start: number; items: Inline[][] }
  | { t: 'quote'; c: Block[] }
  | { t: 'pre'; v: string };

/** Nesting limits: quotes inside quotes, and emphasis inside emphasis. Deeper input reads as plain text. */
const MAX_QUOTE_DEPTH = 3;
const MAX_INLINE_DEPTH = 6;

const FENCE = /^\s{0,3}```/u;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/u;
const QUOTE = /^\s{0,3}>\s?(.*)$/u;
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/u;
const NUMBERED = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/u;
const CONTINUATION = /^\s+\S/u;

export function parseMarkdown(source: string): Block[] {
  return parseBlocks(source.replace(/\r\n?/gu, '\n').split('\n'), 0);
}

function parseBlocks(lines: string[], depth: number): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: { t: 'ul' | 'ol'; start: number; items: string[] } | null = null;

  const endParagraph = () => {
    if (paragraph.length > 0) blocks.push({ t: 'p', c: parseInline(paragraph.join('\n')) });
    paragraph = [];
  };
  const endList = () => {
    if (list === null) return;
    const items = list.items.map((item) => parseInline(item));
    blocks.push(list.t === 'ul' ? { t: 'ul', items } : { t: 'ol', start: list.start, items });
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    if (FENCE.test(line)) {
      endParagraph();
      endList();
      const code: string[] = [];
      for (i++; i < lines.length && !FENCE.test(lines[i] ?? ''); i++) code.push(lines[i] ?? '');
      blocks.push({ t: 'pre', v: code.join('\n') });
      continue;
    }
    if (line.trim() === '') {
      endParagraph();
      endList();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      endParagraph();
      endList();
      blocks.push({ t: 'h', c: parseInline(heading[1] ?? '') });
      continue;
    }
    if (depth < MAX_QUOTE_DEPTH && QUOTE.test(line)) {
      endParagraph();
      endList();
      const inner: string[] = [];
      for (; i < lines.length; i++) {
        const quoted = QUOTE.exec(lines[i] ?? '');
        if (!quoted) break;
        inner.push(quoted[1] ?? '');
      }
      i--;
      blocks.push({ t: 'quote', c: parseBlocks(inner, depth + 1) });
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (bullet || numbered) {
      endParagraph();
      const kind = bullet ? 'ul' : 'ol';
      if (list === null || list.t !== kind) {
        endList();
        list = { t: kind, start: numbered ? Number(numbered[1]) : 1, items: [] };
      }
      list.items.push((bullet ? bullet[1] : numbered?.[2]) ?? '');
      continue;
    }
    if (list !== null && CONTINUATION.test(line)) {
      list.items[list.items.length - 1] += `\n${line.trim()}`;
      continue;
    }
    endList();
    paragraph.push(line);
  }
  endParagraph();
  endList();
  return blocks;
}

const ESCAPABLE = /[\\`*_~[\]()#>!+\-.|{}]/u;
const AUTOLINK = /^https?:\/\/[^\s<>"]+/iu;
const WORD = /[\p{L}\p{N}]/u;
const CHIP = /^(cite|web):(\d{1,6})$/u;
const SAFE_HREF = /^(https?:\/\/|mailto:)/iu;

export function parseInline(source: string, depth = 0, links = true): Inline[] {
  const out: Inline[] = [];
  // For each emphasis mark, the earliest start from which a search for its closer already failed. A later search
  // only looks at a subset of those positions, so it would fail too: this keeps runs of stray marks fast.
  const noCloser = new Map<string, number>();
  let text = '';
  const push = (...nodes: Inline[]) => {
    if (text !== '') out.push({ t: 'text', v: text });
    text = '';
    out.push(...nodes);
  };

  let i = 0;
  while (i < source.length) {
    const ch = source[i] ?? '';
    const next = source[i + 1] ?? '';

    if (ch === '\\' && ESCAPABLE.test(next)) {
      text += next;
      i += 2;
      continue;
    }
    if (ch === '\n') {
      push({ t: 'br' });
      i++;
      continue;
    }
    if (ch === '`') {
      const code = matchCode(source, i);
      if (code) {
        push(code.node);
        i = code.end;
      } else {
        const run = runLength(source, i, '`');
        text += source.slice(i, i + run);
        i += run;
      }
      continue;
    }
    if (ch === '[' && links) {
      const link = matchLink(source, i, depth);
      if (link) {
        push(...link.nodes);
        i = link.end;
        continue;
      }
    }
    if ((ch === 'h' || ch === 'H') && links && !WORD.test(source[i - 1] ?? ' ')) {
      const url = matchAutolink(source, i);
      if (url) {
        push({ t: 'link', href: url, c: [{ t: 'text', v: url }] });
        i += url.length;
        continue;
      }
    }
    if ((ch === '*' || ch === '_' || ch === '~') && depth < MAX_INLINE_DEPTH) {
      const emphasis = matchEmphasis(source, i, depth, links, noCloser);
      if (emphasis) {
        push(emphasis.node);
        i = emphasis.end;
        continue;
      }
    }
    text += ch;
    i++;
  }
  push();
  return out;
}

function runLength(s: string, at: number, ch: string): number {
  let n = 0;
  while (s[at + n] === ch) n++;
  return n;
}

/** `code`, ``code with a ` inside``: the closing run has the same length as the opening one. */
function matchCode(s: string, at: number): { node: Inline; end: number } | null {
  const run = runLength(s, at, '`');
  for (let j = s.indexOf('`', at + run); j !== -1; j = s.indexOf('`', j + runLength(s, j, '`'))) {
    if (runLength(s, j, '`') === run) {
      let v = s.slice(at + run, j).replace(/\n/gu, ' ');
      if (v.length > 2 && v.startsWith(' ') && v.endsWith(' ')) v = v.slice(1, -1);
      return v === '' ? null : { node: { t: 'code', v }, end: j + run };
    }
  }
  return null;
}

/** `[text](target)`. Returns the nodes to draw in its place: a link, a chip, or only the text (unsafe target). */
function matchLink(s: string, at: number, depth: number): { nodes: Inline[]; end: number } | null {
  const close = matchBracket(s, at, '[', ']');
  if (close === -1 || s[close + 1] !== '(') return null;
  const end = matchBracket(s, close + 1, '(', ')');
  if (end === -1) return null;
  const label = s.slice(at + 1, close);
  // An optional title after the target ("…" or '…') is read and dropped.
  const target = s.slice(close + 2, end).trim().replace(/\s+(["']).*\1$/u, '').replace(/^<(.*)>$/u, '$1');
  const chip = CHIP.exec(target);
  if (chip) {
    const kind = chip[1] === 'cite' ? 'cite' : 'web';
    return { nodes: [{ t: 'chip', kind, n: Number(chip[2]), label: plainText(label) || `${chip[2]}` }], end: end + 1 };
  }
  const inner = parseInline(label, depth + 1, false);
  if (SAFE_HREF.test(target)) return { nodes: [{ t: 'link', href: target, c: inner }], end: end + 1 };
  return { nodes: inner, end: end + 1 };
}

/** The index of the bracket that closes the one at `at`, or -1. Escaped brackets do not count. */
function matchBracket(s: string, at: number, open: string, close: string): number {
  let level = 0;
  for (let j = at; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') {
      j++;
      continue;
    }
    if (c === open) level++;
    else if (c === close && --level === 0) return j;
  }
  return -1;
}

/** A bare https:// link. Trailing punctuation and an unbalanced closing bracket stay outside the link. */
function matchAutolink(s: string, at: number): string | null {
  const m = AUTOLINK.exec(s.slice(at));
  if (!m) return null;
  let url = m[0];
  for (;;) {
    const last = url.at(-1) ?? '';
    if ('.,;:!?\'"*_~'.includes(last)) url = url.slice(0, -1);
    else if (last === ')' && count(url, '(') < count(url, ')')) url = url.slice(0, -1);
    else if (last === ']' && count(url, '[') < count(url, ']')) url = url.slice(0, -1);
    else break;
  }
  return /^https?:\/\/[^/]+/iu.test(url) ? url : null;
}

function count(s: string, ch: string): number {
  return s.split(ch).length - 1;
}

/** **strong**, __strong__, *em*, _em_ and ~~del~~. An underscore inside a word (snake_case) stays a character. */
function matchEmphasis(
  s: string,
  at: number,
  depth: number,
  links: boolean,
  noCloser: Map<string, number>,
): { node: Inline; end: number } | null {
  const ch = s[at] ?? '';
  const double = s[at + 1] === ch;
  if (ch === '~' && !double) return null;
  const mark = double ? ch + ch : ch;
  const start = at + mark.length;
  const first = s[start];
  if (first === undefined || /\s/u.test(first)) return null;
  if (ch === '_' && WORD.test(s[at - 1] ?? ' ')) return null;
  if (start >= (noCloser.get(mark) ?? Infinity)) return null;

  for (let j = s.indexOf(mark, start + 1); j !== -1; j = s.indexOf(mark, j + 1)) {
    if (/\s/u.test(s[j - 1] ?? ' ')) continue;
    // a single * or _ must not be half of a double one (that belongs to a strong span)
    if (!double && (s[j + 1] === ch || s[j - 1] === ch)) continue;
    if (ch === '_' && WORD.test(s[j + mark.length] ?? ' ')) continue;
    const inner = parseInline(s.slice(start, j), depth + 1, links);
    const t = ch === '~' ? 'del' : double ? 'strong' : 'em';
    return { node: { t, c: inner }, end: j + mark.length };
  }
  noCloser.set(mark, Math.min(start, noCloser.get(mark) ?? Infinity));
  return null;
}

/** The visible text of a Markdown fragment, for chip labels and accessible names. */
export function plainText(source: string): string {
  return flatten(parseInline(source, 0)).trim();
}

function flatten(nodes: Inline[]): string {
  return nodes
    .map((n) => {
      switch (n.t) {
        case 'text':
        case 'code':
          return n.v;
        case 'br':
          return ' ';
        case 'chip':
          return n.label;
        default:
          return flatten(n.c);
      }
    })
    .join('');
}

/** One line of a body for a label or a preview: Markdown marks dropped, line breaks as spaces. */
export function summarise(source: string): string {
  return parseMarkdown(source)
    .map((b) => blockText(b))
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function blockText(b: Block): string {
  switch (b.t) {
    case 'p':
    case 'h':
      return flatten(b.c);
    case 'ul':
    case 'ol':
      return b.items.map(flatten).join(' ');
    case 'quote':
      return b.c.map(blockText).join(' ');
    case 'pre':
      return b.v;
  }
}

// A note's Markdown as plain text, for the places that cannot show Markdown: a PDF annotation's /Contents (contracts §9)
// and Phase 3's Markdown export, which reuses it for quotes and snippets.
//
// - `[p. 4](cite:1)` becomes "(p. N)": N is the cited page when the citation is known, else the page in the link's text.
// - `[source](web:2)` becomes the URL of web source 2.
// - Other links become "text (url)", images their alt text, code its content, and the marks (#, *, _, ~~, `, >) go away.
// - Lists keep their "- " and "1. " leaders, table rows read "a | b", and blank lines separate paragraphs.
//
// And the other way: `plainToMarkdown` escapes a PDF's plain text so that it reads as typed (import).
import type { CommentRow } from '../model/rows';

export interface NoteTextRefs {
  /** `n` and the 0-based page of a citation (ClaudeReplyMeta.citations). */
  citations?: readonly { n: number; pageIndex: number }[];
  /** `n` and the address of a web source (ClaudeReplyMeta.webSources). */
  webSources?: readonly { n: number; url: string }[];
}

const CITE = /^cite:(\d+)$/;
const WEB = /^web:(\d+)$/;

/** One Markdown link or image: `[text](target)` / `![alt](target)`. The text may hold one level of brackets. */
const LINK = /(!?)\[((?:[^[\]\\]|\\.|\[[^\]]*\])*)\]\(\s*<?([^()\s>]*(?:\([^()]*\)[^()\s>]*)*)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;

/** Text set aside while the marks around it are read (escaped characters, code), put back at the end of the line. */
type Stash = string[];
const hold = (stash: Stash, text: string): string => `\uE000${stash.push(text) - 1}\uE001`;
const release = (stash: Stash, text: string): string => {
  let s = text;
  // a held piece may itself hold others (a code span inside a link's text), so go until nothing is left
  for (let guard = 0; guard < 8 && /\uE000\d+\uE001/.test(s); guard++) s = s.replace(/\uE000(\d+)\uE001/g, (_m, n: string) => stash[Number(n)] ?? '');
  return s;
};

function linkText(bang: string, label: string, target: string, refs: NoteTextRefs | undefined, stash: Stash): string {
  if (bang === '!') return inline(label, refs, stash);
  const cite = CITE.exec(target);
  if (cite) {
    const n = Number(cite[1]);
    const known = refs?.citations?.find((c) => c.n === n);
    if (known) return `(p. ${known.pageIndex + 1})`;
    const fromLabel = /(\d+)/.exec(label);
    return fromLabel ? `(p. ${fromLabel[1]})` : `(${inline(label, refs, stash)})`;
  }
  const web = WEB.exec(target);
  if (web) {
    const n = Number(web[1]);
    const known = refs?.webSources?.find((s) => s.n === n);
    return known ? hold(stash, known.url) : inline(label, refs, stash);
  }
  const text = inline(label, refs, stash);
  if (!target || release(stash, text) === target) return text || hold(stash, target);
  return text ? `${text} (${hold(stash, target)})` : hold(stash, target);
}

/** Inline marks: backslash escapes and code are set aside, then links (their text may carry marks), emphasis and strikethrough. */
function inline(src: string, refs: NoteTextRefs | undefined, stash: Stash): string {
  let s = src.replace(/\\([\\`*_{}[\]()#+\-.!|<>~])/g, (_m, c: string) => hold(stash, c));
  s = s.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_m, _t: string, code: string) => hold(stash, code));
  s = s.replace(LINK, (_m, bang: string, label: string, target: string) => linkText(bang, label, target, refs, stash));
  s = s.replace(/<(https?:[^>\s]+)>/g, (_m, u: string) => hold(stash, u));
  s = s.replace(/<\/?[A-Za-z][^>]*>/g, '');
  s = s.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2');
  s = s.replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, '$1$2');
  s = s.replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1$2');
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1');
  return s;
}

/** Markdown to plain text. Never throws; text with no Markdown comes back as it was (trimmed, line ends as \n). */
export function noteText(markdown: string, refs?: NoteTextRefs): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let fence: string | null = null;
  for (const raw of lines) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(raw);
    if (fence !== null) {
      const closing = fenceMatch?.[1] ?? '';
      if (closing !== '' && closing.startsWith(fence.charAt(0)) && closing.length >= fence.length) fence = null;
      else out.push(raw);
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1]!;
      continue;
    }
    let line = raw;
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line) || /^\s{0,3}(=+|-+)\s*$/.test(line)) continue; // rules and setext underlines
    if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes('|')) continue; // a table's separator row
    line = line.replace(/^\s{0,3}#{1,6}\s+/, '').replace(/\s+#+\s*$/, '');
    line = line.replace(/^(\s*)>\s?/g, '$1').replace(/^(\s*)>\s?/g, '$1');
    line = line.replace(/^(\s*)[*+]\s+/, '$1- ');
    line = line.replace(/^(\s*)- \[( |x|X)\]\s+/, '$1- ');
    if (line.includes('|') && /^\s*\|.*\|\s*$/.test(line)) {
      line = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()).join(' | ');
    }
    const stash: Stash = [];
    out.push(release(stash, inline(line, refs, stash)));
  }
  return out.join('\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** A comment's plain text: its Markdown body with the citations and web sources of its Claude-reply meta resolved. */
export function commentPlainText(c: Pick<CommentRow, 'body' | 'meta'>): string {
  const meta = c.meta as { citations?: { n: number; pageIndex: number }[]; webSources?: { n: number; url: string }[] };
  return noteText(c.body, { citations: meta.citations, webSources: meta.webSources });
}

/** Plain text escaped so a Markdown reader shows exactly it: `noteText(plainToMarkdown(t)) === t` for text without trailing spaces. */
export function plainToMarkdown(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\\`*_{}[\]<>~|]/g, (c) => `\\${c}`)
    .replace(/^(\s*)([#>+-])/gm, '$1\\$2')
    .replace(/^(\s*\d+)([.)])(\s)/gm, '$1\\$2$3');
}

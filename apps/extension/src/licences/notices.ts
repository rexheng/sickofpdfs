// Reads THIRD_PARTY_NOTICES.txt (scripts/third-party-notices.mjs writes it) into parts the licences page can lay out:
// the opening words, then one entry per component with its facts and its licence texts. The file stays the one source:
// the page only reads it, so the build's completeness check still covers what the owner sees.

/** A block of the opening words: a paragraph, or a list of short lines. */
export type IntroBlock = { kind: 'paragraph'; text: string } | { kind: 'list'; items: string[] };

export interface NoticeEntry {
  /** Its number in the file, from 1. */
  index: number;
  name: string;
  /** "Version", "Licence", "What it is", "Source", "Note", in the file's order. */
  facts: { label: string; value: string }[];
  texts: { label: string; body: string }[];
}

export interface Notices {
  /** "sickofpdfs 0.1.0". */
  product: string;
  intro: IntroBlock[];
  entries: NoticeEntry[];
}

const RULE = '='.repeat(78);
const THIN = '-'.repeat(78);

/** The opening words, which the file wraps at about 90 characters: lines rejoined into paragraphs, "  - " lines as lists. */
function introBlocks(lines: readonly string[]): IntroBlock[] {
  const blocks: IntroBlock[] = [];
  let words: string[] = [];
  let items: string[] = [];
  const flush = () => {
    if (words.length > 0) blocks.push({ kind: 'paragraph', text: words.join(' ') });
    if (items.length > 0) blocks.push({ kind: 'list', items });
    words = [];
    items = [];
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const item = /^\s+-\s+(.*)$/u.exec(line);
    if (line.trim() === '') flush();
    else if (item !== null) {
      if (words.length > 0) {
        blocks.push({ kind: 'paragraph', text: words.join(' ') });
        words = [];
      }
      items.push(item[1] ?? '');
    } else {
      if (items.length > 0) {
        blocks.push({ kind: 'list', items });
        items = [];
      }
      words.push(line.trim());
    }
  }
  flush();
  return blocks;
}

/** One component's part of the file, from its "N. name" line to the next rule. */
function entryOf(chunk: string): NoticeEntry | null {
  const lines = chunk.split('\n');
  const head = /^(\d+)\.\s+(.+)$/u.exec(lines[0] ?? '');
  if (head === null) return null;
  const facts: NoticeEntry['facts'] = [];
  let at = 1;
  for (; at < lines.length && lines[at] !== ''; at++) {
    const fact = /^([^:]+):\s?(.*)$/u.exec(lines[at] ?? '');
    if (fact !== null) facts.push({ label: fact[1] ?? '', value: fact[2] ?? '' });
  }
  const texts: NoticeEntry['texts'] = [];
  // Each licence text: a thin rule, "Licence text: <label>", a thin rule, then the text up to the next thin rule.
  for (; at < lines.length; at++) {
    if (lines[at] !== THIN || lines[at + 2] !== THIN) continue;
    const label = (lines[at + 1] ?? '').replace(/^Licence text:\s*/u, '');
    let end = at + 3;
    while (end < lines.length && lines[end] !== THIN) end++;
    texts.push({ label, body: lines.slice(at + 3, end).join('\n').replace(/\s+$/u, '') });
    at = end - 1;
  }
  return { index: Number(head[1]), name: head[2] ?? '', facts, texts };
}

/** The notices file, read into its parts. */
export function parseNotices(file: string): Notices {
  const text = file.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n');
  const [front = '', ...chunks] = text.split(`\n${RULE}\n`);
  const lines = front.split('\n');
  const contents = lines.findIndex((l) => /^CONTENTS \(\d+ items\)$/u.test(l));
  return {
    product: lines[1] ?? '',
    intro: introBlocks(lines.slice(2, contents < 0 ? lines.length : contents)),
    entries: chunks.map(entryOf).filter((e): e is NoticeEntry => e !== null),
  };
}

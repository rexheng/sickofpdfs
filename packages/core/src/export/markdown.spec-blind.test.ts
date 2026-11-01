// Spec-blind table tests for exportMarkdown (Phase 3, pack T2): how a document's marks, comment threads and replies become the
// Markdown file that Ctrl+Shift+E saves and the backup folder keeps.
//
// Sources: spec "Export and import" ("Export notes writes Markdown with quotes, page numbers and links back"), "What a note is
// made of" (a thread holds comments with author, Markdown body and times; "removing a style never removes a comment"), "Library
// and knowledge base" (identity and canonical links), "Backups" (notes as Markdown go into the backup folder), the contracts'
// shared rule that PDF text, quotes and titles are untrusted, section 3 (a reply cites with `[p. 4](cite:1)` and
// `[source](web:2)`; "Export rewrites them"), section 4 (a soft delete hides a row until Trash restores it) and section 5
// ("Markdown export": front matter; one `## Page N` section per page; the quote as a blockquote, a style label, the comment and
// its replies; bold quotes `**...**`, strikethrough `~~...~~`, highlight and underline get a label; `cite:n` becomes "p. N" with
// a link back, `web:n` the source's URL; the link back is the canonical web link plus `#page=N`, for a file-only document the
// viewer link with `doc` and `page`), CLAUDE.md ("no network traffic except what the owner turns on", "plain, clear wording").
//
// How the tests read the result (see the kit): by what the text IS. They find the `## Page N` sections and look inside them, so
// the export may lay an item out any way it likes. Every input is deep-frozen, so an export that edits its input throws.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Anchor } from '../model/anchor';
import {
  DOC,
  MIN,
  T0,
  claudeMeta,
  commentRow,
  documentRow,
  markRow,
  textAnchor,
  threadRow,
} from '../../test/spec-blind/p3-rows';
import {
  FILE_URL,
  WEB,
  decodeScalar,
  exportMd,
  frontKeys,
  pageNumbers,
  parse,
  quotePayloads,
  sectionOf,
  unescapeMd,
  words,
  type ExportCase,
} from '../../test/spec-blind/markdown-kit';

afterEach(() => {
  vi.useRealTimers();
});

describe('front matter', () => {
  const ARXIV = documentRow(DOC, { title: 'Attention Is All You Need', authors: ['Ashish Vaswani'], doi: null, arxivId: '1706.03762', year: 2017 });
  const BARE = documentRow(DOC, { title: null, authors: [], doi: null, arxivId: null, year: null });

  const cases: { name: string; c: ExportCase; has: string[]; hasNot: RegExp[] }[] = [
    {
      name: 'a web paper with a DOI',
      c: { seen: { web: WEB } },
      has: ['Do Parallel Trends Hold?', 'Ada Lovelace', 'Alan Turing', '10.1257/aer.20180779', WEB],
      hasNot: [],
    },
    {
      name: 'an arXiv paper',
      c: { doc: ARXIV, seen: { web: 'https://example.org/papers/attn.pdf' } },
      has: ['Attention Is All You Need', 'Ashish Vaswani', '1706.03762'],
      hasNot: [/10\.\d{4}/],
    },
    {
      name: 'a file with no title, authors or ids',
      c: { doc: BARE, seen: { file: FILE_URL } },
      has: [DOC],
      hasNot: [],
    },
  ];

  it.each(cases)('$name: the facts are there, the empty ones are not written as "null"', ({ c, has, hasNot }) => {
    const md = exportMd(c);
    const p = parse(md);
    expect(p.front, 'the export starts with a --- front-matter block').not.toBeNull();
    const front = p.front ?? '';
    for (const s of has) expect(front, `front matter holds ${s}`).toContain(s);
    for (const re of hasNot) expect(front).not.toMatch(re);
    expect(front, 'an empty field is left out, not written as null or undefined').not.toMatch(/\bnull\b|undefined|\[object/);
    // the block is a valid YAML mapping, and says which document and which format this is (contracts section 5)
    const keys = frontKeys(front);
    const s = keys.get('sickofpdfs');
    expect(s, 'a sickofpdfs key').toBeDefined();
    const inner = [s?.raw ?? '', ...(s?.block ?? [])].join('\n');
    expect(inner).toMatch(new RegExp(`documentId:\\s*["']?${DOC}["']?`));
    expect(inner).toMatch(/format:\s*1\b/);
  });

  it('keeps the authors in the order they are stored', () => {
    const front = parse(exportMd()).front ?? '';
    expect(front.indexOf('Ada Lovelace')).toBeGreaterThan(-1);
    expect(front.indexOf('Ada Lovelace')).toBeLessThan(front.indexOf('Alan Turing'));
  });

  it('a hostile title cannot break the front matter: it is quoted, and it cannot add keys or end the block early', () => {
    // A PDF's title is untrusted text. A colon, a quote, a hash, a bracket, a leading dash and a line break are all YAML syntax.
    const hostile = 'Attention: "Is All" # You [Need] - {x} & *y*\n---\nevil: yes';
    const md = exportMd({ doc: documentRow(DOC, { title: hostile }) });
    const p = parse(md);
    const front = p.front ?? '';
    const keys = frontKeys(front); // throws if any line is not valid mapping content
    expect(keys.has('evil'), 'text from the title became a key').toBe(false);
    expect(keys.get('sickofpdfs'), 'the block ended early: the sickofpdfs key is not inside it').toBeDefined();
    const title = keys.get('title');
    expect(title, 'a title key').toBeDefined();
    // white space may be tidied (a title is one line), but not one word changed
    expect(decodeScalar(title?.raw ?? '', title?.block ?? []).replace(/\s+/g, ' ')).toBe(hostile.replace(/\s+/g, ' '));
  });
});

describe('pages', () => {
  it('one "## Page N" section per page that has notes: 1-based, in page order, whatever order the rows come in', () => {
    const marks = [
      markRow({ id: 'm-late', page: 11, quote: 'LATEQUOTE' }),
      markRow({ id: 'm-first', page: 0, quote: 'FIRSTQUOTE' }),
      markRow({ id: 'm-mid', page: 3, quote: 'MIDQUOTE' }),
    ];
    const p = parse(exportMd({ marks }));
    expect(pageNumbers(p)).toEqual([1, 4, 12]);
    expect(sectionOf(p, 1).text).toContain('FIRSTQUOTE');
    expect(sectionOf(p, 4).text).toContain('MIDQUOTE');
    expect(sectionOf(p, 12).text).toContain('LATEQUOTE');
    expect(sectionOf(p, 4).text, 'a quote stays in its own page').not.toContain('FIRSTQUOTE');
  });

  it('a mark that runs across two pages is listed once, under the page where it starts', () => {
    const anchor = textAnchor(2, 'ACROSSQUOTE', { endPage: 3 });
    const md = exportMd({ marks: [markRow({ id: 'm-across', page: 2, anchor })] });
    const p = parse(md);
    expect(pageNumbers(p)).toEqual([3]);
    expect(md.split('ACROSSQUOTE')).toHaveLength(2);
  });

  it('inside a page, items follow reading order (top to bottom), and a comment stays with its own quote', () => {
    const marks = [
      markRow({ id: 'm3', page: 4, sortKey: 0.8, style: 'highlight', quote: 'THIRDWORD' }),
      markRow({ id: 'm2', page: 4, sortKey: 0.4, style: 'underline', quote: 'SECONDWORD' }),
    ];
    const threads = [threadRow({ id: 't1', page: 4, sortKey: 0.1, quote: 'FIRSTWORD' })];
    const comments = [commentRow({ id: 'c1', threadId: 't1', body: 'FIRSTBODY' })];
    const text = sectionOf(parse(exportMd({ marks, threads, comments })), 5).text;
    const at = (s: string) => text.indexOf(s);
    expect(at('FIRSTWORD')).toBeGreaterThan(-1);
    expect(at('FIRSTWORD')).toBeLessThan(at('FIRSTBODY'));
    expect(at('FIRSTBODY')).toBeLessThan(at('SECONDWORD'));
    expect(at('SECONDWORD')).toBeLessThan(at('THIRDWORD'));
  });

  it('with no notes there is front matter and no page sections; so is a document whose notes are all deleted', () => {
    const empty = parse(exportMd());
    expect(empty.front).not.toBeNull();
    expect(empty.sections).toEqual([]);
    const gone = parse(
      exportMd({
        marks: [markRow({ id: 'm', page: 0, quote: 'GONEMARK', deletedAt: T0 + MIN })],
        threads: [threadRow({ id: 't', page: 1, quote: 'GONEQUOTE', deletedAt: T0 + MIN })],
        comments: [commentRow({ id: 'c', threadId: 't', body: 'GONEBODY' })],
      }),
    );
    expect(gone.sections).toEqual([]);
    expect(gone.body).not.toMatch(/GONE/);
  });
});

describe('what each kind of note looks like', () => {
  const styleCases = [
    { name: 'highlight', style: 'highlight', label: /highlight/i, wrap: null },
    { name: 'underline', style: 'underline', label: /underline/i, wrap: null },
    { name: 'bold', style: 'bold', label: null, wrap: '**' },
    { name: 'strikethrough', style: 'strike', label: null, wrap: '~~' },
  ] as const;

  it.each(styleCases)('$name: the quote is a blockquote and the style shows', ({ name, style, label, wrap }) => {
    // the quote must not contain the style's own name, or the label test would pass on the quote alone
    const quote = `Quoted passage ${name.length}`;
    const text = sectionOf(parse(exportMd({ marks: [markRow({ id: 'm', page: 0, style, quote })] })), 1).text;
    const payloads = quotePayloads(text);
    if (wrap) {
      // "Bold quotes render as **...** and strikethrough as ~~...~~"
      expect(payloads.some((l) => l.includes(`${wrap}${quote}${wrap}`)), `a blockquote line with ${wrap}${quote}${wrap}`).toBe(true);
    } else {
      // "Highlight and underline get a label"; the quote itself stays plain
      expect(payloads.some((l) => l.includes(quote)), 'a blockquote line with the quote').toBe(true);
      expect(text).toMatch(label);
      expect(payloads.join('\n')).not.toMatch(/\*\*|~~/);
    }
  });

  it('a highlight is not labelled as underline, and the other way round', () => {
    const marks = [markRow({ id: 'h', page: 0, style: 'highlight', quote: 'HQ' }), markRow({ id: 'u', page: 1, style: 'underline', quote: 'UQ' })];
    const p = parse(exportMd({ marks }));
    expect(sectionOf(p, 1).text).not.toMatch(/underline/i);
    expect(sectionOf(p, 2).text).not.toMatch(/highlight/i);
  });

  const figure: Anchor = {
    kind: 'figure',
    page: 1,
    rect: [0.1, 0.2, 0.9, 0.6],
    figure: { label: 'Figure 3', captionQuote: null, imageSha256: null, dHash: '0'.repeat(16), detector: 'caption', detectorVersion: '1' },
  };
  const anchorCases: { name: string; page: number; anchor: Anchor }[] = [
    { name: 'a figure', page: 1, anchor: figure },
    { name: 'a point', page: 2, anchor: { kind: 'point', page: 2, point: [0.4, 0.5] } },
    { name: 'a whole page', page: 3, anchor: { kind: 'page', page: 3 } },
    { name: 'an area', page: 4, anchor: { kind: 'area', page: 4, rect: [0.1, 0.1, 0.5, 0.5], dHash: '0'.repeat(16) } },
  ];

  it.each(anchorCases)('a note on $name has no quote, and still lands on its page with its text', ({ page, anchor }) => {
    const threads = [threadRow({ id: 't', page, sortKey: 0.3, anchor })];
    const comments = [commentRow({ id: 'c', threadId: 't', body: 'NOQUOTENOTE' })];
    const md = exportMd({ threads, comments });
    expect(sectionOf(parse(md), page + 1).text).toContain('NOQUOTENOTE');
    expect(md).not.toMatch(/\bundefined\b|\[object|\bNaN\b/);
  });

  it('an area mark appears on its page and says it is an area', () => {
    const md = exportMd({ marks: [markRow({ id: 'a', page: 5, style: 'area' })] });
    expect(sectionOf(parse(md), 6).text).toMatch(/area/i);
    expect(md).not.toMatch(/\bundefined\b|\[object|\bNaN\b/);
  });

  it('a note on the whole document is in the file but not under any page', () => {
    const threads = [threadRow({ id: 'td', page: null, anchor: { kind: 'document' } }), threadRow({ id: 'tp', page: 0, quote: 'PAGEQUOTE' })];
    const comments = [commentRow({ id: 'cd', threadId: 'td', body: 'DOCNOTEBODY' }), commentRow({ id: 'cp', threadId: 'tp', body: 'PAGEBODY' })];
    const md = exportMd({ threads, comments });
    const p = parse(md);
    expect(md).toContain('DOCNOTEBODY');
    for (const s of p.sections) expect(s.text, `Page ${s.page} section`).not.toContain('DOCNOTEBODY');
    expect(sectionOf(p, 1).text).toContain('PAGEBODY');
  });
});

describe('replies', () => {
  it('a thread reads root first, then the replies in the order they were written, and Claude is named', () => {
    const threads = [threadRow({ id: 't1', page: 2, sortKey: 0.3, quote: 'THREADQUOTE' }), threadRow({ id: 't2', page: 5, quote: 'OWNQUOTE' })];
    const comments = [
      // the ids sort in a different order from the times, so only the time can put the thread in order
      commentRow({ id: 'c5', threadId: 't1', body: 'MYREPLYTWO', author: 'me', createdAt: T0 + 2 * MIN }),
      commentRow({ id: 'c9', threadId: 't1', body: 'ROOTBODY', author: 'me', createdAt: T0 }),
      commentRow({ id: 'c2', threadId: 't1', body: 'CLAUDEREPLYONE', author: 'claude', createdAt: T0 + MIN, meta: claudeMeta() }),
      commentRow({ id: 'c4', threadId: 't2', body: 'ONLYMINE', author: 'me' }),
    ];
    const p = parse(exportMd({ threads, comments }));
    const text = sectionOf(p, 3).text;
    const root = text.indexOf('ROOTBODY');
    const claude = text.indexOf('CLAUDEREPLYONE');
    const mine = text.indexOf('MYREPLYTWO');
    expect(root).toBeGreaterThan(text.indexOf('THREADQUOTE'));
    expect(root).toBeLessThan(claude);
    expect(claude).toBeLessThan(mine);
    // the first "Claude" is the label of Claude's reply: after the root, and nearer that reply than the owner's later one
    const label = text.indexOf('Claude');
    expect(label, 'Claude is named in a thread it replied in').toBeGreaterThan(root);
    expect(Math.abs(label - claude)).toBeLessThan(Math.abs(label - mine));
    expect(sectionOf(p, 6).text, 'a thread with only the owner in it does not mention Claude').not.toMatch(/Claude/);
  });

  it('cite links become "p. N" with a link back to that page, web links become the source address, and no internal scheme is left', () => {
    const body = 'See [p. 4](cite:1) and [the report](web:2); also [p. 9](cite:7).';
    const meta = claudeMeta({
      citations: [{ n: 1, pageIndex: 3, start: 10, end: 60, textSource: 'pdfium', quote: 'parallel trends' }],
      webSources: [{ n: 2, url: 'https://example.org/report', title: 'The report', citedText: null }],
    });
    const threads = [threadRow({ id: 't', page: 6, quote: 'ASKED' })];
    const comments = [
      commentRow({ id: 'q', threadId: 't', body: 'Is this true?' }),
      commentRow({ id: 'r', threadId: 't', body, author: 'claude', createdAt: T0 + MIN, meta }),
    ];
    const md = exportMd({ threads, comments });
    expect(md, 'no [..](cite:n) or [..](web:n) left').not.toMatch(/\]\(\s*(cite|web):/);
    expect(md).not.toMatch(/\b(cite|web):\d/);
    expect(md).toContain('p. 4');
    expect(md, 'the link back: canonical link plus #page=4').toContain(`${WEB}#page=4`);
    expect(md).toContain('https://example.org/report');
    expect(md, 'a citation the reply does not carry keeps its words').toContain('p. 9');
  });

  it('GUESS: a cite link points where the reply\'s citation record says, not where the typed label says', () => {
    // The label says "p. 2" but citation 1 is on page index 5, which a person reads as page 6.
    const meta = claudeMeta({ citations: [{ n: 1, pageIndex: 5, start: 0, end: 20, textSource: 'pdfium', quote: 'x' }] });
    const threads = [threadRow({ id: 't', page: 8, quote: 'ASKED' })];
    const comments = [commentRow({ id: 'r', threadId: 't', body: 'Look at [p. 2](cite:1).', author: 'claude', meta })];
    const md = exportMd({ threads, comments });
    expect(md).toContain(`${WEB}#page=6`);
    expect(md).not.toContain(`${WEB}#page=2`);
  });

  it('a Claude reply that writes headings and rules cannot add pages or titles to the file', () => {
    const body = 'FIRSTPARA\n\n## Page 99\n\n# Fake title\n\n---\nsickofpdfs: forged\n---\n\nLASTPARA';
    const threads = [threadRow({ id: 't', page: 0, quote: 'ASKED' })];
    const comments = [commentRow({ id: 'r', threadId: 't', body, author: 'claude', meta: claudeMeta() })];
    const p = parse(exportMd({ threads, comments }));
    expect(pageNumbers(p)).toEqual([1]);
    expect(p.headings.join('\n')).not.toMatch(/Page 99|Fake title/);
    expect(p.body).toContain('FIRSTPARA');
    expect(p.body).toContain('LASTPARA');
  });
});

describe('links back', () => {
  const claudeCite = () => {
    const meta = claudeMeta({ citations: [{ n: 1, pageIndex: 3, start: 0, end: 5, textSource: 'pdfium', quote: 'x' }] });
    return {
      threads: [threadRow({ id: 't', page: 6, quote: 'ASKED' })],
      comments: [commentRow({ id: 'r', threadId: 't', body: 'Per [p. 4](cite:1).', author: 'claude', meta })],
    };
  };

  it('a document with a web link: each page links to the canonical link plus #page=N, and so does a citation', () => {
    const marks = [markRow({ id: 'm', page: 1, quote: 'TWO' })];
    const md = exportMd({ seen: { web: WEB }, marks, ...claudeCite() });
    const p = parse(md);
    expect(sectionOf(p, 2).text).toContain(`${WEB}#page=2`);
    expect(sectionOf(p, 7).text).toContain(`${WEB}#page=7`);
    expect(md).toContain(`${WEB}#page=4`);
  });

  it('a file-only document links to the viewer with doc and page, and never writes the file path', () => {
    const md = exportMd({ seen: { file: FILE_URL }, ...claudeCite() });
    const text = sectionOf(parse(md), 7).text;
    expect(text).toMatch(new RegExp(`[?&]doc=${DOC}\\b`));
    expect(text).toMatch(/[?&#]page=7\b/);
    expect(md, 'a citation links to its page too').toMatch(/[?&#]page=4\b/);
    // the file's own address stays on this computer: the export goes into a folder that may sync
    expect(md).not.toMatch(/file:\/\/|Users\/|Private/i);
  });

  it('a document seen on the web and as a file links to the web address', () => {
    const md = exportMd({ seen: { web: WEB, file: FILE_URL }, marks: [markRow({ id: 'm', page: 6, quote: 'SEVEN' })] });
    expect(sectionOf(parse(md), 7).text).toContain(`${WEB}#page=7`);
    expect(md).not.toMatch(/file:\/\/|Users\/|Private/);
  });
});

describe('deleted rows', () => {
  it('a deleted mark, thread or comment is left out, and a page left with nothing has no section', () => {
    const marks = [markRow({ id: 'm-live', page: 0, quote: 'LIVEMARK' }), markRow({ id: 'm-gone', page: 1, quote: 'GONEMARK', deletedAt: T0 + MIN })];
    const threads = [
      threadRow({ id: 't-live', page: 0, sortKey: 0.5, quote: 'LIVETHREADQUOTE' }),
      threadRow({ id: 't-gone', page: 2, quote: 'GONETHREADQUOTE', deletedAt: T0 + MIN }),
      threadRow({ id: 't-half', page: 3, quote: 'HALFQUOTE' }),
    ];
    const comments = [
      commentRow({ id: 'c1', threadId: 't-live', body: 'LIVEBODY' }),
      commentRow({ id: 'c2', threadId: 't-live', body: 'GONEREPLY', author: 'claude', createdAt: T0 + MIN, deletedAt: T0 + 2 * MIN }),
      // the thread was deleted; the comment row itself was not touched
      commentRow({ id: 'c3', threadId: 't-gone', body: 'GONEROOT' }),
      commentRow({ id: 'c4', threadId: 't-half', body: 'HALFROOT' }),
      commentRow({ id: 'c5', threadId: 't-half', body: 'HALFREPLY', createdAt: T0 + MIN }),
    ];
    const md = exportMd({ marks, threads, comments });
    for (const kept of ['LIVEMARK', 'LIVETHREADQUOTE', 'LIVEBODY', 'HALFROOT', 'HALFREPLY']) expect(md, kept).toContain(kept);
    for (const gone of ['GONEMARK', 'GONETHREADQUOTE', 'GONEREPLY', 'GONEROOT']) expect(md, gone).not.toContain(gone);
    expect(pageNumbers(parse(md))).toEqual([1, 4]);
  });
});

describe('untrusted text', () => {
  const style = (quote: string) => ({ marks: [markRow({ id: 'm', page: 0, style: 'highlight' as const, quote })] });

  it('a quote with line breaks stays inside its blockquote, so it cannot start a heading of its own', () => {
    // PDFium ends a line with \r\n. The middle line is a heading in Markdown if it ever starts a line.
    const quote = 'FIRSTLINE of the quote\r\nSECONDLINE continues\n## Page 99\nTHIRDLINE ends';
    const md = exportMd(style(quote));
    const p = parse(md);
    expect(md, 'no stray carriage return').not.toContain('\r');
    expect(pageNumbers(p), 'the quote did not add a page').toEqual([1]);
    expect(p.headings.join('\n')).not.toContain('Page 99');
    const text = sectionOf(p, 1).text;
    for (const line of text.split('\n').filter((l) => /FIRSTLINE|SECONDLINE|THIRDLINE|Page 99/.test(l))) {
      expect(line, 'every line of the quote is a blockquote line').toMatch(/^[ \t]{0,3}>/);
    }
    const flat = words(text);
    expect(flat).toContain('FIRSTLINE of the quote SECONDLINE continues');
    expect(flat).toContain('THIRDLINE ends');
  });

  it('a quote that begins like a heading, a list, a quote, a rule or a code fence does not start one inside its blockquote', () => {
    const starts = ['# not a heading', '## also not one', '- not a bullet', '+ not a bullet', '* not a bullet', '1. not a list', '2) not a list', '> not a nested quote', '---', '```js'];
    const BLOCK = /^(#{1,6}([ \t]|$)|[-+*]([ \t]|$)|\d{1,9}[.)]([ \t]|$)|>|`{3,}|~{3,}|([-*_][ \t]*){3,}$)/;
    const failures: string[] = [];
    for (const start of starts) {
      const quote = start === '---' || start === '```js' ? start : `${start} and THEN more words`;
      const payloads = quotePayloads(sectionOf(parse(exportMd(style(quote))), 1).text);
      if (payloads.length === 0) failures.push(`${JSON.stringify(start)}: no blockquote line for the quote`);
      for (const line of payloads) if (BLOCK.test(line)) failures.push(`${JSON.stringify(start)}: the line ${JSON.stringify(line)} reads as a block`);
      if (!unescapeMd(payloads.join('\n')).includes(quote.replace(/\s+/g, ' '))) failures.push(`${JSON.stringify(start)}: it no longer reads back as the same words`);
    }
    expect(failures).toEqual([]);
  });

  it('markup in a quote does not turn into live HTML, a link or an image (an image would make a web request when the file is opened)', () => {
    const quote = 'before <script>alert(1)</script> and [click](https://evil.example/x) and ![pixel](https://evil.example/p.png) after';
    const md = exportMd(style(quote));
    expect(md, 'raw HTML').not.toMatch(/(?<!\\)<script/i);
    expect(md, 'a live link or image to another site').not.toMatch(/(?<!\\)\[(?:[^\]\\\n]|\\.)*\]\(\s*<?https?:\/\/evil/i);
    const text = sectionOf(parse(md), 1).text;
    expect(unescapeMd(quotePayloads(text).join(' '))).toContain(quote);
  });

  it('words, accents, other scripts and symbols come through unchanged', () => {
    const quote = 'Schrödinger’s café — 数据 ✓ 🙂 אבג Привет';
    const text = sectionOf(parse(exportMd(style(quote))), 1).text;
    expect(unescapeMd(quotePayloads(text).join(' '))).toContain(quote);
  });
});

describe('a plain function', () => {
  const c = (): ExportCase => ({
    marks: [markRow({ id: 'm1', page: 2, sortKey: 0.6, quote: 'ONE' }), markRow({ id: 'm2', page: 0, sortKey: 0.2, style: 'bold', quote: 'TWO' })],
    threads: [threadRow({ id: 't', page: 2, sortKey: 0.1, quote: 'THREE' })],
    comments: [
      commentRow({ id: 'c2', threadId: 't', body: 'REPLY', author: 'claude', createdAt: T0 + MIN, meta: claudeMeta() }),
      commentRow({ id: 'c1', threadId: 't', body: 'ROOT' }),
    ],
  });

  it('gives the same file for the same notes: no export date, and the order of the rows does not matter', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-02T10:00:00Z'));
    const a = exportMd(c());
    vi.setSystemTime(new Date('2031-06-30T23:59:59Z'));
    const same = c();
    const b = exportMd({ marks: [...(same.marks ?? [])].reverse(), threads: same.threads, comments: [...(same.comments ?? [])].reverse() });
    expect(b).toBe(a);
  });
});

// Maths in a reply from Claude (controller ruling, Phase 4 slice F round 2): `$…$` inline and `$$…$$` on its own line,
// drawn with KaTeX (bundled and pinned; its fonts come from the extension, never from a CDN).
//
// - The maths is taken out of the Markdown before it is read (`extractMaths`), so Markdown never turns a `_` or a `\{`
//   inside a formula into italics or an escape. Each span leaves a placeholder that ClaudeReplyView swaps for MathView.
// - Not maths: a dollar with a space after it, a closing dollar after a space or before a digit, a "formula" that starts
//   with a digit and has a space in it ("$5 and $10"), `\$`, and anything inside `code` or a ``` block.
// - KaTeX builds the formula with DOM calls (katex.render), never innerHTML, with `trust` off, so a reply cannot make
//   links, classes or styles through \href or \htmlClass. Formulas are capped in length, size and macro expansion. One
//   that does not parse is shown as the text it was.
// - KaTeX loads the first time a reply has maths, so opening a PDF does not wait for it.
import { useLayoutEffect, useRef, useState } from 'react';
import styles from './ClaudeMaths.module.css';

export interface MathSpan {
  tex: string;
  display: boolean;
}

/** The placeholder a formula leaves in the Markdown: private-use characters around its number, which Markdown leaves alone. */
const OPEN = '';
const CLOSE = '';
export const MATH_PLACEHOLDER = /(\d+)/gu;

/** A formula longer than this is left as text: an answer has no reason for one, and it keeps the work small. */
const MAX_TEX = 1500;

/** The source with every formula replaced by a placeholder, and the formulas in order. */
export function extractMaths(source: string): { text: string; maths: MathSpan[] } {
  const maths: MathSpan[] = [];
  let out = '';
  let i = 0;
  let inFence = false;
  const atLineStart = (at: number) => at === 0 || source[at - 1] === '\n';
  const keep = (tex: string, display: boolean, raw: string) => {
    if (tex.trim() === '' || tex.length > MAX_TEX) return raw;
    maths.push({ tex: tex.trim(), display });
    return `${OPEN}${maths.length - 1}${CLOSE}`;
  };

  while (i < source.length) {
    const ch = source[i];
    // A ``` block is copied as it is, up to its closing fence.
    if (atLineStart(i) && /^\s{0,3}```/u.test(source.slice(i, i + 8))) {
      const end = source.indexOf('\n', i);
      const line = end === -1 ? source.slice(i) : source.slice(i, end + 1);
      inFence = !inFence;
      out += line;
      i += line.length;
      continue;
    }
    if (inFence) {
      out += ch;
      i++;
      continue;
    }
    // `code` is copied as it is (a closing run of the same length, as Markdown reads it).
    if (ch === '`') {
      let run = 1;
      while (source[i + run] === '`') run++;
      const fence = '`'.repeat(run);
      const close = source.indexOf(fence, i + run);
      const span = close === -1 ? fence : source.slice(i, close + run);
      out += span;
      i += span.length;
      continue;
    }
    if (ch === '\\' && source[i + 1] === '$') {
      out += '\\$';
      i += 2;
      continue;
    }
    if (ch === '$' && source[i + 1] === '$') {
      const close = findClose(source, i + 2, '$$', true);
      if (close !== -1) {
        out += keep(source.slice(i + 2, close), true, source.slice(i, close + 2));
        i = close + 2;
        continue;
      }
    } else if (ch === '$') {
      const next = source[i + 1] ?? '';
      if (next !== '' && !/\s/u.test(next)) {
        const close = findClose(source, i + 1, '$', false);
        // "$5 and $10" is money: a formula that starts with a digit is taken only when it has no space in it ("$2^n$").
        const money = close !== -1 && /\d/u.test(next) && /\s/u.test(source.slice(i + 1, close));
        if (close !== -1 && !money) {
          out += keep(source.slice(i + 1, close), false, source.slice(i, close + 1));
          i = close + 1;
          continue;
        }
      }
    }
    out += ch;
    i++;
  }
  return { text: out, maths };
}

/**
 * Where a formula closes, or -1. Display maths may run over lines; inline maths stays in its paragraph, closes after a
 * character that is not a space, and not before a digit ("costs $5 to $10" is money, not maths).
 */
function findClose(s: string, from: number, mark: '$' | '$$', display: boolean): number {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') {
      j++;
      continue;
    }
    if (!display && c === '\n' && s[j + 1] === '\n') return -1; // a blank line ends the paragraph
    if (!display && c === '`') return -1; // `code` begins: a formula never runs into it
    if (j - from > MAX_TEX) return -1;
    if (s.startsWith(mark, j)) {
      if (display) return j;
      if (s[j + 1] === '$') return -1; // "$a$$" is not a closing dollar
      const before = s[j - 1] ?? '';
      if (/\s/u.test(before)) continue;
      if (/\d/u.test(s[j + 1] ?? '')) continue;
      return j;
    }
  }
  return -1;
}

/** Splits text into its words and the numbers of the formulas placed in it. */
export function splitMaths(text: string): (string | number)[] {
  const parts: (string | number)[] = [];
  let last = 0;
  for (const m of text.matchAll(MATH_PLACEHOLDER)) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(Number(m[1]));
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

type Katex = typeof import('katex').default;
let loading: Promise<Katex> | null = null;

/** KaTeX and its styles, loaded once, the first time a reply has maths. */
function loadKatex(): Promise<Katex> {
  loading ??= Promise.all([import('katex'), import('katex/dist/katex.min.css')]).then(([m]) => m.default);
  return loading;
}

/** One formula. Its text shows (as the reply wrote it) until KaTeX has drawn it, and stays if it does not parse. */
export function MathView({ tex, display }: MathSpan) {
  const box = useRef<HTMLSpanElement>(null);
  const [drawn, setDrawn] = useState<'waiting' | 'drawn' | 'failed'>('waiting');
  useLayoutEffect(() => {
    let live = true;
    setDrawn('waiting');
    void loadKatex().then(
      (katex) => {
        const el = box.current;
        if (!live || el === null) return;
        try {
          katex.render(tex, el, { displayMode: display, throwOnError: true, trust: false, strict: 'ignore', maxSize: 20, maxExpand: 200, output: 'htmlAndMathml' });
          setDrawn('drawn');
        } catch {
          el.textContent = '';
          setDrawn('failed');
        }
      },
      () => live && setDrawn('failed'),
    );
    return () => {
      live = false;
    };
  }, [tex, display]);
  const raw = display ? `$$${tex}$$` : `$${tex}$`;
  return (
    <>
      <span ref={box} className={display ? styles.display : styles.inline} hidden={drawn !== 'drawn'} />
      {drawn !== 'drawn' && <span className={styles.raw}>{raw}</span>}
    </>
  );
}

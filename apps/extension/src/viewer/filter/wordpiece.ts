// The tokenizer of the filter's tie-breaker model (all-MiniLM-L6-v2, uncased): BERT's WordPiece, written out here so the
// tie-breaker needs no tokenizer package and no second copy of the runtime. It follows the model's own tokenizer.json
// (BertNormalizer with clean_text, handle_chinese_chars, accent stripping and lower-casing; BertPreTokenizer; WordPiece with
// "##" and at most 100 characters a word; [CLS] and [SEP] around the text), and the build checks the vectors it makes
// against the model (scripts/minilm-prototypes.mjs --check).
//
// Pure: no I/O, no globals. The text it is given is only ever turned into numbers.

/** Tokens in one input including [CLS] and [SEP]. The research run (docs/research/04, B.4) cut at 256 too. */
export const MAX_TOKENS = 256;
/** A word longer than this many characters is one [UNK] (the model's max_input_chars_per_word). */
const MAX_WORD_CHARS = 100;
const CONTINUING = '##';

const SPECIAL = ['[PAD]', '[UNK]', '[CLS]', '[SEP]', '[MASK]'] as const;
type Special = (typeof SPECIAL)[number];
const SPECIAL_SPLIT = /(\[PAD\]|\[UNK\]|\[CLS\]|\[SEP\]|\[MASK\])/;

// White_Space as Unicode defines it (the set the model's normalizer treats as a space).
const WHITESPACE = /[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u;
// Control, format, private-use, surrogate and unassigned characters are dropped (white space is kept apart, above).
const OTHER = /\p{C}/u;
const MARK_NONSPACING = /\p{Mn}/gu;
const PUNCTUATION = /\p{P}/u;

function isAsciiPunctuation(code: number): boolean {
  return (code >= 33 && code <= 47) || (code >= 58 && code <= 64) || (code >= 91 && code <= 96) || (code >= 123 && code <= 126);
}

function isCjk(code: number): boolean {
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x20000 && code <= 0x2a6df) ||
    (code >= 0x2a700 && code <= 0x2b73f) ||
    (code >= 0x2b740 && code <= 0x2b81f) ||
    (code >= 0x2b820 && code <= 0x2ceaf) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0x2f800 && code <= 0x2fa1f)
  );
}

/** Clean, space out CJK characters, strip accents, lower-case. */
function normalize(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0 || code === 0xfffd) continue;
    if (WHITESPACE.test(ch)) {
      out += ' ';
      continue;
    }
    if (OTHER.test(ch)) continue;
    out += isCjk(code) ? ` ${ch} ` : ch;
  }
  return out.normalize('NFD').replace(MARK_NONSPACING, '').toLowerCase();
}

/** Splits at white space and around every punctuation character (each is a word of its own). */
function words(text: string): string[] {
  const out: string[] = [];
  let current = '';
  for (const ch of text) {
    if (ch === ' ') {
      if (current !== '') out.push(current);
      current = '';
    } else if (isAsciiPunctuation(ch.codePointAt(0) ?? 0) || PUNCTUATION.test(ch)) {
      if (current !== '') out.push(current);
      out.push(ch);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current !== '') out.push(current);
  return out;
}

export interface WordPiece {
  /** [CLS], the tokens of `text` (cut so the whole input is at most MAX_TOKENS), [SEP]. */
  encode(text: string): number[];
  /** The ids of [CLS], [SEP] and [UNK] in this vocabulary. */
  readonly ids: { readonly cls: number; readonly sep: number; readonly unk: number };
}

/** `vocabText` is the model's vocab.txt: one token a line, the line number is the id. */
export function createWordPiece(vocabText: string): WordPiece {
  const vocab = new Map<string, number>();
  const lines = vocabText.split('\n');
  for (let id = 0; id < lines.length; id++) {
    const token = (lines[id] ?? '').replace(/\r$/, '');
    if (token !== '' && !vocab.has(token)) vocab.set(token, id);
  }
  const special = (token: Special): number => {
    const id = vocab.get(token);
    if (id === undefined) throw new Error(`the vocabulary has no ${token}`);
    return id;
  };
  const ids = { cls: special('[CLS]'), sep: special('[SEP]'), unk: special('[UNK]') };

  /** Greedy longest match from the left; a word with any piece missing is one [UNK]. */
  function pieces(word: string): number[] {
    const chars = Array.from(word);
    if (chars.length > MAX_WORD_CHARS) return [ids.unk];
    const out: number[] = [];
    let start = 0;
    while (start < chars.length) {
      let end = chars.length;
      let found: number | undefined;
      while (start < end) {
        const piece = (start > 0 ? CONTINUING : '') + chars.slice(start, end).join('');
        const id = vocab.get(piece);
        if (id !== undefined) {
          found = id;
          break;
        }
        end--;
      }
      if (found === undefined) return [ids.unk];
      out.push(found);
      start = end;
    }
    return out;
  }

  function encode(text: string): number[] {
    const room = MAX_TOKENS - 2;
    const tokens: number[] = [];
    // The five special tokens are recognised in the raw text first, as the model's tokenizer does ("[CLS]" in a paper about BERT)
    for (const part of text.split(SPECIAL_SPLIT)) {
      if (tokens.length >= room) break;
      if ((SPECIAL as readonly string[]).includes(part)) {
        tokens.push(special(part as Special));
        continue;
      }
      for (const word of words(normalize(part))) {
        for (const id of pieces(word)) tokens.push(id);
        if (tokens.length >= room) break;
      }
    }
    return [ids.cls, ...tokens.slice(0, room), ids.sep];
  }

  return { encode, ids };
}

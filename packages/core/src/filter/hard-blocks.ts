// Hard blocks: card and ID numbers that make a PDF private. They keep a private document from ever being saved by the
// score. This file finds KINDS only. It never returns, stores or logs a matched string.
//
// Each detector is narrow on purpose. A match needs a checksum or a label, so arXiv ids, DOIs, ISBNs, page numbers and
// tables of numbers do not fire.

import { capPages } from './limits';
import type { HardBlock } from './types';
import {
  ibanLength,
  ibanValid,
  isCardNumber,
  isPassportLine,
  niNumberValid,
  ssnValid,
} from './validators';

/** The kinds in the order they are reported. */
export const HARD_BLOCK_KINDS: readonly HardBlock[] = [
  'card',
  'iban',
  'sort-code-account',
  'ni-number',
  'ssn',
  'utr',
  'passport-line',
  'boarding-pass',
];

// A run of digit groups joined by single spaces or hyphens: the shape a card number is printed in.
const DIGIT_RUN = /\d+(?:[ \u00a0-]\d+)*/g;
const RUN_SEPARATOR = /[ \u00a0-]/;

function cardShape(groups: readonly string[]): boolean {
  const lens = groups.map((g) => g.length).join(',');
  return lens === '16' || lens === '4,4,4,4' || lens === '15' || lens === '4,6,5';
}

function hasCard(text: string): boolean {
  for (const m of text.matchAll(DIGIT_RUN)) {
    const run = m[0];
    const at = m.index;
    // a decimal part ("0.4111…") or a number with a decimal part is an amount, not a card
    if (/\d[.,]$/.test(text.slice(Math.max(0, at - 2), at))) continue;
    if (/^[.,]\d/.test(text.slice(at + run.length, at + run.length + 2))) continue;
    const groups = run.split(RUN_SEPARATOR);
    // Up to two short trailing groups (an expiry month, a three-digit code) may follow the number on the same line.
    for (let end = groups.length; end >= Math.max(1, groups.length - 2); end--) {
      if (groups.slice(end).some((g) => g.length > 3)) break;
      const g = groups.slice(0, end);
      if (cardShape(g) && isCardNumber(g.join(''))) return true;
    }
  }
  return false;
}

function hasIban(text: string): boolean {
  for (const m of text.matchAll(/(?<![A-Za-z0-9])([A-Z]{2})\d{2}(?=[ A-Z0-9])/g)) {
    const need = ibanLength(m[1]);
    if (need === null) continue;
    // collect letters and digits, allowing the single spaces IBANs are printed with, until the length is reached
    let out = '';
    let i = m.index;
    while (i < text.length && out.length < need) {
      const c = text[i];
      if (/[A-Z0-9]/.test(c)) out += c;
      else if (c !== ' ' || !/[A-Z0-9]/.test(text[i + 1] ?? '')) break;
      i++;
    }
    if (out.length !== need || /[A-Za-z0-9]/.test(text[i] ?? '')) continue;
    if (ibanValid(out)) return true;
  }
  return false;
}

const SORT_LABELLED = /sort[\s-]?code\W{0,12}\d{2}[\s-]?\d{2}[\s-]?\d{2}(?!\d)/gi;
const SORT_DASHED = /(?<![\d-])\d{2}-\d{2}-\d{2}(?![\d-])/g;
const ACCOUNT_LABELLED = /(?:account|acc|a\/c)\s{0,6}(?:number|no|num|#)?\.?\s{0,6}[:#]?\s{0,6}\d{8}(?!\d)/gi;
const EIGHT_DIGITS = /(?<![\d.,/-])\d{8}(?!\d|[.,]\d)/g;
const NEAR = 60;

function positions(re: RegExp, text: string): number[] {
  return Array.from(text.matchAll(re), (m) => m.index);
}

function hasSortCodeAccount(text: string): boolean {
  const sortLabelled = positions(SORT_LABELLED, text);
  const acctLabelled = positions(ACCOUNT_LABELLED, text);
  if (!sortLabelled.length && !acctLabelled.length) return false;
  const sortAll = sortLabelled.concat(positions(SORT_DASHED, text));
  const acctAll = acctLabelled.concat(positions(EIGHT_DIGITS, text));
  const near = (a: number[], b: number[]) => a.some((x) => b.some((y) => Math.abs(x - y) <= NEAR));
  // one side has to carry its label, so a date next to an invoice number does not count
  return near(sortLabelled, acctAll) || near(sortAll, acctLabelled);
}

function hasNiNumber(text: string): boolean {
  for (const m of text.matchAll(/(?<![A-Za-z0-9])[A-Z]{2} ?\d{2} ?\d{2} ?\d{2} ?[A-D](?![A-Za-z0-9])/g)) {
    if (niNumberValid(m[0].replaceAll(' ', ''))) return true;
  }
  return false;
}

function hasSsn(text: string): boolean {
  for (const m of text.matchAll(/(?<![\d-])(\d{3})-(\d{2})-(\d{4})(?![\d-])/g)) {
    if (ssnValid(m[1], m[2], m[3])) return true;
  }
  for (const m of text.matchAll(/(?:\bssn\b|social\s{1,8}security\s{1,8}(?:number|no\.?))\W{0,12}(\d{3})(\d{2})(\d{4})(?!\d)/gi)) {
    if (ssnValid(m[1], m[2], m[3])) return true;
  }
  return false;
}

const UTR = /(?:\butr\b|unique\s{1,8}tax(?:payer)?\s{1,8}reference|\btax\s{1,8}reference)[^\d\n]{0,25}(?<!\d)\d{5}\s?\d{5}(?!\d)/i;

function hasPassportLine(text: string): boolean {
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line.length < 44 || line.length > 80) continue;
    const t = line.replaceAll(/\s+/g, '');
    if (t.length === 44 && isPassportLine(t)) return true;
  }
  return false;
}

// IATA boarding-pass string: M, leg count, 20-character name, e-ticket flag, PNR, from, to and carrier codes.
const BOARDING_PASS = /(?<![A-Za-z0-9])M[1-9][A-Z][A-Z/ ]{2,19}\s?E?[A-Z0-9]{6,7}\s?[A-Z]{6}[A-Z0-9]{2,3}\s?[A-Z0-9 ]{3,5}\s?\d{3}[A-Z]/;

/**
 * Which kinds of card or ID number the pages hold. Order follows `HARD_BLOCK_KINDS`; each kind appears at most once.
 * Nothing about where or what was matched is returned.
 */
export function detectHardBlocks(texts: readonly string[]): HardBlock[] {
  const found = new Set<HardBlock>();
  for (const raw of capPages(texts)) {
    if (!raw) continue;
    const text = raw.normalize('NFKC');
    if (!found.has('card') && hasCard(text)) found.add('card');
    if (!found.has('iban') && hasIban(text)) found.add('iban');
    if (!found.has('sort-code-account') && hasSortCodeAccount(text)) found.add('sort-code-account');
    if (!found.has('ni-number') && hasNiNumber(text)) found.add('ni-number');
    if (!found.has('ssn') && hasSsn(text)) found.add('ssn');
    if (!found.has('utr') && UTR.test(text)) found.add('utr');
    if (!found.has('passport-line') && hasPassportLine(text)) found.add('passport-line');
    if (!found.has('boarding-pass') && BOARDING_PASS.test(text)) found.add('boarding-pass');
  }
  return HARD_BLOCK_KINDS.filter((k) => found.has(k));
}

/** A card number blocks on its own. Any two of the other kinds block. One other kind alone does not. */
export function hardBlockApplies(kinds: readonly HardBlock[]): boolean {
  return kinds.includes('card') || kinds.filter((k) => k !== 'card').length >= 2;
}

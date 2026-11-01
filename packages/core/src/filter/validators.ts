// Checksums and shape rules behind the hard blocks. Every function is pure and answers yes or no: none of them keeps or
// returns the text it was given.

/** Luhn check over a digit string. */
export function luhnValid(digits: string): boolean {
  if (digits.length < 12 || !/^\d+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

// Known card prefixes by total length. A number with a valid checksum but no known prefix is not a card.
const CARD_16: readonly RegExp[] = [
  /^4/, // Visa
  /^5[1-5]/, // Mastercard
  /^2(?:2[2-9]\d|[3-6]\d\d|7[01]\d|720)/, // Mastercard 2-series (2221 to 2720)
  /^6011|^65|^64[4-9]/, // Discover
  /^622(?:12[6-9]|1[3-9]\d|[2-8]\d\d|9[01]\d|92[0-5])/, // Discover / UnionPay range
  /^62/, // UnionPay
  /^35(?:2[89]|[3-8]\d)/, // JCB (3528 to 3589)
  /^3(?:0[0-5]|095|[689]\d)/, // Diners Club
  /^(?:5018|5020|5038|5893|6304|6759|676[1-3])/, // Maestro
];
const CARD_15: readonly RegExp[] = [/^3[47]/]; // American Express

/** True when `digits` is 16 digits (or 15 for American Express) with a known prefix and a valid Luhn checksum. */
export function isCardNumber(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  const prefixes = digits.length === 16 ? CARD_16 : digits.length === 15 ? CARD_15 : null;
  if (!prefixes) return false;
  return prefixes.some((p) => p.test(digits)) && luhnValid(digits);
}

// IBAN lengths by country (the SWIFT registry).
const IBAN_LENGTH: Readonly<Record<string, number>> = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BI: 27, BR: 29, BY: 28, CH: 21, CR: 22,
  CY: 28, CZ: 24, DE: 22, DJ: 27, DK: 18, DO: 28, EE: 20, EG: 29, ES: 24, FI: 18, FO: 18, FR: 27, GB: 22, GE: 22,
  GI: 23, GL: 18, GR: 27, GT: 28, HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30, KW: 30, KZ: 20,
  LB: 28, LC: 32, LI: 21, LT: 20, LU: 20, LV: 21, LY: 25, MC: 27, MD: 24, ME: 22, MK: 19, MN: 20, MR: 27, MT: 31,
  MU: 30, NI: 28, NL: 18, NO: 15, OM: 23, PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22, RU: 33, SA: 24,
  SC: 31, SD: 18, SE: 24, SI: 19, SK: 24, SM: 27, SO: 23, ST: 25, SV: 28, TL: 23, TN: 24, TR: 26, UA: 29, VA: 22,
  VG: 24, XK: 20, YE: 30,
};

/** The IBAN length for a two-letter country code, or null when the country has no IBAN. */
export function ibanLength(country: string): number | null {
  return IBAN_LENGTH[country] ?? null;
}

/** ISO 7064 mod 97-10 over an IBAN with its spaces already removed, in capitals. */
export function ibanValid(iban: string): boolean {
  const len = ibanLength(iban.slice(0, 2));
  if (len === null || iban.length !== len || !/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (let i = 0; i < rearranged.length; i++) {
    const c = rearranged.charCodeAt(i);
    // digits stay as they are; letters become 10 to 35 (two digits)
    rem = c >= 65 ? (rem * 100 + (c - 55)) % 97 : (rem * 10 + (c - 48)) % 97;
  }
  return rem === 1;
}

const NI_BAD_PREFIX: ReadonlySet<string> = new Set(['BG', 'GB', 'NK', 'KN', 'NT', 'TN', 'ZZ']);

/** UK National Insurance number, spaces removed: two letters from the allowed sets, six digits, a letter A to D. */
export function niNumberValid(ni: string): boolean {
  return /^[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]\d{6}[A-D]$/.test(ni) && !NI_BAD_PREFIX.has(ni.slice(0, 2));
}

/** US Social Security number rules: area not 000, 666 or 900 to 999; group not 00; serial not 0000. */
export function ssnValid(area: string, group: string, serial: string): boolean {
  if (area === '000' || area === '666' || area.startsWith('9')) return false;
  return group !== '00' && serial !== '0000';
}

const MRZ_WEIGHTS = [7, 3, 1];

function mrzCharValue(c: string): number {
  if (c === '<') return 0;
  const code = c.charCodeAt(0);
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 65 && code <= 90) return code - 55;
  return -1;
}

/** The ICAO 9303 check digit (weights 7, 3, 1) over a field, compared with the digit that follows it. */
export function mrzCheck(field: string, check: string): boolean {
  if (!/^\d$/.test(check)) return false;
  let sum = 0;
  for (let i = 0; i < field.length; i++) {
    const v = mrzCharValue(field[i]);
    if (v < 0) return false;
    sum += v * (MRZ_WEIGHTS[i % 3]);
  }
  return sum % 10 === Number(check);
}

/** Machine-readable passport line (TD3, 44 characters): the name line, or the data line with valid check digits. */
export function isPassportLine(line: string): boolean {
  if (line.length !== 44 || !/^[A-Z0-9<]{44}$/.test(line)) return false;
  // line 1: P, a type letter or <, a three-letter country, then the name with << between surname and given names
  if (/^P[A-Z<][A-Z]{2}[A-Z<]{40}$/.test(line) && line.includes('<<')) return true;
  // line 2: passport number + check, nationality, birth date + check, sex, expiry date + check
  let ok = 0;
  if (mrzCheck(line.slice(0, 9), line[9])) ok++;
  if (mrzCheck(line.slice(13, 19), line[19])) ok++;
  if (mrzCheck(line.slice(21, 27), line[27])) ok++;
  return ok >= 2 && /^[A-Z<]{3}$/.test(line.slice(10, 13));
}

/**
 * A new-style arXiv id (YYMM.NNNN until 2014, YYMM.NNNNN from 2015). Month 01 to 12, year 07 or later. This keeps
 * invoice numbers and version numbers that look like "2023.10445" from counting.
 */
export function isArxivId(id: string): boolean {
  const m = /^(\d{2})(\d{2})\.(\d{4,5})(?:v\d+)?$/.exec(id);
  if (!m) return false;
  const yy = Number(m[1]);
  const mm = Number(m[2]);
  const len = (m[3]).length;
  if (yy < 7 || yy > 49 || mm < 1 || mm > 12) return false;
  const beforeFiveDigits = yy < 15;
  return beforeFiveDigits ? len === 4 : len === 5;
}

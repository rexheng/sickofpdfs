import { describe, expect, it } from 'vitest';
import { escapeForRegexFilter } from './escape';

// The one-time allow rule that lets Chrome's own viewer show a PDF is matched with a `regexFilter` made from the
// address. It must match that address and no other, and chrome.declarativeNetRequest compiles it with RE2.

const ADDRESSES = [
  'https://example.com/a.pdf',
  'http://127.0.0.1:41591/f/paper-50.pdf?q=a+b(c)[d]{2}|e$f^g.*h%20i&x=1;y=2',
  'https://moodle.lse.ac.uk/pluginfile.php/123/mod_resource/content/2/Week%203.pdf?forcedownload=1',
  'file:///C:/Users/Rex/My%20Docs/lecture%20(1).pdf',
  'https://example.com/a.pdf#page=3',
  'https://example.com/ünï/文件.pdf',
  'https://example.com/back\\slash.pdf',
  'https://example.com/what?.pdf',
];

describe('escapeForRegexFilter', () => {
  it.each(ADDRESSES)('matches exactly the address, and is anchored: %s', (address) => {
    const pattern = escapeForRegexFilter(address);
    expect(pattern.startsWith('^') && pattern.endsWith('$'), 'anchored at both ends').toBe(true);
    const re = new RegExp(pattern);
    expect(re.test(address)).toBe(true);
    for (const other of [`${address}x`, `x${address}`, address.slice(0, -1), `${address}/`]) expect(re.test(other), `must not match ${other}`).toBe(false);
  });

  it.each(ADDRESSES)('treats every punctuation mark as itself, and only escapes in ways RE2 accepts: %s', (address) => {
    const body = escapeForRegexFilter(address).slice(1, -1);
    // RE2 reads a backslash before a letter or digit as a class or a back-reference, and rejects one before a non-ASCII character
    for (const [, escaped] of body.matchAll(/\\([\s\S])/g)) expect(escaped, 'the character after a backslash').toMatch(/^[!-/:-@[-`{-~]$/);
    // With every escaped pair taken out, nothing the pattern language treats as special is left
    expect(body.replace(/\\[\s\S]/g, ''), 'unescaped special characters').not.toMatch(/[.*+?^${}()|[\]\\]/);
  });

  it('keeps addresses that differ in one punctuation mark apart', () => {
    const cases: [string, string][] = [
      ['https://example.com/a.pdf', 'https://example.com/aXpdf'],
      ['https://example.com/a.pdf?x=1', 'https://example.com/a.pdf'],
      ['https://example.com/a.pdf?x=1', 'https://example.com/a.pdf?x=2'],
      ['https://example.com/a+b.pdf', 'https://example.com/aab.pdf'],
      ['https://example.com/a(b).pdf', 'https://example.com/ab.pdf'],
      ['https://example.com/[a].pdf', 'https://example.com/a.pdf'],
      ['https://example.com/a|b.pdf', 'https://example.com/b.pdf'],
      ['https://example.com/a*.pdf', 'https://example.com/aaaa.pdf'],
    ];
    for (const [address, lookalike] of cases) {
      expect(new RegExp(escapeForRegexFilter(address)).test(lookalike), `${address} must not match ${lookalike}`).toBe(false);
    }
  });
});

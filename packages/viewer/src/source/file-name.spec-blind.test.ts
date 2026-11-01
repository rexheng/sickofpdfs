// Spec-blind unit tests for displayNameFor (Task 20): the name shown for an opened PDF (the reading area's aria-label, the title).
// Interface file: displayNameFor(url: string | null, contentDisposition: string | null, fallback?: string): string.
// The interface file gives no rules beyond the signature, so each row below is a careful reading of "the file's name as a person
// would call it", and the guesses are written in the report: the extension is kept; a Content-Disposition name beats the address;
// RFC 6266 filename* beats filename; directories are stripped; percent-escapes in an address are decoded.
import { describe, expect, it } from 'vitest';
import { displayNameFor } from './file-name';

describe('displayNameFor', () => {
  const FALLBACK = 'Untitled.pdf';
  // [what, url, contentDisposition, expected]
  it.each([
    ['the last part of a web address, decoded, without query or fragment', 'https://example.org/reading/Week%203%20Notes.pdf?token=abc#page=2', null, 'Week 3 Notes.pdf'],
    ['a plain web address', 'https://example.org/papers/did-multiple-periods.pdf', null, 'did-multiple-periods.pdf'],
    ['a Windows file address', 'file:///C:/Users/rex/Reading/week%203.pdf', null, 'week 3.pdf'],
    ['a Linux file address', 'file:///home/rex/lecture%20slides.pdf', null, 'lecture slides.pdf'],
    ['the server\'s filename beats the address', 'https://example.org/download?id=7', 'attachment; filename="Lecture 4.pdf"', 'Lecture 4.pdf'],
    ['a filename without quotes', 'https://example.org/get', 'inline; filename=report.pdf', 'report.pdf'],
    ['filename* (UTF-8, percent-encoded) beats filename', 'https://example.org/x', "attachment; filename=\"fallback.pdf\"; filename*=UTF-8''na%C3%AFve%20caf%C3%A9.pdf", 'naïve café.pdf'],
    ['a directory in the filename is dropped (forward slashes)', 'https://example.org/x', 'attachment; filename="../../etc/evil.pdf"', 'evil.pdf'],
    ['a directory in the filename is dropped (backslashes)', 'https://example.org/x', 'attachment; filename="C:\\temp\\a.pdf"', 'a.pdf'],
    ['an empty filename falls back to the address', 'https://example.org/papers/real-name.pdf', 'attachment; filename=""', 'real-name.pdf'],
    ['a Content-Disposition with no filename falls back to the address', 'https://example.org/papers/real-name.pdf', 'inline', 'real-name.pdf'],
  ] as const)('%s', (_what, url, cd, expected) => {
    expect(displayNameFor(url, cd, FALLBACK)).toBe(expected);
  });

  it.each([
    ['no address and no header', null, null],
    ['an address with no file part', 'https://example.org/', null],
    ['an address that is only a query', 'https://example.org/?id=1', null],
  ] as const)('uses the fallback for %s', (_what, url, cd) => {
    expect(displayNameFor(url, cd, FALLBACK)).toBe(FALLBACK);
  });

  it('always returns a non-empty name, even with no fallback given and a broken percent-escape in the address', () => {
    expect(displayNameFor(null, null).trim().length).toBeGreaterThan(0);
    expect(() => displayNameFor('https://example.org/a%E0%A4%A.pdf', null, FALLBACK)).not.toThrow();
    expect(displayNameFor('https://example.org/a%E0%A4%A.pdf', null, FALLBACK).trim().length).toBeGreaterThan(0);
  });
});

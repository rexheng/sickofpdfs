/**
 * Response headers for the takeover cases the fixture server answers at `/h/*` (query strings are ignored when
 * matching). `ct: null` sends no Content-Type; `cd` is the Content-Disposition. `expect` is what a person should
 * see: the PDF in our viewer, or a plain download.
 */
export const HEADER_CASES = [
  { path: '/h/plain.pdf', ct: 'application/pdf', expect: 'viewer' },
  { path: '/h/charset', ct: 'application/pdf; charset=binary', expect: 'viewer' },
  { path: '/h/octet.pdf', ct: 'application/octet-stream', expect: 'viewer' },
  { path: '/h/octet-noext', ct: 'application/octet-stream', cd: 'attachment; filename="a.pdf"', expect: 'download' },
  { path: '/h/attachment.pdf', ct: 'application/pdf', cd: 'attachment; filename="a.pdf"', expect: 'viewer' },
  { path: '/h/x?type=download', ct: 'application/pdf', cd: 'attachment; filename="a.pdf"', expect: 'download' },
  { path: '/h/cd-inline', ct: 'text/plain', cd: 'inline; filename="a.pdf"', expect: 'viewer' },
  { path: '/h/no-ctype.pdf', ct: null, expect: 'viewer' }, // content-script sniff path
] as const;

export type HeaderCase = (typeof HEADER_CASES)[number];

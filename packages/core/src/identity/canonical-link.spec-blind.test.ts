// Spec-blind tests for cleanLink and canonicalLink (Task 18).
//
// Source of the rules: spec, "Library and knowledge base", identity rule 4:
//   "Links are canonical: tracking and token parameters removed, http made https, library-proxy hosts mapped back,
//    and Moodle's revision number removed ..."
// plus the interface file: cleanLink = tracking/token params removed, fragment dropped, params sorted (used by "Copy link");
// canonicalLink = cleanLink + https + host rules (arXiv, DOI, Moodle, EZproxy); non-http(s) returned unchanged.
//
// The spec does not print the exact output form of the host rules, so most host-rule tests check what must be TRUE for
// any sensible output: links to the same thing give one canonical string, links to different things stay different.
// Exact strings are asserted only where the rule leaves no room (http to https, proxy host mapped back, params sorted).
// Tests whose expectation is a reading of the spec rather than its words live in the "guess" describes (see the report).
//
// Second pass: after the first run, the plan's Task 18 rule list and pinned link vectors were opened to me. Rows that
// the plan settles were moved out of the "guess" describes and aligned with it: a leading "www." is dropped, a trailing
// slash is kept, publisher /doi/ forms are NOT merged, "login?url=" is unwrapped, arXiv versions and mirrors collapse,
// DOIs are lower-cased, Moodle's revision becomes 0. Two rows are new spec decisions the plan does not yet list
// (marked "spec decision"): Moodle "sesskey" is always stripped, and the revision inside pluginfile.php?file=... becomes 0.
import { describe, expect, it } from 'vitest';
import { canonicalLink, cleanLink } from '../index';

type Params = Array<[string, string]>;

function shape(url: string): { base: string; params: Params; hash: string } {
  const u = new URL(url);
  return { base: `${u.protocol}//${u.host}${u.pathname}`, params: [...u.searchParams.entries()], hash: u.hash };
}

/** All these links must collapse to one canonical string; returns it. */
function expectOneLocation(urls: string[]): string {
  const outs = urls.map((u) => canonicalLink(u));
  outs.forEach((out, i) => expect(out, `canonicalLink(${urls[i]}) = ${out}`).toBe(outs[0]));
  return outs[0];
}

/** All these links are different things; their canonical strings must all differ. */
function expectAllDistinct(urls: string[]): void {
  const outs = urls.map((u) => canonicalLink(u));
  expect(new Set(outs).size, `canonical forms: ${outs.join('  |  ')}`).toBe(urls.length);
}

// ---------------------------------------------------------------------------------------------------------------------
describe('cleanLink: tracking and token params out, fragment out, params sorted (used by "Copy link")', () => {
  type Row = { name: string; input: string; base: string; params: Params };
  const rows: Row[] = [
    {
      name: 'utm_* family removed and no dangling "?" is left',
      input: 'https://example.edu/reading.pdf?utm_source=newsletter&utm_medium=email&utm_campaign=week3&utm_term=did&utm_content=button',
      base: 'https://example.edu/reading.pdf',
      params: [],
    },
    {
      name: 'fbclid removed',
      input: 'https://www.nber.org/system/files/working_papers/w29000/w29000.pdf?fbclid=IwAR0Zx-3kqjQ',
      base: 'https://www.nber.org/system/files/working_papers/w29000/w29000.pdf',
      params: [],
    },
    {
      name: 'gclid removed',
      input: 'https://cep.lse.ac.uk/pubs/download/dp1800.pdf?gclid=Cj0KCQiAxxxxxxxxEiwA',
      base: 'https://cep.lse.ac.uk/pubs/download/dp1800.pdf',
      params: [],
    },
    {
      name: 'token removed (Moodle web-service file link)',
      input: 'https://moodle.lse.ac.uk/webservice/pluginfile.php/1234567/mod_resource/content/2/Lecture1.pdf?token=0a1b2c3d4e5f60718293a4b5c6d7e8f9',
      base: 'https://moodle.lse.ac.uk/webservice/pluginfile.php/1234567/mod_resource/content/2/Lecture1.pdf',
      params: [],
    },
    {
      name: 'tracking removed but the params that pick the document stay (PLOS)',
      input: 'https://journals.plos.org/plosone/article/file?id=10.1371/journal.pone.0000308&type=printable&utm_source=twitter',
      base: 'https://journals.plos.org/plosone/article/file',
      params: [
        ['id', '10.1371/journal.pone.0000308'],
        ['type', 'printable'],
      ],
    },
    {
      name: 'params are sorted by name',
      input: 'https://example.edu/search?z=1&b=2&a=3',
      base: 'https://example.edu/search',
      params: [
        ['a', '3'],
        ['b', '2'],
        ['z', '1'],
      ],
    },
    {
      name: 'sorting happens on what is left after tracking is removed (SSRN)',
      input: 'https://papers.ssrn.com/sol3/Delivery.cfm/SSRN_ID3000000_code123.pdf?mirid=1&utm_source=x&abstractid=3000000',
      base: 'https://papers.ssrn.com/sol3/Delivery.cfm/SSRN_ID3000000_code123.pdf',
      params: [
        ['abstractid', '3000000'],
        ['mirid', '1'],
      ],
    },
    {
      name: 'viewer fragment #page= dropped',
      input: 'https://example.edu/a.pdf#page=12',
      base: 'https://example.edu/a.pdf',
      params: [],
    },
    {
      name: 'fragment dropped, real query kept',
      input: 'https://example.edu/a.pdf?id=7#nameddest=sec3',
      base: 'https://example.edu/a.pdf',
      params: [['id', '7']],
    },
    {
      name: 'Chrome text fragment dropped',
      input: 'https://example.edu/a.pdf#:~:text=parallel%20trends',
      base: 'https://example.edu/a.pdf',
      params: [],
    },
    {
      name: 'a tracking name inside a VALUE, or as a longer key, is not tracking',
      input: 'https://example.edu/go?x_utm_source=keep&source=utm_campaign&fbclid=zzz',
      base: 'https://example.edu/go',
      params: [
        ['source', 'utm_campaign'],
        ['x_utm_source', 'keep'],
      ],
    },
    {
      name: 'a param that picks the document stays: Moodle page id',
      input: 'https://moodle.lse.ac.uk/mod/resource/view.php?id=2345678&utm_source=email',
      base: 'https://moodle.lse.ac.uk/mod/resource/view.php',
      params: [['id', '2345678']],
    },
    {
      name: 'a param that picks the document stays: viewer ?file= and ?page=',
      input: 'https://example.edu/viewer?file=lecture2.pdf&page=3&fbclid=abc',
      base: 'https://example.edu/viewer',
      params: [
        ['file', 'lecture2.pdf'],
        ['page', '3'],
      ],
    },
    {
      name: 'a param without a value stays',
      input: 'https://example.edu/dl?download&utm_source=x',
      base: 'https://example.edu/dl',
      params: [['download', '']],
    },
    {
      name: 'percent-encoded values still decode to the same text',
      input: 'https://example.edu/dl?name=My%20Notes%20%281%29.pdf&z=%C3%A9&gclid=1',
      base: 'https://example.edu/dl',
      params: [
        ['name', 'My Notes (1).pdf'],
        ['z', '\u00e9'],
      ],
    },
    {
      name: 'a longer key, or a value, that merely contains a sign-in key name is kept (R105, negative)',
      input: 'https://example.edu/a.pdf?coursecode=EC1A1&author=Smith&skip=2&q=code&sketch=1',
      base: 'https://example.edu/a.pdf',
      params: [
        ['author', 'Smith'],
        ['coursecode', 'EC1A1'],
        ['q', 'code'],
        ['sketch', '1'],
        ['skip', '2'],
      ],
    },
    {
      name: 'host case folds, path case is kept',
      input: 'HTTPS://Example.EDU/Docs/Reading.PDF?x=1',
      base: 'https://example.edu/Docs/Reading.PDF',
      params: [['x', '1']],
    },
  ];

  it.each(rows)('$name', ({ input, base, params }) => {
    const out = cleanLink(input);
    expect(shape(out)).toEqual({ base, params, hash: '' });
    if (params.length === 0) expect(out).not.toContain('?');
    expect(out).not.toContain('#');
  });

  it.each([
    ['https://example.edu/reading.pdf?b=2&a=1&utm_source=x#page=3', 'https://example.edu/reading.pdf?a=1&b=2'],
    ['https://example.edu/reading.pdf?utm_source=x', 'https://example.edu/reading.pdf'],
    ['https://example.edu/reading.pdf#page=3', 'https://example.edu/reading.pdf'],
    ['https://example.edu/reading.pdf?a=1&b=2', 'https://example.edu/reading.pdf?a=1&b=2'],
  ])('plain ASCII links come out as exact strings: %s', (input, expected) => {
    expect(cleanLink(input)).toBe(expected);
  });

  it('is idempotent: cleaning a clean link changes nothing', () => {
    for (const row of rows) {
      const once = cleanLink(row.input);
      expect(cleanLink(once), row.name).toBe(once);
    }
  });

  // canonicalLink is defined as "cleanLink + https + host rules", so "Copy link" must NOT apply the host rules itself:
  // a copied link has to still open the page the reader is looking at.
  it.each([
    ['keeps http', 'http://example.edu/a.pdf?utm_source=x', 'http://example.edu/a.pdf'],
    ['keeps a leading www.', 'http://www.jstor.org/stable/pdf/1234.pdf?utm_source=x', 'http://www.jstor.org/stable/pdf/1234.pdf'],
    ['keeps the arXiv version and /pdf/ form', 'https://arxiv.org/pdf/1706.03762v7?utm_source=x#page=2', 'https://arxiv.org/pdf/1706.03762v7'],
    ['keeps dx.doi.org', 'http://dx.doi.org/10.1371/journal.pone.0000308?utm_source=x', 'http://dx.doi.org/10.1371/journal.pone.0000308'],
    [
      'keeps the library-proxy host (the copied link must still work for the reader)',
      'https://www-jstor-org.ezproxy.lse.ac.uk/stable/10.2307/2118477?fbclid=1',
      'https://www-jstor-org.ezproxy.lse.ac.uk/stable/10.2307/2118477',
    ],
    [
      "keeps Moodle's revision number",
      'https://moodle.lse.ac.uk/pluginfile.php/1234567/mod_resource/content/2/Lecture%201.pdf?gclid=1',
      'https://moodle.lse.ac.uk/pluginfile.php/1234567/mod_resource/content/2/Lecture%201.pdf',
    ],
  ])('does not apply canonical host rules: %s', (_name, input, expected) => {
    expect(cleanLink(input)).toBe(expected);
  });

  // Other names that count as tracking or token. Key matching is case-insensitive (plan, cleanLink rule list).
  it.each([
    ['upper-case UTM_ keys from old mailing tools', 'https://example.edu/a.pdf?UTM_Source=mail&UTM_Campaign=w3&id=5', [['id', '5']] as Params],
    ['access_token', 'https://example.edu/files/a.pdf?access_token=ya29.a0AfH6SMB&id=5', [['id', '5']] as Params],
    // Spec decision (rule 4, "token parameters"): sesskey is Moodle's per-login session key. It never picks a document,
    // so it is always stripped, in any case, wherever it sits in the query.
    ['Moodle sesskey (spec decision)', 'https://moodle.lse.ac.uk/mod/resource/view.php?id=2345678&sesskey=Zk3d9aQwLm', [['id', '2345678']] as Params],
    ['Moodle sesskey first, in capitals (spec decision)', 'https://moodle.lse.ac.uk/mod/resource/view.php?SESSKEY=Zk3d9aQwLm&id=2345678', [['id', '2345678']] as Params],
    ['Moodle sesskey as the only param, no dangling "?" (spec decision)', 'https://moodle.lse.ac.uk/my/?sesskey=Zk3d9aQwLm', [] as Params],
    // R105 and the Phase 4 security read: sign-in and gift keys never stay in a stored link.
    ['accessToken (camel case)', 'https://example.edu/files/a.pdf?accessToken=eyJhbGciOi&id=5', [['id', '5']] as Params],
    ['ACCESS_TOKEN in capitals', 'https://example.edu/files/a.pdf?ACCESS_TOKEN=ya29.a0&id=5', [['id', '5']] as Params],
    ['token', 'https://example.edu/files/a.pdf?id=5&Token=abc123', [['id', '5']] as Params],
    ['an OAuth code', 'https://example.edu/callback/a.pdf?code=4%2F0AX4XfWh&id=5', [['id', '5']] as Params],
    ['a magic link auth', 'https://example.edu/a.pdf?auth=Zm9vYmFy&id=5', [['id', '5']] as Params],
    ['a signature sig (Azure SAS)', 'https://store.blob.core.windows.net/c/a.pdf?sv=2022-11-02&sig=abc%3D', [['sv', '2022-11-02']] as Params],
    ['signature', 'https://example.edu/a.pdf?Signature=abc&id=5', [['id', '5']] as Params],
    ['session', 'https://example.edu/a.pdf?id=5&session=s3cr3t', [['id', '5']] as Params],
    ['sessionId (camel case)', 'https://example.edu/a.pdf?sessionId=s3cr3t&id=5', [['id', '5']] as Params],
    ['SESSIONID in capitals', 'https://example.edu/a.pdf?id=5&SESSIONID=s3cr3t', [['id', '5']] as Params],
    ['a Medium gift link sk', 'https://medium.com/@someone/a-story-0123456789ab?sk=0f1e2d3c4b5a69788796a5b4c3d2e1f0', [] as Params],
    [
      'all of them at once, with tracking, only the param that picks the page stays',
      'https://example.com/x/page?sk=a&accessToken=b&code=c&auth=d&sig=e&session=f&sessionid=g&utm_source=nl&p=2',
      [['p', '2']] as Params,
    ],
  ])('%s is removed', (_name, input, params) => {
    const out = cleanLink(input);
    expect(shape(out).params).toEqual(params);
    if (params.length === 0) expect(out).not.toContain('?');
  });

  it('a value or a longer key that merely contains "sesskey" is not the session key (spec decision, negative)', () => {
    expect(shape(cleanLink('https://moodle.lse.ac.uk/help?topic=sesskey&x_sesskey=keep')).params).toEqual([
      ['topic', 'sesskey'],
      ['x_sesskey', 'keep'],
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('canonicalLink: https, case, fragments, trailing slashes', () => {
  it.each([
    ['http becomes https', 'http://example.edu/reading.pdf', 'https://example.edu/reading.pdf'],
    ['scheme and host case fold, a leading www. is dropped, path case is kept', 'HTTP://WWW.Example.EDU/Reading.PDF', 'https://example.edu/Reading.PDF'],
    ['a leading www. is dropped (plan vector)', 'http://www.jstor.org/stable/pdf/1234.pdf', 'https://jstor.org/stable/pdf/1234.pdf'],
    ['only a LEADING www. goes: a www. inside the host stays', 'https://docs.www.example.edu/a.pdf', 'https://docs.www.example.edu/a.pdf'],
    ['a trailing slash after a path is kept on purpose (/x and /x/ can be two resources on a server)', 'https://example.edu/course/syllabus/', 'https://example.edu/course/syllabus/'],
    ['the default port of http disappears with the upgrade', 'http://example.edu:80/a.pdf', 'https://example.edu/a.pdf'],
    ['the default https port disappears', 'https://example.edu:443/a.pdf', 'https://example.edu/a.pdf'],
    ['a non-default port is a different server and stays', 'https://example.edu:8443/a.pdf', 'https://example.edu:8443/a.pdf'],
    ['a fragment is dropped', 'https://example.edu/a.pdf#page=3', 'https://example.edu/a.pdf'],
    ['an https link with nothing to fix is returned as it was', 'https://example.edu/a.pdf', 'https://example.edu/a.pdf'],
    ['query params are sorted', 'https://example.edu/search?z=1&a=2', 'https://example.edu/search?a=2&z=1'],
  ])('%s', (_name, input, expected) => {
    expect(canonicalLink(input)).toBe(expected);
  });

  it('a bare host and the root path are the same place', () => {
    expectOneLocation(['https://example.edu', 'https://example.edu/', 'http://example.edu/#top']);
  });

  it('path case, query value case and different query values are different places (the server may treat them differently)', () => {
    expectAllDistinct([
      'https://example.edu/Reading.pdf',
      'https://example.edu/reading.pdf',
      'https://example.edu/view?id=AbC',
      'https://example.edu/view?id=abc',
      'https://example.edu/view?id=abd',
    ]);
  });

  it('the same paper reached through different campaign links is one place', () => {
    expectOneLocation([
      'https://www.nber.org/system/files/working_papers/w29000/w29000.pdf',
      'http://www.nber.org/system/files/working_papers/w29000/w29000.pdf?utm_source=newsletter&utm_medium=email',
      'https://www.nber.org/system/files/working_papers/w29000/w29000.pdf?fbclid=IwAR0Zx#page=9',
      'https://WWW.NBER.ORG/system/files/working_papers/w29000/w29000.pdf?gclid=Cj0KCQ',
    ]);
  });

  it('a trailing slash is kept, so /syllabus and /syllabus/ stay two places (merging them is the riskier direction)', () => {
    expectAllDistinct([
      'https://example.edu/course/syllabus',
      'https://example.edu/course/syllabus/',
      'https://example.edu/course-syllabus',
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('canonicalLink: a query parameter that picks a different document is never stripped', () => {
  const sameDocument: Array<[string, string, string]> = [
    [
      'order of params does not matter (PLOS)',
      'https://journals.plos.org/plosone/article/file?id=10.1371/journal.pone.0000308&type=printable',
      'https://journals.plos.org/plosone/article/file?type=printable&id=10.1371/journal.pone.0000308',
    ],
    [
      'tracking between real params (SSRN)',
      'https://papers.ssrn.com/sol3/Delivery.cfm?abstractid=3000000&utm_campaign=x&mirid=1',
      'https://papers.ssrn.com/sol3/Delivery.cfm?mirid=1&abstractid=3000000',
    ],
    [
      'Moodle page with a per-login sesskey (spec decision)',
      'https://moodle.lse.ac.uk/mod/resource/view.php?id=2345678&sesskey=Zk3d9aQwLm',
      'https://moodle.lse.ac.uk/mod/resource/view.php?id=2345678&sesskey=Q8wNxP2vTr',
    ],
    [
      'Moodle page with and without sesskey (spec decision)',
      'https://moodle.lse.ac.uk/mod/resource/view.php?sesskey=Zk3d9aQwLm&id=2345678',
      'https://moodle.lse.ac.uk/mod/resource/view.php?id=2345678',
    ],
    [
      'JSTOR ?seq=1 with a click id',
      'https://www.jstor.org/stable/10.2307/2118477?seq=1&fbclid=IwAR',
      'https://www.jstor.org/stable/10.2307/2118477?seq=1',
    ],
  ];
  it.each(sameDocument)('same document: %s', (_name, a, b) => {
    expectOneLocation([a, b]);
  });

  const differentDocument: Array<[string, string, string]> = [
    [
      'PLOS id',
      'https://journals.plos.org/plosone/article/file?id=10.1371/journal.pone.0000308&type=printable',
      'https://journals.plos.org/plosone/article/file?id=10.1371/journal.pone.0000309&type=printable',
    ],
    [
      'PLOS type (printable vs manuscript)',
      'https://journals.plos.org/plosone/article/file?id=10.1371/journal.pone.0000308&type=printable',
      'https://journals.plos.org/plosone/article/file?id=10.1371/journal.pone.0000308&type=manuscript',
    ],
    ['SSRN abstractid', 'https://papers.ssrn.com/sol3/Delivery.cfm?abstractid=3000000', 'https://papers.ssrn.com/sol3/Delivery.cfm?abstractid=3000001'],
    [
      'Moodle page id',
      'https://moodle.lse.ac.uk/mod/resource/view.php?id=2345678&utm_source=email',
      'https://moodle.lse.ac.uk/mod/resource/view.php?id=2345679&utm_source=email',
    ],
    ['viewer ?file=', 'https://example.edu/viewer?file=lecture2.pdf', 'https://example.edu/viewer?file=lecture3.pdf'],
    ['a value that merely mentions a tracking name', 'https://example.edu/go?source=utm_campaign', 'https://example.edu/go?source=other'],
    ['a param that is present at all', 'https://example.edu/dl?download', 'https://example.edu/dl'],
  ];
  it.each(differentDocument)('different document: %s', (_name, a, b) => {
    expectAllDistinct([a, b]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('canonicalLink: arXiv', () => {
  const ARXIV_NEW = [
    'https://arxiv.org/abs/1706.03762',
    'https://arxiv.org/pdf/1706.03762',
    'https://arxiv.org/pdf/1706.03762.pdf',
    'http://arxiv.org/abs/1706.03762',
    'https://arxiv.org/abs/1706.03762?utm_source=twitter&fbclid=IwAR0x',
    'https://arxiv.org/pdf/1706.03762#page=4',
    'HTTPS://ARXIV.ORG/abs/1706.03762',
  ];

  it('abs page, pdf link, pdf with .pdf, http, tracking, fragment and host case are all one place', () => {
    const canonical = expectOneLocation(ARXIV_NEW);
    expect(canonical).toMatch(/^https:\/\/arxiv\.org\/\S*1706\.03762(\.pdf)?$/);
  });

  it('old-style ids (archive/number) have the same abs, pdf and .pdf forms', () => {
    const canonical = expectOneLocation([
      'https://arxiv.org/abs/hep-th/9901001',
      'https://arxiv.org/pdf/hep-th/9901001',
      'https://arxiv.org/pdf/hep-th/9901001.pdf',
      'http://arxiv.org/abs/hep-th/9901001?utm_medium=email',
    ]);
    expect(canonical).toMatch(/^https:\/\/arxiv\.org\/\S*hep-th\/9901001(\.pdf)?$/);
  });

  it.each([
    ['5-digit new-style id', 'https://arxiv.org/pdf/2301.12345', '2301.12345'],
    ['4-digit new-style id (before 2015)', 'https://arxiv.org/pdf/1412.6980', '1412.6980'],
    ['old-style, hep-th', 'https://arxiv.org/abs/hep-th/9901001', 'hep-th/9901001'],
    ['old-style, hyphenated archive', 'https://arxiv.org/abs/cond-mat/0211034', 'cond-mat/0211034'],
    ['old-style, archive with subject class', 'https://arxiv.org/abs/math.GT/0309136', 'math.GT/0309136'],
  ])('the whole id survives, nothing is truncated: %s', (_name, input, id) => {
    expect(canonicalLink(input)).toContain(id);
  });

  it('different papers stay different, including the same number in a different archive', () => {
    expectAllDistinct([
      'https://arxiv.org/abs/1706.03762',
      'https://arxiv.org/abs/1706.03763',
      'https://arxiv.org/abs/1707.03762',
      'https://arxiv.org/abs/2301.12345',
      'https://arxiv.org/abs/2301.12346',
      'https://arxiv.org/abs/hep-th/9901001',
      'https://arxiv.org/abs/hep-ph/9901001',
      'https://arxiv.org/abs/hep-th/9901002',
    ]);
  });

  it('pages that are not a paper are left alone, and their paging params still count', () => {
    expect(canonicalLink('https://arxiv.org/list/cs.LG/recent?skip=25&show=25')).toBe('https://arxiv.org/list/cs.LG/recent?show=25&skip=25');
    expect(canonicalLink('https://arxiv.org/a/vaswani_a_1')).toBe('https://arxiv.org/a/vaswani_a_1');
    expect(canonicalLink('http://arxiv.org/help/submit#formats')).toBe('https://arxiv.org/help/submit');
    expectAllDistinct(['https://arxiv.org/list/cs.LG/recent?skip=0', 'https://arxiv.org/list/cs.LG/recent?skip=25']);
  });

  it.each([
    ['a host that only ends in the same letters', 'https://notarxiv.org/abs/1706.03762'],
    ['arxiv.org as the start of another domain', 'https://arxiv.org.mirror.example.net/abs/1706.03762v2'],
    ['a university mirror with the same path shape', 'https://mirror.example.edu/pdf/1706.03762v2'],
    ['arxiv as a path segment, not the host', 'https://example.edu/arxiv.org/abs/1706.03762v2'],
  ])('the arXiv rule does not touch other sites: %s', (_name, input) => {
    expect(canonicalLink(input)).toBe(input);
  });

  describe('the version suffix is not part of the identity of a link (plan rule 4)', () => {
    it.each([
      ['v1, v2 and v7 of 1706.03762 are one place', [...ARXIV_NEW.slice(0, 2), 'https://arxiv.org/abs/1706.03762v1', 'https://arxiv.org/pdf/1706.03762v7', 'https://arxiv.org/pdf/1706.03762v7.pdf']],
      ['5-digit id with a version', ['https://arxiv.org/abs/2301.12345', 'https://arxiv.org/pdf/2301.12345v2']],
      ['old-style id with a version', ['https://arxiv.org/abs/hep-th/9901001', 'https://arxiv.org/pdf/hep-th/9901001v2', 'https://arxiv.org/pdf/hep-th/9901001v2.pdf']],
    ])('%s', (_name, urls) => {
      expectOneLocation(urls);
    });
  });

  it('www.arxiv.org and export.arxiv.org map to arxiv.org (plan rules 3 and 4)', () => {
    expectOneLocation(['https://arxiv.org/abs/1706.03762', 'https://www.arxiv.org/abs/1706.03762', 'https://export.arxiv.org/abs/1706.03762']);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('canonicalLink: DOI', () => {
  const PLOS = '10.1371/journal.pone.0000308';

  it('doi.org, dx.doi.org, http and https, tracking and fragment are one place, written with doi.org over https', () => {
    const canonical = expectOneLocation([
      `https://doi.org/${PLOS}`,
      `http://doi.org/${PLOS}`,
      `https://dx.doi.org/${PLOS}`,
      `http://dx.doi.org/${PLOS}`,
      `https://doi.org/${PLOS}?utm_source=twitter&utm_medium=social`,
      `https://dx.doi.org/${PLOS}#abstract`,
    ]);
    expect(canonical).toBe(`https://doi.org/${PLOS}`);
  });

  it.each([
    ['parentheses and a slash in the suffix (Lancet)', 'https://doi.org/10.1016/S0140-6736(20)30183-5', 'https://doi.org/10.1016/s0140-6736(20)30183-5'],
    [
      'SICI-style DOI with ; : < > and slashes (Wiley / Statistics in Medicine)',
      'https://doi.org/10.1002/(SICI)1097-0258(19980815/30)17:15/16%3C1661::AID-SIM968%3E3.0.CO;2-2',
      'https://doi.org/10.1002/(sici)1097-0258(19980815/30)17:15/16<1661::aid-sim968>3.0.co;2-2',
    ],
    ['dx.doi.org with such a DOI', 'http://dx.doi.org/10.1016/S0140-6736(20)30183-5', 'https://doi.org/10.1016/s0140-6736(20)30183-5'],
  ])('the DOI is not cut short: %s', (_name, input, lowerDecoded) => {
    // compared lower-cased and decoded, so this does not depend on the case or percent-encoding choice
    expect(decodeURIComponent(canonicalLink(input)).toLowerCase()).toBe(lowerDecoded);
  });

  it('different DOIs stay different, including a different publisher prefix and a different last digit', () => {
    expectAllDistinct([
      `https://doi.org/${PLOS}`,
      'https://doi.org/10.1371/journal.pone.0000309',
      'https://doi.org/10.1372/journal.pone.0000308',
      'https://doi.org/10.1016/j.jfineco.2020.01.001',
    ]);
  });

  it.each([
    ['the doi.org front page', 'https://doi.org/', 'https://doi.org/'],
    ['a "doi" word in the path that is not a DOI', 'https://example.edu/doi/help', 'https://example.edu/doi/help'],
    ['a doi= param on another site selects the lookup and stays', 'https://scholar.example.edu/lookup?doi=10.1371/journal.pone.0000308', 'https://scholar.example.edu/lookup?doi=10.1371/journal.pone.0000308'],
    ['doi.org as the start of another domain', 'https://doi.org.example.net/10.1371/journal.pone.0000308', 'https://doi.org.example.net/10.1371/journal.pone.0000308'],
    ['a host that only ends in doi.org', 'https://mydoi.org/10.1371/journal.pone.0000308', 'https://mydoi.org/10.1371/journal.pone.0000308'],
  ])('left alone: %s', (_name, input, expected) => {
    const out = canonicalLink(input);
    expect(shape(out)).toEqual(shape(expected));
  });

  it.each([
    ['Springer PDF', 'https://link.springer.com/content/pdf/10.1007/s11142-020-09562-0.pdf', '10.1007/s11142-020-09562-0'],
    ['Wiley /doi/pdf/', 'https://onlinelibrary.wiley.com/doi/pdf/10.1111/jofi.12345?download=true', '10.1111/jofi.12345'],
    ['Taylor & Francis', 'https://www.tandfonline.com/doi/pdf/10.1080/00220485.2019.1234567', '10.1080/00220485.2019.1234567'],
  ])('a DOI inside a publisher link is never truncated: %s', (_name, input, doi) => {
    expect(canonicalLink(input).toLowerCase()).toContain(doi.toLowerCase());
  });

  it('two different DOIs on the same publisher stay different', () => {
    expectAllDistinct([
      'https://onlinelibrary.wiley.com/doi/pdf/10.1111/jofi.12345',
      'https://onlinelibrary.wiley.com/doi/pdf/10.1111/jofi.12346',
    ]);
  });

  it('DOIs are case-insensitive: the DOI is written lower-case (plan vector)', () => {
    expect(canonicalLink('http://dx.doi.org/10.1371/JOURNAL.PONE.0000308')).toBe('https://doi.org/10.1371/journal.pone.0000308');
    expectOneLocation([`https://doi.org/${PLOS}`, 'https://doi.org/10.1371/JOURNAL.PONE.0000308']);
  });

  it('a %2F in place of the slash is the same DOI (plan vector)', () => {
    expect(canonicalLink('https://doi.org/10.1000%2F182')).toBe('https://doi.org/10.1000/182');
    expectOneLocation([`https://doi.org/${PLOS}`, 'https://doi.org/10.1371%2Fjournal.pone.0000308']);
  });

  // Publisher pages are not merged: /doi/ and /doi/epdf/ are web pages, /doi/pdf/ is the PDF. Joining them would be a merge
  // nobody asked for. A PDF seen at two links still gets one fingerprint, so the notes are found anyway.
  it.each([
    ['Wiley', ['https://onlinelibrary.wiley.com/doi/10.1111/jofi.12345', 'https://onlinelibrary.wiley.com/doi/pdf/10.1111/jofi.12345', 'https://onlinelibrary.wiley.com/doi/epdf/10.1111/jofi.12345']],
    ['Taylor & Francis', ['https://www.tandfonline.com/doi/full/10.1080/00220485.2019.1234567', 'https://www.tandfonline.com/doi/pdf/10.1080/00220485.2019.1234567']],
  ])('publisher %s: the /doi/ page forms of one DOI stay separate places', (_name, urls) => {
    expectAllDistinct(urls);
  });

  it('a publisher /doi/pdf/ link is kept as written (plan vector, after the proxy host is mapped back)', () => {
    expect(canonicalLink('https://onlinelibrary-wiley-com.ezp.lib.cam.ac.uk/doi/pdf/10.1111/x')).toBe('https://onlinelibrary.wiley.com/doi/pdf/10.1111/x');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('canonicalLink: Moodle revision number', () => {
  const file = (host: string, rev: number | string, name = 'Lecture%201.pdf', ctx = 1234567) =>
    `https://${host}/pluginfile.php/${ctx}/mod_resource/content/${rev}/${name}`;

  it.each(['moodle.lse.ac.uk', 'learn.example.edu', 'vle.exeter.ac.uk'])(
    'a re-uploaded file (revision 1, 2, 9, 15) is one place on %s, whatever the university calls its Moodle',
    (host) => {
      expectOneLocation([file(host, 1), file(host, 2), file(host, 9), file(host, 15)]);
    },
  );

  it('keeps the file name and the context id, and drops the revision itself', () => {
    const out = decodeURIComponent(canonicalLink(file('moodle.lse.ac.uk', 7)));
    expect(out).toContain('Lecture 1.pdf');
    expect(out).toContain('/pluginfile.php/1234567/mod_resource/');
    expect(out).not.toContain('/content/7/');
  });

  it('http, tracking and a fragment on top of a new revision are still one place', () => {
    expectOneLocation([
      file('moodle.lse.ac.uk', 2),
      'http://moodle.lse.ac.uk/pluginfile.php/1234567/mod_resource/content/3/Lecture%201.pdf?utm_source=email#page=4',
    ]);
  });

  it('a Moodle web-service link: the token goes (it changes per login) and so does the revision', () => {
    expectOneLocation([
      'https://moodle.lse.ac.uk/webservice/pluginfile.php/1234567/mod_resource/content/4/Lecture%201.pdf?token=0a1b2c3d4e5f6071',
      'https://moodle.lse.ac.uk/webservice/pluginfile.php/1234567/mod_resource/content/9/Lecture%201.pdf?token=ffffeeeeddddcccc',
    ]);
  });

  it('different files stay different: other file name, other context, sub-folder, year folder after the revision', () => {
    expectAllDistinct([
      file('moodle.lse.ac.uk', 2, 'Lecture%201.pdf'),
      file('moodle.lse.ac.uk', 2, 'Lecture%202.pdf'),
      file('moodle.lse.ac.uk', 2, 'Lecture%201.pdf', 1234568),
      file('moodle.lse.ac.uk', 2, 'Week%203/Reading%202.pdf'),
      file('moodle.lse.ac.uk', 2, 'Week%204/Reading%202.pdf'),
      file('moodle.lse.ac.uk', 3, '2024/notes.pdf'),
      file('moodle.lse.ac.uk', 3, '2025/notes.pdf'),
    ]);
  });

  it('only the revision goes: a numeric folder after it, and a same-revision sub-folder, keep their place', () => {
    // the revision differs but the folder 2024 must not be eaten as "a second revision"
    expectOneLocation([file('moodle.lse.ac.uk', 3, '2024/notes.pdf'), file('moodle.lse.ac.uk', 8, '2024/notes.pdf')]);
    expect(decodeURIComponent(canonicalLink(file('moodle.lse.ac.uk', 3, '2024/notes.pdf')))).toContain('/2024/notes.pdf');
  });

  it('the same file name in another place is another file: forum attachments are numbered by post, not by revision', () => {
    expectAllDistinct([
      'https://moodle.lse.ac.uk/pluginfile.php/55/mod_forum/attachment/1001/slides.pdf',
      'https://moodle.lse.ac.uk/pluginfile.php/55/mod_forum/attachment/1002/slides.pdf',
    ]);
  });

  it.each([
    ['a /content/<n>/ path on a site that is not Moodle', 'https://example.org/content/2/report.pdf', 'https://example.org/content/3/report.pdf'],
    ['mod_resource/content/<n>/ without pluginfile.php', 'https://example.org/files/mod_resource/content/2/x.pdf', 'https://example.org/files/mod_resource/content/3/x.pdf'],
    ['a revision-looking number in a normal query', 'https://example.edu/get?path=content/2/x.pdf', 'https://example.edu/get?path=content/3/x.pdf'],
  ])('the rule only applies to Moodle: %s', (_name, a, b) => {
    expect(shape(canonicalLink(a))).toEqual(shape(a));
    expect(shape(canonicalLink(b))).toEqual(shape(b));
    expectAllDistinct([a, b]);
  });

  it('query strings on a Moodle page link still pick the page; tracking on it goes', () => {
    expectAllDistinct([
      'https://moodle.lse.ac.uk/mod/resource/view.php?id=2345678',
      'https://moodle.lse.ac.uk/mod/resource/view.php?id=2345679',
    ]);
    expectOneLocation([
      'https://moodle.lse.ac.uk/mod/resource/view.php?id=2345678',
      'http://moodle.lse.ac.uk/mod/resource/view.php?utm_source=email&id=2345678',
    ]);
  });

  // Spec decision (rule 4, "Moodle's revision number removed"): when Moodle has slash-arguments off, the file link is
  // pluginfile.php?file=/<ctx>/mod_resource/content/<rev>/<name>. The revision hides in the query value. It becomes 0,
  // exactly as in the path form; the file= param, the rest of its value and its place in the query stay.
  describe('the older ?file= form of a Moodle file link (spec decision)', () => {
    const legacy = (rev: number, name = 'Lecture1.pdf', component = 'mod_resource', ctx = 1234567) =>
      `https://moodle.lse.ac.uk/pluginfile.php?file=${encodeURIComponent(`/${ctx}/${component}/content/${rev}/${name}`)}`;
    const fileParam = (url: string) => new URL(canonicalLink(url)).searchParams.get('file');

    it('the revision inside file= becomes 0, and file= itself is never stripped', () => {
      expect(shape(canonicalLink(legacy(7)))).toEqual({
        base: 'https://moodle.lse.ac.uk/pluginfile.php',
        params: [['file', '/1234567/mod_resource/content/0/Lecture1.pdf']],
        hash: '',
      });
      expectOneLocation([legacy(2), legacy(5), legacy(0)]);
    });

    it.each(['mod_resource', 'mod_folder', 'mod_page', 'mod_book'])('%s: revision 12 becomes 0', (component) => {
      expect(fileParam(legacy(12, 'a.pdf', component))).toBe(`/1234567/${component}/content/0/a.pdf`);
    });

    it('a ?file= value that is not a revisioned file keeps its numbers (forum attachment post id, label intro, viewer file name)', () => {
      expect(fileParam('https://moodle.lse.ac.uk/pluginfile.php?file=%2F55%2Fmod_forum%2Fattachment%2F1001%2Fslides.pdf')).toBe(
        '/55/mod_forum/attachment/1001/slides.pdf',
      );
      expect(fileParam('https://moodle.lse.ac.uk/pluginfile.php?file=%2F99%2Fmod_label%2Fintro%2Fa.pdf')).toBe('/99/mod_label/intro/a.pdf');
      expect(fileParam('https://example.edu/viewer?file=%2F1234567%2Fmod_resource%2Fcontent%2F2%2Fa.pdf')).toBe('/1234567/mod_resource/content/2/a.pdf');
    });

    it('different files stay different: file name, context id, sub-folder', () => {
      expectAllDistinct([
        legacy(2, 'Lecture1.pdf'),
        legacy(2, 'Lecture2.pdf'),
        legacy(2, 'Lecture1.pdf', 'mod_resource', 1234568),
        legacy(2, 'Week3/Lecture1.pdf'),
      ]);
    });

    it('other params stay and tracking goes', () => {
      const out = canonicalLink(`${legacy(3)}&utm_source=email&lang=en`);
      expect(shape(out).params).toEqual([
        ['file', '/1234567/mod_resource/content/0/Lecture1.pdf'],
        ['lang', 'en'],
      ]);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('canonicalLink: library-proxy (EZproxy) hosts are mapped back', () => {
  it.each([
    [
      'JSTOR through the LSE proxy (research note 04: www-jstor-org.<proxy>.ac.uk); the www. goes',
      'https://www-jstor-org.ezproxy.lse.ac.uk/stable/10.2307/2118477',
      'https://jstor.org/stable/10.2307/2118477',
    ],
    [
      'ScienceDirect, plain http, tracking',
      'http://www-sciencedirect-com.ezproxy.cam.ac.uk/science/article/pii/S0304405X20300015?utm_source=lib',
      'https://sciencedirect.com/science/article/pii/S0304405X20300015',
    ],
    [
      'SSRN keeps its real query, sorted',
      'https://papers-ssrn-com.ezproxy.lse.ac.uk/sol3/Delivery.cfm/SSRN_ID3000000_code123.pdf?mirid=1&abstractid=3000000',
      'https://papers.ssrn.com/sol3/Delivery.cfm/SSRN_ID3000000_code123.pdf?abstractid=3000000&mirid=1',
    ],
    [
      'IEEE through a libproxy host',
      'https://ieeexplore-ieee-org.libproxy.york.ac.uk/document/9000000',
      'https://ieeexplore.ieee.org/document/9000000',
    ],
    [
      'Oxford Academic through a deeper proxy name',
      'https://academic-oup-com.login.ezproxy.library.ox.ac.uk/qje/article-pdf/135/2/123/1.pdf',
      'https://academic.oup.com/qje/article-pdf/135/2/123/1.pdf',
    ],
    [
      'a hyphen in the real host is doubled by EZproxy and must come back as one hyphen',
      'https://www-econ--papers-org.ezproxy.lse.ac.uk/a.pdf',
      'https://econ-papers.org/a.pdf',
    ],
    [
      'proxy host in capitals',
      'https://WWW-JSTOR-ORG.EZPROXY.LSE.AC.UK/stable/10.2307/2118477',
      'https://jstor.org/stable/10.2307/2118477',
    ],
  ])('%s', (_name, input, expected) => {
    expect(canonicalLink(input)).toBe(expected);
  });

  it('a proxied link and the direct link are the same place', () => {
    expectOneLocation([
      'https://www.jstor.org/stable/10.2307/2118477',
      'https://www-jstor-org.ezproxy.lse.ac.uk/stable/10.2307/2118477',
      'https://www-jstor-org.libproxy.york.ac.uk/stable/10.2307/2118477#page=3',
    ]);
  });

  it('proxy mapping and the other host rules work together (arXiv, DOI)', () => {
    expectOneLocation(['https://arxiv.org/abs/1706.03762', 'https://arxiv-org.ezproxy.lse.ac.uk/pdf/1706.03762']);
    expectOneLocation(['https://doi.org/10.1371/journal.pone.0000308', 'http://doi-org.ezproxy.lse.ac.uk/10.1371/journal.pone.0000308?utm_source=x']);
  });

  it.each([
    ['a GitHub Pages site with a hyphenated name', 'https://my-course-site.github.io/notes.pdf', 'https://my-course-site.github.io/notes.pdf'],
    ['a university department host with hyphens', 'https://dept-of-economics.lse.ac.uk/papers/w1.pdf', 'https://dept-of-economics.lse.ac.uk/papers/w1.pdf'],
    // the hyphen in econ-papers is left alone; only the leading www. goes (plan vector: www.ezproxy-docs.org -> ezproxy-docs.org)
    ['hyphens in the real domain, not the first label (only the www. goes)', 'https://www.econ-papers.org/a.pdf', 'https://econ-papers.org/a.pdf'],
    ['the word "ezproxy" in a hyphenated real domain', 'https://www.ezproxy-docs.org/a.pdf', 'https://ezproxy-docs.org/a.pdf'],
    ['a CDN host with hyphens', 'https://cdn-assets-prod.cloudfront.net/report.pdf', 'https://cdn-assets-prod.cloudfront.net/report.pdf'],
    ["the proxy's own login page, nothing proxied in it", 'https://ezproxy.lse.ac.uk/login', 'https://ezproxy.lse.ac.uk/login'],
    ['the word ezproxy in a path', 'https://example.edu/ezproxy/guide.pdf', 'https://example.edu/ezproxy/guide.pdf'],
  ])('a host that is not proxy-rewritten is left alone: %s', (_name, input, expected) => {
    expect(canonicalLink(input)).toBe(expected);
  });

  describe('the login?url= and ?qurl= forms of an EZproxy link (plan rule 1)', () => {
    it.each([
      ['url=', 'https://ezproxy.lse.ac.uk/login?url=https://www.jstor.org/stable/10.2307/2118477'],
      ['qurl= (encoded)', 'https://ezproxy.lse.ac.uk/login?qurl=https%3A%2F%2Fwww.jstor.org%2Fstable%2F10.2307%2F2118477'],
    ])('%s leads to the real page', (_name, input) => {
      expect(canonicalLink(input)).toBe('https://jstor.org/stable/10.2307/2118477');
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('canonicalLink: anything that is not http(s) comes back untouched', () => {
  it.each([
    ['a local file with a fragment', 'file:///C:/Users/Rex/Downloads/paper.pdf#page=3'],
    ['our own viewer page (tracking-looking param and all)', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/viewer.html?file=https%3A%2F%2Fexample.edu%2Fa.pdf&utm_source=x#p=2'],
    ['a blob URL', 'blob:https://example.edu/6f1e2c9a-0b1c-4d5e-8f70-123456789abc'],
    ['mailto with a tracking-like word', 'mailto:rex@example.com?subject=utm_source'],
    ['ftp keeps its scheme', 'ftp://ftp.example.edu/pub/a.pdf?utm_source=x'],
    ['data URL', 'data:application/pdf;base64,JVBERi0xLjQK'],
    ['about:blank', 'about:blank'],
  ])('%s', (_name, input) => {
    expect(canonicalLink(input)).toBe(input);
  });

  describe('guess: text that is not a URL at all does not throw and comes back unchanged', () => {
    it.each(['', 'not a url', 'C:\\Users\\Rex\\paper.pdf'])('%j', (input) => {
      expect(canonicalLink(input)).toBe(input);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('canonicalLink: properties over a mixed list of real-world links', () => {
  const corpus = [
    'http://arxiv.org/pdf/1706.03762v2?utm_source=x#page=2',
    'https://arxiv.org/abs/hep-th/9901001v2',
    'http://dx.doi.org/10.1016/S0140-6736(20)30183-5?fbclid=abc',
    'https://doi.org/10.1002/(SICI)1097-0258(19980815/30)17:15/16%3C1661::AID-SIM968%3E3.0.CO;2-2',
    'https://onlinelibrary.wiley.com/doi/pdf/10.1111/jofi.12345?download=true&utm_campaign=x',
    'https://moodle.lse.ac.uk/pluginfile.php/1234567/mod_resource/content/12/Week%203/Reading%202.pdf?forcedownload=1',
    'https://moodle.lse.ac.uk/webservice/pluginfile.php/1234567/mod_resource/content/2/Lecture1.pdf?token=0a1b2c',
    'http://www-jstor-org.ezproxy.lse.ac.uk/stable/10.2307/2118477?seq=1&gclid=1',
    'https://www-econ--papers-org.ezproxy.lse.ac.uk/a.pdf',
    'https://journals.plos.org/plosone/article/file?type=printable&id=10.1371/journal.pone.0000308&utm_source=x',
    'https://www.nature.com/articles/s41586-021-03819-2.pdf',
    'https://cdn.cs50.net/2023/fall/lectures/0/lecture0.pdf#page=9',
    'https://ocw.mit.edu/courses/14-01-principles-of-microeconomics-fall-2023/mit14_01_f23_pset4sol.pdf',
    'https://example.edu/Docs/Reading.PDF?b=2&a=1',
    'file:///C:/Users/Rex/Downloads/paper%20(1).pdf',
    'chrome-extension://abcdefghijklmnopabcdefghijklmnop/viewer.html?file=x',
  ];

  it.each(corpus)('is idempotent: canonical(canonical(x)) = canonical(x) for %s', (input) => {
    const once = canonicalLink(input);
    expect(canonicalLink(once)).toBe(once);
  });

  it.each(corpus.filter((u) => /^https?:/.test(u)))('every web link comes out https, with no fragment and no tracking keys: %s', (input) => {
    const out = canonicalLink(input);
    expect(out.startsWith('https://')).toBe(true);
    expect(out).not.toContain('#');
    for (const key of new URL(out).searchParams.keys()) {
      expect(key.startsWith('utm_') || key === 'fbclid' || key === 'gclid' || key === 'token', `key ${key} in ${out}`).toBe(false);
    }
  });

  it('is a pure function of its input', () => {
    for (const input of corpus) expect(canonicalLink(input)).toBe(canonicalLink(input));
  });
});

// The spec's story: the same paper arrives from different places and has to be one library entry.
describe('walkthrough: the same paper from different links', () => {
  it('a search-result click, a tweet, the library proxy and a typed link all land on one place', () => {
    expectOneLocation([
      'https://arxiv.org/pdf/1706.03762?utm_source=google&gclid=Cj0KCQ',
      'http://arxiv.org/abs/1706.03762?fbclid=IwAR1#page=2',
      'https://arxiv-org.ezproxy.lse.ac.uk/pdf/1706.03762.pdf',
      'https://arxiv.org/abs/1706.03762',
    ]);
  });
});

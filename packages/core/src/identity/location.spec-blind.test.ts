// Spec-blind tests for canonicalFileLocation, canonicalLocation and locationId (Task 18).
//
// Source of the rules:
//   spec, identity rule 4: "... Local file paths are kept as locations only."
//   spec, identity rule 5: "A location's id is a hash of its canonical link" (same on every device).
//   interface: locationId(kind, canonical) = sha256Hex(`${kind}:${canonical}`) (kind is 'url' or 'file').
//   spec, walkthrough 9: "You move, rename or re-download a file. Same contents, same fingerprint, same notes.
//   The library records the new location."
// The oracle for the hash is Web Crypto, never the code under test.
import { describe, expect, it } from 'vitest';
import { canonicalFileLocation, canonicalLink, canonicalLocation, locationId, sha256Hex } from '../index';

const HEX64 = /^[0-9a-f]{64}$/;

async function oracle(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function expectOneFile(urls: string[]): string {
  const outs = urls.map((u) => canonicalFileLocation(u));
  outs.forEach((out, i) => expect(out, `canonicalFileLocation(${urls[i]}) = ${out}`).toBe(outs[0]));
  return outs[0];
}

function expectAllDistinctFiles(urls: string[]): void {
  const outs = urls.map((u) => canonicalFileLocation(u));
  expect(new Set(outs).size, `canonical forms: ${outs.join('  |  ')}`).toBe(urls.length);
}

// ---------------------------------------------------------------------------------------------------------------------
describe('canonicalFileLocation: one file on disk has one location', () => {
  const PAPER = 'file:///C:/Users/Rex/Downloads/paper.pdf';

  it('stays a file location and keeps the folder and file name', () => {
    const out = canonicalFileLocation(PAPER);
    expect(out.startsWith('file:')).toBe(true);
    expect(out.toLowerCase().endsWith('/users/rex/downloads/paper.pdf')).toBe(true);
  });

  it('a viewer fragment is not part of the location (#page=, #zoom=, #nameddest=)', () => {
    expectOneFile([PAPER, `${PAPER}#page=12`, `${PAPER}#zoom=150`, `${PAPER}#nameddest=sec3`, `${PAPER}#`]);
  });

  it.each([
    ['spaces and accents, typed or encoded', 'file:///C:/Users/Rex/Downloads/Caf%C3%A9%20Econ.pdf', 'file:///C:/Users/Rex/Downloads/Caf\u00e9 Econ.pdf'],
    ['Windows backslashes', 'file:///C:/Users/Rex/Downloads/paper.pdf', 'file:///C:\\Users\\Rex\\Downloads\\paper.pdf'],
    ['an explicit localhost host', 'file:///C:/Users/Rex/Downloads/paper.pdf', 'file://localhost/C:/Users/Rex/Downloads/paper.pdf'],
    ['a copy "(1)" written two ways', 'file:///C:/Users/Rex/Downloads/paper%20(1).pdf', 'file:///C:/Users/Rex/Downloads/paper (1).pdf'],
  ])('different spellings of the same path are one location: %s', (_name, a, b) => {
    expectOneFile([a, b]);
  });

  it('is idempotent', () => {
    for (const input of [PAPER, `${PAPER}#page=3`, 'file:///C:\\Users\\Rex\\Downloads\\Caf\u00e9 Econ.pdf', 'file://fileserver/share/readings/w1.pdf']) {
      const once = canonicalFileLocation(input);
      expect(canonicalFileLocation(once), input).toBe(once);
    }
  });

  describe('moved, renamed or copied files are other locations (the fingerprint, not the location, finds the notes)', () => {
    it.each([
      ['moved to another folder', PAPER, 'file:///C:/Users/Rex/Documents/EC1A1/paper.pdf'],
      ['renamed', PAPER, 'file:///C:/Users/Rex/Downloads/paper-final.pdf'],
      ['browser copy "paper (1).pdf" next to paper.pdf', PAPER, 'file:///C:/Users/Rex/Downloads/paper%20(1).pdf'],
      ['another drive', PAPER, 'file:///D:/Users/Rex/Downloads/paper.pdf'],
      ['same path on a network server vs on this PC', 'file://fileserver/share/readings/w1.pdf', 'file:///share/readings/w1.pdf'],
      ['same share path on two network servers', 'file://fileserver/share/readings/w1.pdf', 'file://otherserver/share/readings/w1.pdf'],
    ])('%s', (_name, a, b) => {
      expectAllDistinctFiles([a, b]);
    });
  });

  describe('characters that are legal in Windows file names must not be mistaken for URL syntax', () => {
    it('a "#" in a file name (C# notes) is part of the name, not the start of a fragment', () => {
      const withHash = 'file:///C:/Users/Rex/Downloads/C%23%20intro.pdf';
      expectAllDistinctFiles([withHash, 'file:///C:/Users/Rex/Downloads/C', 'file:///C:/Users/Rex/Downloads/C%20intro.pdf']);
      const once = canonicalFileLocation(withHash);
      expect(canonicalFileLocation(once)).toBe(once);
    });

    it('"+" is a plus in a file name, not a space', () => {
      expectAllDistinctFiles(['file:///C:/Users/Rex/Downloads/a+b.pdf', 'file:///C:/Users/Rex/Downloads/a%20b.pdf']);
    });

    it('a file really named "a%20b.pdf" (written a%2520b.pdf) is not decoded twice into "a b.pdf"', () => {
      expectAllDistinctFiles(['file:///C:/Users/Rex/Downloads/a%2520b.pdf', 'file:///C:/Users/Rex/Downloads/a%20b.pdf']);
    });

    it('web link clean-up never applies: a file called utm_source=notes.pdf keeps its name', () => {
      const out = canonicalFileLocation('file:///C:/Users/Rex/Downloads/utm_source=notes.pdf');
      expect(out.startsWith('file:')).toBe(true);
      expect(decodeURIComponent(out)).toContain('utm_source=notes.pdf');
    });
  });

  describe('guesses', () => {
    it('the drive letter case does not matter (Chrome writes C:, other tools write c:)', () => {
      expectOneFile(['file:///C:/Users/Rex/Downloads/paper.pdf', 'file:///c:/Users/Rex/Downloads/paper.pdf']);
    });

    it('hex digits in percent-escapes do not matter (%C3%A9 = %c3%a9)', () => {
      expectOneFile(['file:///C:/Users/Rex/Downloads/Caf%C3%A9.pdf', 'file:///C:/Users/Rex/Downloads/Caf%c3%a9.pdf']);
    });

    it('Windows paths are case-insensitive, so Paper.PDF and paper.pdf in the same folder are one location', () => {
      expectOneFile(['file:///C:/Users/Rex/Downloads/Paper.PDF', 'file:///c:/users/rex/downloads/paper.pdf']);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('canonicalLocation: picks the canonical form that matches the kind', () => {
  it.each([
    ['tracking and http on an arXiv link', 'http://arxiv.org/pdf/1706.03762v2?utm_source=x#page=3'],
    ['library proxy host', 'https://www-jstor-org.ezproxy.lse.ac.uk/stable/10.2307/2118477?seq=1'],
    ['Moodle revision', 'https://moodle.lse.ac.uk/pluginfile.php/1234567/mod_resource/content/2/Lecture%201.pdf?forcedownload=1'],
    ['dx.doi.org', 'http://dx.doi.org/10.1371/journal.pone.0000308'],
  ])('kind "url" is canonicalLink: %s', (_name, raw) => {
    expect(canonicalLocation('url', raw)).toBe(canonicalLink(raw));
  });

  it.each([
    ['plain path', 'file:///C:/Users/Rex/Downloads/paper.pdf'],
    ['with a viewer fragment', 'file:///C:/Users/Rex/Downloads/paper.pdf#page=3'],
    ['accents and backslashes', 'file:///C:\\Users\\Rex\\Downloads\\Caf\u00e9 Econ.pdf'],
    ['network share', 'file://fileserver/share/readings/w1.pdf'],
  ])('kind "file" is canonicalFileLocation: %s', (_name, raw) => {
    expect(canonicalLocation('file', raw)).toBe(canonicalFileLocation(raw));
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('locationId: sha256 of "<kind>:<canonical>" (plan Amendment R16)', () => {
  const rows: Array<[string, 'url' | 'file', string]> = [
    ['an arXiv link', 'url', 'https://arxiv.org/abs/1706.03762'],
    ['a DOI link', 'url', 'https://doi.org/10.1371/journal.pone.0000308'],
    ['a local file', 'file', 'file:///C:/Users/Rex/Downloads/paper.pdf'],
    ['a network share', 'file', 'file://fileserver/share/readings/w1.pdf'],
    ['a non-ASCII link is hashed as UTF-8', 'url', 'https://example.edu/Caf\u00e9/\u65e5\u672c\u8a9e.pdf'],
    ['an empty canonical form still has a defined id', 'url', ''],
  ];

  it.each(rows)('%s: equals SHA-256 of kind + ":" + canonical, as 64 lowercase hex', async (_name, kind, canonical) => {
    const id = await locationId(kind, canonical);
    expect(id).toMatch(HEX64);
    expect(id).toBe(await oracle(`${kind}:${canonical}`));
    expect(id).toBe(await sha256Hex(`${kind}:${canonical}`));
  });

  it.each([
    ['url', 'https://arxiv.org/abs/1706.03762', '7fb971d68b06400464b1688946dda2be5a64033ec49ca8371651c4b6e3c3d0ed'],
    ['url', 'https://doi.org/10.1371/journal.pone.0000308', '4c4be815be8b09d254eb51309b7fe8ddf9451a8a054e0b8378319a65bffef398'],
    ['file', 'file:///C:/Users/Rex/Downloads/paper.pdf', 'ffad71e6bc96b2f444d379568a04c98657004a7d64ee2f9d76ee63f864a94409'],
  ] as const)('pinned ids: %s %s never changes between versions or devices', async (kind, canonical, expected) => {
    // Ids sync across devices; if the format ever drifted, every stored location would be orphaned.
    expect(await locationId(kind, canonical)).toBe(expected);
  });

  it('the kind is part of the id: the same text as a url and as a file are different locations', async () => {
    const asUrl = await locationId('url', 'file:///C:/Users/Rex/Downloads/paper.pdf');
    const asFile = await locationId('file', 'file:///C:/Users/Rex/Downloads/paper.pdf');
    expect(asUrl).not.toBe(asFile);
  });

  it('hashes the string it is given: it does not canonicalise again, and a one-character change is a new id', async () => {
    const literal = await locationId('url', 'HTTP://Example.EDU/a.pdf?utm_source=x#frag');
    expect(literal).toBe(await oracle('url:HTTP://Example.EDU/a.pdf?utm_source=x#frag'));
    const ids = await Promise.all([
      locationId('url', 'https://example.edu/a.pdf'),
      locationId('url', 'https://example.edu/a.pdf/'),
      locationId('url', 'https://example.edu/A.pdf'),
      locationId('url', 'http://example.edu/a.pdf'),
    ]);
    expect(new Set(ids).size).toBe(4);
  });

  it('is the same every time (two devices, two calls)', async () => {
    const a = await locationId('url', 'https://arxiv.org/abs/1706.03762');
    const b = await locationId('url', 'https://arxiv.org/abs/1706.03762');
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('walkthroughs: raw link or path to location id, then to the library', () => {
  function idOf(kind: 'url' | 'file', raw: string): Promise<string> {
    return locationId(kind, canonicalLocation(kind, raw));
  }

  it('the same paper from different links has one location id (spec: "same paper from different links")', async () => {
    const ids = await Promise.all([
      idOf('url', 'https://arxiv.org/abs/1706.03762'),
      idOf('url', 'http://arxiv.org/pdf/1706.03762?utm_source=google&gclid=Cj0KCQ'),
      idOf('url', 'https://arxiv.org/pdf/1706.03762.pdf#page=4'),
      idOf('url', 'https://arxiv-org.ezproxy.lse.ac.uk/pdf/1706.03762'),
    ]);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toMatch(HEX64);
  });

  it('a Moodle file re-uploaded as revision 3 has the same location id as revision 2', async () => {
    const rev2 = await idOf('url', 'https://moodle.lse.ac.uk/pluginfile.php/1234567/mod_resource/content/2/Lecture%201.pdf');
    const rev3 = await idOf('url', 'https://moodle.lse.ac.uk/pluginfile.php/1234567/mod_resource/content/3/Lecture%201.pdf');
    expect(rev3).toBe(rev2);
  });

  it('different papers have different location ids', async () => {
    const ids = await Promise.all([
      idOf('url', 'https://arxiv.org/abs/1706.03762'),
      idOf('url', 'https://arxiv.org/abs/1706.03763'),
      idOf('url', 'https://doi.org/10.1371/journal.pone.0000308'),
      idOf('url', 'https://journals.plos.org/plosone/article/file?id=10.1371/journal.pone.0000308&type=printable'),
    ]);
    expect(new Set(ids).size).toBe(4);
  });

  it('moving a file keeps its fingerprint (document id) and gives the new place its own location id', async () => {
    const bytes = new Uint8Array(50_000).map((_, i) => (i * 31 + 7) & 0xff);
    const before = await sha256Hex(bytes);
    const after = await sha256Hex(new Uint8Array(bytes)); // same bytes read from the new folder
    expect(after).toBe(before);

    const oldPlace = await idOf('file', 'file:///C:/Users/Rex/Downloads/paper.pdf');
    const newPlace = await idOf('file', 'file:///C:/Users/Rex/Documents/EC1A1/paper.pdf');
    expect(newPlace).not.toBe(oldPlace);
    // opening the file again, with a viewer fragment, is the same place as before
    expect(await idOf('file', 'file:///C:/Users/Rex/Documents/EC1A1/paper.pdf#page=7')).toBe(newPlace);
  });
});

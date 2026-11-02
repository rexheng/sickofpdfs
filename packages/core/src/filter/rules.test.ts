// Table-driven checks of R91's places (spec, "When the filter is wrong", Nov 2), for the shared deny set and the entry check
// in rules.ts. Each row is a place R91 names, or the nearest place that is not a catch-all.
//
// Written by the filterfix implementer from R91's wording (the brief allowed it for this logic only, rule 7). A spec-blind
// author may replace it.
import { describe, expect, it } from 'vitest';
import { cleanList, isCatchAllHost, listEntryProblem, listMatches } from './rules';

/** Folders and sites the allow list must refuse (R91's catch-all places, and entries that would apply to everything). */
const ALLOW_REFUSED: [string, string][] = [
  // "local folders: Downloads, Desktop, Documents, the home folder, a drive root, or anything less than two levels below home"
  ['Linux Downloads', '/home/rex/Downloads/'],
  ['macOS Desktop', '/Users/rex/Desktop/'],
  ['Documents', '/home/rex/Documents/'],
  ['the home folder', '/home/rex/'],
  ['one level below home', '/home/rex/Readings/'],
  ['Windows Downloads, as a path', 'C:\\Users\\rex\\Downloads'],
  ['Windows Downloads, as a file link', 'file:///C:/Users/rex/Downloads/'],
  ['Windows Desktop, as a file link', 'file:///C:/Users/rex/Desktop/'],
  ['Windows home', 'C:/Users/rex/'],
  ['Windows, one level below home', 'file:///C:/Users/rex/Readings/'],
  ['a subfolder of Downloads', '/home/rex/Downloads/Week 3/'],
  ['WSL Downloads', '/mnt/c/Users/rex/Downloads/'],
  ['a drive root', 'D:/'],
  ['a folder on a drive root', 'D:/Readings/'],
  ['a network share root', '\\\\server\\share\\'],
  ['a temp folder', '/tmp/x/y/'],
  ['Windows temp', 'C:/Users/rex/AppData/Local/Temp/Outlook/'],
  ['Outlook attachments', 'C:/Users/rex/AppData/Local/Microsoft/Windows/INetCache/Content.Outlook/AB12/'],
  ['macOS Mail attachments', '/Users/rex/Library/Containers/com.apple.mail/Data/Library/Mail Downloads/'],
  ['a Documents folder deeper down', '/home/rex/Work/Documents/'],
  ['OneDrive', 'C:/Users/rex/Files/OneDrive/'],
  // "A bare top-level domain, `/`, a drive root or `file:///` is refused."
  ['`/`', '/'],
  ['`file:///`', 'file:///'],
  ['a bare top-level domain', 'com'],
  ['a bare top-level domain as an address', 'https://com/'],
  ['a bare country domain', 'http://uk'],
  ['a shared suffix', 'co.uk'],
  ['a shared suffix as an address', 'https://gov.uk'],
  ['every home folder', '/home/'],
  ['a drive', 'c:'],
  // "mail attachments (Gmail, Outlook)"
  ['Gmail attachments', 'mail-attachment.googleusercontent.com'],
  ['Gmail', 'mail.google.com'],
  ['Outlook attachments', 'attachments.office.net'],
  ['Outlook on the web', 'outlook.office.com'],
  ['Outlook.com', 'outlook.live.com'],
  // "Drive, OneDrive, Dropbox and iCloud downloads"
  ['Drive downloads', 'drive.usercontent.google.com'],
  ['Drive', 'drive.google.com'],
  ['Drive file host', 'doc-0s-6g-docs.googleusercontent.com'],
  ['OneDrive', 'onedrive.live.com'],
  ['OneDrive for work', 'lse-my.sharepoint.com'],
  ['Dropbox downloads', 'dl.dropboxusercontent.com'],
  ['Dropbox', 'www.dropbox.com'],
  ['iCloud', 'www.icloud.com'],
  // "shared object stores (s3.amazonaws.com, storage.googleapis.com, blob.core.windows.net)"
  ['S3', 's3.amazonaws.com'],
  ['an S3 bucket host', 'acme-invoices.s3.amazonaws.com'],
  ['regional S3', 's3.eu-west-2.amazonaws.com'],
  ['Google Cloud Storage', `storage.google${'apis'}.com`],
  ['Azure blobs', 'acme.blob.core.windows.net'],
  // "chat file hosts (Slack, Discord, Teams)"
  ['Slack files', 'files.slack.com'],
  ['Discord attachments', 'cdn.discordapp.com'],
  ['Teams', 'teams.microsoft.com'],
  // round 2 (n1): more webmail, and user-upload hosts
  ['Proton Mail', 'mail.protonmail.com'],
  ['Zoho Mail', 'mail.zoho.eu'],
  ['AOL Mail', 'mail.aol.com'],
  ['Fastmail attachments', 'www.fastmailusercontent.com'],
  ['Messenger attachments', 'cdn.fbsbx.com'],
  ['GitHub user uploads', 'user-images.githubusercontent.com'],
  ['GitHub file objects', 'objects.githubusercontent.com'],
  ['Notion files', 'file.notion.so'],
  ['MEGA', 'mega.nz'],
  // round 2 (n1): names under which anyone has a site
  ['all GitHub Pages sites', 'github.io'],
  ['all Blogger blogs', 'blogspot.com'],
  ['all CloudFront sites', 'https://cloudfront.net/'],
  ['all uk.com sites', 'uk.com'],
  // a host above a catch-all one
  ['all of Google', 'google.com'],
  ['all of Microsoft', 'microsoft.com'],
  ['an address on a catch-all host', 'https://s3.amazonaws.com/course-bucket/'],
  // not a site or a folder
  ['an empty entry', '   '],
  ['another kind of link', 'mailto:rex@example.com'],
];

/** Places R91 does not refuse: a site of its own, or a folder of its own two levels below home. */
const ALLOW_OK: [string, string][] = [
  ['a course site', 'moodle.lse.ac.uk'],
  ['a site with a folder', 'example.org/readings/'],
  ['a web address of a folder', 'https://example.org/readings/'],
  ['a university', 'lse.ac.uk'],
  ['Google Scholar', 'scholar.google.com'],
  ['the fixture server', '127.0.0.1'],
  ['one GitHub Pages course site', 'cs231n.github.io'],
  ['one blog', 'econ-notes.blogspot.com'],
  ['a Notion page site (not its file host)', 'ec1a1.notion.site'],
  ['two levels below home', '/home/rex/Courses/Week 3 readings/'],
  ['inside Documents, two levels below home', '/home/rex/Documents/Readings/'],
  ['macOS, two levels below home', '/Users/rex/Uni/EC1A1/'],
  ['Windows, two levels below home', 'C:\\Users\\rex\\Uni\\EC1A1'],
  ['Windows, as a file link', 'file:///C:/Users/rex/Courses/Readings/'],
  ['inside OneDrive for work', 'C:/Users/rex/OneDrive - LSE/Week 3/'],
  ['a second drive, two levels down', 'D:/Uni/Week3/'],
  ['a network share, two levels down', '//server/share/courses/week3/'],
];

describe('R91: the allow list refuses catch-all places', () => {
  it.each(ALLOW_REFUSED)('refuses %s (%s)', (_name, entry) => {
    expect(listEntryProblem(entry, 'allow')).not.toBeNull();
  });
  it.each(ALLOW_OK)('takes %s (%s)', (_name, entry) => {
    expect(listEntryProblem(entry, 'allow')).toBeNull();
  });
});

describe('R91: the deny list refuses only entries that would apply to everything', () => {
  const everything = ['/', 'file:///', 'com', 'https://com/', 'http://uk', 'co.uk', '/home/', 'c:', 'C:\\', 'D:/', '\\\\server\\share\\', '  '];
  it.each(everything)('refuses %s', (entry) => expect(listEntryProblem(entry, 'deny')).not.toBeNull());
  // a deny entry only makes the filter more careful, so a catch-all place is fine there
  const careful = ['mail-attachment.googleusercontent.com', '/home/rex/Downloads/', 'C:/Users/rex/', 's3.amazonaws.com', 'moodle.lse.ac.uk'];
  it.each(careful)('takes %s', (entry) => expect(listEntryProblem(entry, 'deny')).toBeNull());
});

describe('a refused entry never matches, however it reached the list (typed, synced)', () => {
  const links = ['https://www.mybank.com/statements/2026-10.pdf', 'https://hmrc.gov.uk/forms/sa100.pdf', 'file:///home/rex/Downloads/receipt.pdf', 'file:///C:/Users/rex/Downloads/receipt.pdf', 'https://acme.s3.amazonaws.com/inv.pdf'];
  it.each(ALLOW_REFUSED)('%s (%s) matches nothing on the allow list', (_name, entry) => {
    expect(links.filter((u) => listMatches([entry], u, null, 'allow'))).toEqual([]);
  });
  it('cleanList drops refused entries and keeps the rest', () => {
    expect(cleanList(['/home/rex/Downloads/', 'moodle.lse.ac.uk', 7, 'com', ' lse.ac.uk '], 'allow')).toEqual(['moodle.lse.ac.uk', 'lse.ac.uk']);
    expect(cleanList('moodle.lse.ac.uk', 'allow')).toEqual([]);
  });
});

describe('an entry that may be on the list still matches what it names', () => {
  const rows: [string, string, string, boolean][] = [
    ['a site matches its pages', 'moodle.lse.ac.uk', 'https://moodle.lse.ac.uk/pluginfile.php/1/a.pdf', true],
    ['a site matches its subdomains', 'lse.ac.uk', 'https://moodle.lse.ac.uk/a.pdf', true],
    ['a site never matches a look-alike', 'lse.ac.uk', 'https://notlse.ac.uk/a.pdf', false],
    ['a folder matches a file inside it', '/home/rex/Courses/Week 3 readings/', 'file:///home/rex/Courses/Week%203%20readings/x.pdf', true],
    ['a folder never matches a sibling', '/home/rex/Courses/Week 3 readings/', 'file:///home/rex/Courses/Week 3 receipts/x.pdf', false],
    ['a Windows folder matches its file link', 'C:\\Users\\rex\\Uni\\EC1A1', 'file:///C:/Users/rex/Uni/EC1A1/week1.pdf', true],
    ['a Windows folder never matches a folder that starts the same', 'C:\\Users\\rex\\Uni\\EC1A1', 'file:///C:/Users/rex/Uni/EC1A1-old/week1.pdf', false],
    ['a network folder matches its file link', '//server/share/courses/week3/', 'file://server/share/courses/week3/a.pdf', true],
  ];
  it.each(rows)('%s', (_name, entry, url, match) => expect(listMatches([entry], url, null, 'allow')).toBe(match));
});

describe('catch-all hosts', () => {
  it.each(['mail.google.com', 'docs.google.com', 'google.com', 'x.googleusercontent.com', 'files.slack.com', 'slack.com', 'bucket.s3.amazonaws.com'])('%s is one', (h) => expect(isCatchAllHost(h)).toBe(true));
  it.each(['scholar.google.com', 'books.google.com', 'moodle.lse.ac.uk', 'arxiv.org', 'example.com'])('%s is not', (h) => expect(isCatchAllHost(h)).toBe(false));
});

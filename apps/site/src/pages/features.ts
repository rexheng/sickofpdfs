// The features page: one line per feature, under a few small headings. Only what the extension and the app really do today;
// what is still coming says so. The two pictures are frames of real recordings of the built extension (WebP, under 60 KB).

import { renderPage } from './layout.ts';

interface Group {
  heading: string;
  lines: string[];
  /** A picture under the group's lines. */
  figure?: { src: string; width: number; height: number; alt: string; caption: string };
}

const GROUPS: Group[] = [
  {
    heading: 'Reading',
    lines: [
      'Opens every PDF in Chrome: links, files on your computer, and PDFs inside pages such as Moodle.',
      'Find, zoom, print, thumbnails and the outline, like Chrome’s own viewer.',
      'Two-page view and presentation mode.',
      'Opens where you stopped last time.',
      'Drag thumbnails to reorder pages. The file itself never changes.',
    ],
  },
  {
    heading: 'Marks and comments',
    lines: [
      'Highlight, underline, bold and strikethrough: one key each, or right-click.',
      'Comment with Ctrl+Alt+M. Notes sit in the margin, with replies.',
      'Click a figure or chart to comment on it.',
      'The Notes panel lists every note in the PDF.',
      'Notes stay with the PDF, even after you move, rename or download it again.',
      'Notes already in a PDF show up too.',
      'Download a copy of the PDF with your notes in it.',
    ],
  },
  {
    heading: 'Library and courses',
    lines: [
      'Papers, readings and slides save to your library by themselves.',
      'Ctrl+K searches titles, full text and your notes.',
      'Readings are grouped by course, found from course codes. Rename or merge them.',
      'Tags by subject, Starred, Recent and related readings.',
      'Export all your notes as Markdown.',
      'Automatic backup to a folder you choose, and restore on a new computer.',
    ],
    figure: {
      src: '/features-courses.webp',
      width: 1000,
      height: 675,
      alt: 'The library’s Courses page: readings grouped under course codes such as NLP201 and CS231n, with the newest notes.',
      caption: 'Courses, found for you.',
    },
  },
  {
    heading: '@Claude',
    lines: [
      'Type @Claude in any note to ask about the passage.',
      'Answers link to the page they come from.',
      'Ask about a figure: Claude sees the picture and its caption.',
      'It can search the web, and shows its sources.',
      'Press Think harder for a deeper answer.',
      'Uses your own Anthropic API key.',
    ],
    figure: {
      src: '/features-claude.webp',
      width: 1000,
      height: 605,
      alt: 'A highlighted passage in a paper, and a note thread beside it where Claude explains the passage in plain words, with a Page 1 link.',
      caption: 'A note, a question, and Claude’s answer with a page link.',
    },
  },
  {
    heading: 'Scans',
    lines: ['Scanned pages are read on your computer, so you can select, mark and search them.'],
  },
  {
    heading: 'Phone and web',
    lines: [
      'Android app (coming soon): the same reader, with marks, comments and @Claude.',
      'Listen with ElevenReader: hear the PDF read aloud.',
      'Cloud sync and a web library (coming): <a href="/#waitlist">join the waitlist</a>.',
    ],
  },
  {
    heading: 'Privacy',
    lines: [
      'Your PDFs and notes stay on your device.',
      'Receipts, bank statements and payslips are never saved.',
      'Nothing is sent unless you ask. No ads, no trackers. <a href="/privacy">More on privacy</a>',
    ],
  },
];

export function featuresPage(): string {
  const main = [
    '<h1>Features</h1>',
    ...GROUPS.map((g) => {
      const figure = g.figure
        ? `<figure><img src="${g.figure.src}" width="${g.figure.width}" height="${g.figure.height}" alt="${g.figure.alt}" loading="lazy" decoding="async"><figcaption>${g.figure.caption}</figcaption></figure>`
        : '';
      return `<h2>${g.heading}</h2>\n<ul class="plain">${g.lines.map((l) => `<li>${l}</li>`).join('')}</ul>${figure}`;
    }),
  ].join('\n');
  return renderPage({ title: 'Features', description: 'What sickofpdfs does: reading, marks and comments, a library, @Claude, scans and privacy.', current: 'features', main });
}

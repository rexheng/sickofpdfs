// An in-memory library for screenshots and hand checks (plan S7: "an in-memory fake used for screenshots"). Test builds
// only: the library entry loads this module only when import.meta.env.MODE is 'test' and the address asks for it, so a
// production build does not contain it. Nothing here is written anywhere.
import type { DocumentId, DocumentRow, LocationId, LocationRow } from '@sop/core';
import { compareTitles, shownTitle } from '../../shared/shown-title';
import type { LibraryChange, LibraryData, LibraryItem, LibraryPage, LibraryQuery } from './types';

export interface FakeLibraryOptions {
  /** Where the sample PDFs are served from (the fixture folder), for their thumbnails; null: no thumbnails. */
  pdfBase: string | null;
  /** "Now", for the dates (Unix ms). */
  now?: number;
  /** Start with an empty library (the first-run screen). */
  empty?: boolean;
}

interface Seed {
  file: string;
  title: string | null;
  authors: string[];
  year: number | null;
  kind: DocumentRow['kind'];
  pages: number;
  link: string;
  /** Hours before "now" that it was last opened. */
  openedHoursAgo: number;
  minutesRead: number;
  notes: number;
  starred?: boolean;
  trashedDaysAgo?: number;
  /** No saved copy: the card shows the PDF tile instead of a page. */
  noCopy?: boolean;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const SEEDS: readonly Seed[] = [
  { file: 'arxiv-1706.03762-attention.pdf', title: 'Attention Is All You Need', authors: ['Ashish Vaswani', 'Noam Shazeer', 'Niki Parmar', 'Jakob Uszkoreit', 'Llion Jones', 'Aidan N. Gomez', 'Łukasz Kaiser', 'Illia Polosukhin'], year: 2017, kind: 'paper', pages: 15, link: 'https://arxiv.org/pdf/1706.03762', openedHoursAgo: 1.2, minutesRead: 95, notes: 14, starred: true },
  { file: 'arxiv-1803.09015-did-multiple-periods.pdf', title: 'Difference-in-Differences with Multiple Time Periods', authors: ['Brantly Callaway', "Pedro H. C. Sant'Anna"], year: 2018, kind: 'paper', pages: 45, link: 'https://arxiv.org/pdf/1803.09015', openedHoursAgo: 3.5, minutesRead: 140, notes: 22, starred: true },
  { file: 'arxiv-1512.03385-resnet.pdf', title: 'Deep Residual Learning for Image Recognition', authors: ['Kaiming He', 'Xiangyu Zhang', 'Shaoqing Ren', 'Jian Sun'], year: 2015, kind: 'paper', pages: 12, link: 'https://arxiv.org/pdf/1512.03385', openedHoursAgo: 26, minutesRead: 48, notes: 6 },
  { file: 'textbook-axler-LADR4e.pdf', title: 'Linear Algebra Done Right', authors: ['Sheldon Axler'], year: 2024, kind: 'book', pages: 404, link: 'https://linear.axler.net/LADR4e.pdf', openedHoursAgo: 50, minutesRead: 610, notes: 31, starred: true },
  { file: 'lecture-notes-mit-6.006-lec1.pdf', title: 'Introduction to Algorithms, Lecture 1: Introduction', authors: ['Erik Demaine', 'Jason Ku', 'Justin Solomon'], year: 2020, kind: 'other', pages: 5, link: 'https://ocw.mit.edu/courses/6-006-introduction-to-algorithms-spring-2020/lec1.pdf', openedHoursAgo: 75, minutesRead: 22, notes: 3 },
  { file: 'slides-cs231n-2024-lecture2.pdf', title: 'Lecture 2: Image Classification with Linear Classifiers', authors: ['Fei-Fei Li', 'Ehsan Adeli'], year: 2024, kind: 'slides', pages: 98, link: 'https://cs231n.stanford.edu/slides/2024/lecture_2.pdf', openedHoursAgo: 120, minutesRead: 64, notes: 0 },
  { file: 'arxiv-1603.02754-xgboost.pdf', title: 'XGBoost: A Scalable Tree Boosting System', authors: ['Tianqi Chen', 'Carlos Guestrin'], year: 2016, kind: 'paper', pages: 13, link: 'https://arxiv.org/pdf/1603.02754', openedHoursAgo: 190, minutesRead: 35, notes: 2 },
  { file: 'nature-s41586-021-03819-2-alphafold.pdf', title: 'Highly accurate protein structure prediction with AlphaFold', authors: ['John Jumper', 'Richard Evans', 'Alexander Pritzel'], year: 2021, kind: 'paper', pages: 12, link: 'https://www.nature.com/articles/s41586-021-03819-2.pdf', openedHoursAgo: 260, minutesRead: 41, notes: 5 },
  { file: 'textbook-boyd-convex-optimization.pdf', title: 'Convex Optimization', authors: ['Stephen Boyd', 'Lieven Vandenberghe'], year: 2004, kind: 'book', pages: 714, link: 'https://web.stanford.edu/~boyd/cvxbook/bv_cvxbook.pdf', openedHoursAgo: 400, minutesRead: 380, notes: 12 },
  { file: 'arxiv-1802.03042-deep-hedging.pdf', title: 'Deep Hedging', authors: ['Hans Buehler', 'Lukas Gonon', 'Josef Teichmann', 'Ben Wood'], year: 2018, kind: 'paper', pages: 32, link: 'https://arxiv.org/pdf/1802.03042', openedHoursAgo: 720, minutesRead: 55, notes: 0 },
  { file: 'textbook-grinstead-snell-probability.pdf', title: 'Introduction to Probability', authors: ['Charles M. Grinstead', 'J. Laurie Snell'], year: 1997, kind: 'book', pages: 518, link: 'https://math.dartmouth.edu/~prob/prob/prob.pdf', openedHoursAgo: 1100, minutesRead: 240, notes: 9 },
  { file: 'thesis-sutskever-phd.pdf', title: 'Training Recurrent Neural Networks', authors: ['Ilya Sutskever'], year: 2013, kind: 'other', pages: 101, link: 'https://www.cs.utoronto.ca/~ilya/pubs/ilya_sutskever_phd_thesis.pdf', openedHoursAgo: 1900, minutesRead: 70, notes: 4 },
  { file: 'textbook-thinkpython2.pdf', title: 'Think Python', authors: ['Allen B. Downey'], year: 2015, kind: 'book', pages: 244, link: 'https://greenteapress.com/thinkpython2/thinkpython2.pdf', openedHoursAgo: 2600, minutesRead: 160, notes: 0 },
  { file: 'report-ipcc-ar6-syr-spm.pdf', title: 'Climate Change 2023: Synthesis Report. Summary for Policymakers', authors: ['IPCC'], year: 2023, kind: 'other', pages: 42, link: 'https://www.ipcc.ch/report/ar6/syr/downloads/report/IPCC_AR6_SYR_SPM.pdf', openedHoursAgo: 3400, minutesRead: 30, notes: 1, noCopy: true },
  { file: 'plosone-10.1371-journal.pone.0000308.pdf', title: 'Sharing Detailed Research Data Is Associated with Increased Citation Rate', authors: ['Heather A. Piwowar', 'Roger S. Day', 'Douglas B. Fridsma'], year: 2007, kind: 'paper', pages: 5, link: 'https://journals.plos.org/plosone/article/file?id=10.1371/journal.pone.0000308&type=printable', openedHoursAgo: 5000, minutesRead: 18, notes: 0 },
  { file: 'problem-set-mit-14.01-f23-pset4-solutions.pdf', title: null, authors: [], year: null, kind: 'other', pages: 8, link: 'file:///C:/Users/me/Downloads/14.01%20F23%20Problem%20Set%204%20Solutions.pdf', openedHoursAgo: 9000, minutesRead: 12, notes: 0 },
  { file: 'nber-w29000.pdf', title: 'How Americans Respond to Idiosyncratic and Exogenous Changes in Household Wealth and Unearned Income', authors: ['Mikhail Golosov', 'Michael Graber', 'Magne Mogstad', 'David Novgorodsky'], year: 2021, kind: 'paper', pages: 133, link: 'https://www.nber.org/system/files/working_papers/w29000/w29000.pdf', openedHoursAgo: 900, minutesRead: 15, notes: 0, trashedDaysAgo: 3 },
  { file: 'lse-cep-dp1800.pdf', title: 'The backlash of globalization', authors: ['Italo Colantone', 'Gianmarco Ottaviano', 'Piero Stanig'], year: 2021, kind: 'paper', pages: 89, link: 'https://cep.lse.ac.uk/pubs/download/dp1800.pdf', openedHoursAgo: 1500, minutesRead: 9, notes: 0, trashedDaysAgo: 12 },
];

/** A 64-hex id made from the file name (FNV-1a, stretched): stable, and shaped like a real SHA-256. */
function fakeId(name: string): DocumentId {
  let out = '';
  let h = 0x811c9dc5;
  for (let round = 0; out.length < 64; round++) {
    for (const ch of `${round}:${name}`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
    out += h.toString(16).padStart(8, '0');
  }
  return out.slice(0, 64) as DocumentId;
}

function build(seed: Seed, now: number): LibraryItem {
  const id = fakeId(seed.file);
  const lastOpened = now - seed.openedHoursAgo * HOUR;
  const firstOpened = lastOpened - 6 * DAY;
  const doc: DocumentRow = {
    id,
    pageCount: seed.pages,
    byteSize: 0,
    title: seed.title,
    authors: seed.authors,
    year: seed.year,
    doi: null,
    arxivId: null,
    pdfId: null,
    kind: seed.kind,
    hasText: true,
    encrypted: false,
    indexText: true,
    blobStored: seed.noCopy !== true,
    starred: seed.starred === true,
    saveReasons: [],
    createdAt: firstOpened,
    updatedAt: lastOpened,
    deletedAt: seed.trashedDaysAgo === undefined ? null : now - seed.trashedDaysAgo * DAY,
    rev: 0,
    hlc: '',
  };
  const kind = seed.link.startsWith('file:') ? 'file' : 'url';
  const location: LocationRow = {
    id: `loc-${id.slice(0, 16)}` as LocationId,
    documentId: id,
    kind,
    canonical: seed.link,
    raw: seed.link,
    viaPage: null,
    firstSeen: firstOpened,
    lastSeen: lastOpened,
  };
  return { doc, firstOpened, lastOpened, readingMs: seed.minutesRead * 60_000, noteCount: seed.notes, location };
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

function compare(a: LibraryItem, b: LibraryItem, by: LibraryQuery['sort']['by']): number {
  switch (by) {
    case 'title':
      return compareTitles(shownTitle(a.doc.title, a.location?.raw ?? null), shownTitle(b.doc.title, b.location?.raw ?? null));
    case 'lastOpened':
      return a.lastOpened - b.lastOpened;
    case 'added':
      return a.doc.createdAt - b.doc.createdAt;
    case 'pages':
      return a.doc.pageCount - b.doc.pageCount;
  }
}

export function createFakeLibraryData(o: FakeLibraryOptions): LibraryData {
  const now = o.now ?? Date.now();
  const items = new Map<DocumentId, LibraryItem>();
  const files = new Map<DocumentId, string>();
  if (o.empty !== true) {
    for (const seed of SEEDS) {
      const item = build(seed, now);
      items.set(item.doc.id, item);
      files.set(item.doc.id, seed.file);
    }
  }
  const listeners = new Set<(c: LibraryChange) => void>();
  const changed = (forgotten: DocumentId[] = []) => {
    for (const cb of listeners) queueMicrotask(() => cb({ forgotten }));
  };
  const edit = (id: DocumentId, patch: Partial<DocumentRow>) => {
    const item = items.get(id);
    if (item === undefined) throw new Error('document-missing: not in the library');
    items.set(id, { ...item, doc: { ...item.doc, ...patch, updatedAt: Date.now() } });
    changed();
  };

  return {
    listDocuments(q: LibraryQuery): Promise<LibraryPage> {
      const f = q.filter ?? {};
      const rows = [...items.values()].filter((i) => {
        if ((q.view === 'trash') !== (i.doc.deletedAt !== null)) return false;
        if ((q.view === 'starred' || f.starred === true) && !i.doc.starred) return false;
        if (f.hasNotes === true && i.noteCount === 0) return false;
        if (f.readFrom !== undefined && i.lastOpened < f.readFrom) return false;
        if (f.readTo !== undefined && i.lastOpened > f.readTo) return false;
        if (f.kind !== undefined && f.kind.length > 0 && !f.kind.includes(i.doc.kind)) return false;
        return true;
      });
      const sign = q.sort.dir === 'asc' ? 1 : -1;
      rows.sort((a, b) => sign * compare(a, b, q.sort.by) || collator.compare(a.doc.id, b.doc.id));
      const start = q.cursor === undefined ? 0 : Number(q.cursor);
      const page = rows.slice(start, start + q.limit);
      const next = start + page.length < rows.length ? String(start + page.length) : null;
      return Promise.resolve({ items: page, nextCursor: next, total: rows.length });
    },
    setStarred: (id, on) => Promise.resolve(edit(id, { starred: on })),
    trashDocument: (id) => Promise.resolve(edit(id, { deletedAt: Date.now() })),
    restoreDocument: (id) => Promise.resolve(edit(id, { deletedAt: null })),
    setTitle: (id, title) => Promise.resolve(edit(id, { title })),
    savePickedPdf(file) {
      // A sample reading named after the file; nothing is read from it and nothing is written anywhere.
      if (!/\.pdf$/i.test(file.name)) return Promise.resolve('not-pdf');
      const at = Date.now();
      const item = build({ file: file.name, title: file.name.replace(/\.pdf$/i, ''), authors: [], year: null, kind: 'other', pages: 1, link: '', openedHoursAgo: 0, minutesRead: 0, notes: 0, noCopy: true }, at);
      if (items.has(item.doc.id)) return Promise.resolve('already-saved');
      items.set(item.doc.id, { ...item, location: null });
      changed();
      return Promise.resolve('saved');
    },
    async savedPdf(id) {
      const file = files.get(id);
      if (o.pdfBase === null || file === undefined || items.get(id)?.doc.blobStored !== true) return null;
      const res = await fetch(new URL(file, o.pdfBase));
      return res.ok ? res.blob() : null;
    },
    hasDocument: (id) => Promise.resolve(items.has(id)),
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

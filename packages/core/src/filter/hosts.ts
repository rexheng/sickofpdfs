// What the link says about a PDF: the site it came from, and words in its path and file name. Pure string work, no
// network. A site is matched on whole host labels ("evilarxiv.org" is not "arxiv.org").

import { LINK_CHAR_CAP } from './limits';

export interface LinkParts {
  /** Lower-case host without port, or '' for file links. */
  host: string;
  /** Decoded, lower-case path. */
  path: string;
  protocol: string;
}

export function parseLink(link: string | null | undefined): LinkParts | null {
  if (!link) return null;
  let url: URL;
  try {
    url = new URL(link.length > LINK_CHAR_CAP ? link.slice(0, LINK_CHAR_CAP) : link);
  } catch {
    return null;
  }
  let path = url.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    // keep the raw path
  }
  return { host: url.hostname.toLowerCase().replace(/\.$/, ''), path: path.toLowerCase(), protocol: url.protocol };
}

export function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function anyHost(host: string, domains: readonly string[]): boolean {
  return domains.some((d) => hostMatches(host, d));
}

/** Scholarly sites: preprint servers, publishers, repositories, open textbooks, central-bank and think-tank research. */
export const SCHOLARLY_HOSTS: readonly string[] = [
  'arxiv.org', 'doi.org', 'jstor.org', 'ssrn.com', 'nber.org', 'semanticscholar.org', 'openreview.net',
  'aclanthology.org', 'springer.com', 'springernature.com', 'sciencedirect.com', 'wiley.com', 'tandfonline.com',
  'sagepub.com', 'oup.com', 'cambridge.org', 'nature.com', 'science.org', 'pnas.org', 'plos.org', 'frontiersin.org',
  'mdpi.com', 'biorxiv.org', 'medrxiv.org', 'osf.io', 'researchgate.net', 'core.ac.uk', 'europepmc.org',
  'ncbi.nlm.nih.gov', 'repec.org', 'econstor.eu', 'cepr.org', 'imf.org', 'worldbank.org', 'oecd.org', 'bis.org',
  'ecb.europa.eu', 'federalreserve.gov', 'bankofengland.co.uk', 'bankofcanada.ca', 'ipcc.ch', 'ifs.org.uk',
  'ocw.mit.edu', 'openstax.org', 'libretexts.org', 'greenteapress.com', 'cs50.net', 'ieee.org', 'acm.org',
  'aps.org', 'iop.org', 'rsc.org', 'acs.org', 'cell.com', 'thelancet.com', 'bmj.com', 'nejm.org', 'jamanetwork.com',
  'annualreviews.org', 'degruyter.com', 'projecteuclid.org', 'ams.org', 'siam.org', 'zenodo.org', 'figshare.com',
  'philpapers.org', 'hal.science', 'mlr.press', 'neurips.cc', 'nips.cc', 'thecvf.com',
];

/** Course sites: learning platforms, reading lists and lecture capture. Matched on host words, not on the full link. */
const LMS_HOST_WORDS = /moodle|instructure\.com|blackboard|brightspace|(^|[.-])d2l([.-]|$)|echo360|panopto|talis|readinglists|(^|\.)canvas\./;
const LMS_PATH = /\/moodle\/|\/pluginfile\.php\/|\/mod\/resource\/|\/webapps\/blackboard\//;

const ACADEMIC_TLD = /(\.ac\.[a-z]{2}|\.edu(\.[a-z]{2})?|(^|\.)uni-[a-z0-9-]+\.de)$/;

/** Banks, payment services, shops, airlines, rail, ticket sellers, tax offices and e-signature services. */
const NEGATIVE_HOSTS: readonly string[] = [
  'hsbc.com', 'hsbc.co.uk', 'barclays.co.uk', 'barclays.com', 'lloydsbank.com', 'natwest.com', 'santander.co.uk',
  'santander.com', 'monzo.com', 'revolut.com', 'starlingbank.com', 'nationwide.co.uk', 'halifax.co.uk', 'tsb.co.uk',
  'chase.com', 'bankofamerica.com', 'wellsfargo.com', 'citi.com', 'capitalone.com', 'americanexpress.com',
  'paypal.com', 'paypal.me', 'stripe.com', 'squareup.com', 'wise.com', 'klarna.com', 'uber.com', 'lyft.com',
  'deliveroo.co.uk', 'deliveroo.com', 'airbnb.com', 'booking.com', 'expedia.com', 'ryanair.com', 'easyjet.com',
  'ba.com', 'britishairways.com', 'lufthansa.com', 'airfrance.com', 'klm.com', 'delta.com', 'united.com', 'aa.com',
  'southwest.com', 'emirates.com', 'qatarairways.com', 'trainline.com', 'nationalrail.co.uk', 'eurostar.com',
  'bahn.de', 'sncf-connect.com', 'tfl.gov.uk', 'eventbrite.com', 'eventbrite.co.uk', 'ticketmaster.com',
  'ticketmaster.co.uk', 'irs.gov', 'tax.service.gov.uk', 'hmrc.gov.uk', 'docusign.com', 'docusign.net',
  'hellosign.com', 'dropboxsign.com', 'adobesign.com', 'echosign.com', 'pandadoc.com', 'octopus.energy',
  'britishgas.co.uk', 'edfenergy.com', 'eonnext.com', 'thameswater.co.uk',
];
const NEGATIVE_HOST_WORDS = /bank|banking|billing|invoice|payroll|(^|[.-])(hmrc|payments?|tickets?|airlines?|airways|insurance|mortgage)([.-]|$)/;
const AMAZON_ORDER_PATH = /order|invoice|receipt|digital|your-?account|gp\/css|gp\/your/;

/** An EZproxy-style host writes dots as hyphens in its first label ("www-jstor-org.ezproxy.lse.ac.uk"). */
function unproxied(host: string): string | null {
  const dot = host.indexOf('.');
  if (dot < 0) return null;
  const first = host.slice(0, dot);
  if ((first.match(/-/g)?.length ?? 0) < 2) return null;
  return first.replaceAll('-', '.');
}

export interface HostClass {
  scholarly: boolean;
  lms: boolean;
  academic: boolean;
  negative: boolean;
}

export function classifyHost(link: LinkParts | null): HostClass {
  const none: HostClass = { scholarly: false, lms: false, academic: false, negative: false };
  if (!link || (link.protocol !== 'http:' && link.protocol !== 'https:')) return none;
  const { host, path } = link;
  const real = unproxied(host);
  const scholarly = anyHost(host, SCHOLARLY_HOSTS) || (real !== null && anyHost(real, SCHOLARLY_HOSTS));
  const lms = !scholarly && (LMS_HOST_WORDS.test(host) || LMS_PATH.test(path));
  const academic = !scholarly && !lms && ACADEMIC_TLD.test(host);
  const amazon = /(^|\.)amazon\.[a-z.]+$/.test(host) && AMAZON_ORDER_PATH.test(path);
  // a scholarly host is never "negative" on a word such as "bank" (worldbank.org, bankofengland.co.uk)
  const negative = anyHost(host, NEGATIVE_HOSTS) || amazon || (!scholarly && NEGATIVE_HOST_WORDS.test(host));
  return { scholarly, lms, academic, negative };
}

// Words in the path or file name. Whole words only, so "border" is not "order".
const NEGATIVE_NAME_WORDS = new Set([
  'invoice', 'invoices', 'receipt', 'receipts', 'billing', 'statement', 'statements', 'estatement',
  'payslip', 'payslips', 'paystub', 'payroll', 'p60', 'p45', 'p11d', 'ticket', 'tickets', 'eticket', 'boarding',
  'tenancy', 'rechnung', 'facture', 'quittung',
]);
const COURSE_NAME_WORDS = new Set([
  'lecture', 'lectures', 'lec', 'week', 'wk', 'reading', 'readings', 'seminar', 'seminars', 'pset', 'slides',
  'slide', 'chapter', 'chapters', 'syllabus', 'handout', 'handouts', 'tutorial', 'tutorials', 'coursework',
  'notes', 'textbook', 'thesis', 'dissertation',
]);

// A course code in a name counts only when its letters are a department's (cs, math, ec, ...). A folder or build name such as
// "tb6g1", "proj2b" or "wt-tb66" is not one, and a code read from a path may only make the filter more careful, never less (R91).
const DEPARTMENT_LETTERS = new Set(
  ('math maths econ phys chem biol bio comp stat stats engl hist psyc psych soc poli phil acct finc fin mgmt mktg cs cse ee ece mech civl engr ' +
    'ling anth geog geol astr neur musc educ eecs ec ma st ac fm ir ll ph gv mg sa sp ds eh pp gy ib ps bu me ce ch cm mat sta cmpt cpsc comm ' +
    'law med nurs pols pol econ gov ids mis ops orgb stats phy chm').split(' '),
);

/** True when the text holds a course code with a department's letters: CS50, CS231n, MATH 221, EC313, EC1A1. */
export function hasDepartmentCode(text: string): boolean {
  const re = /(?<![a-z0-9])([a-z]{2,5})[ _-]?(?:\d{2,4}[a-z]?|\d[a-z]\d)(?![a-z0-9])/gi;
  for (const m of text.matchAll(re)) {
    const letters = (m[1] ?? '').toLowerCase();
    const digits = /\d+/.exec(m[0])?.[0] ?? '';
    if (DEPARTMENT_LETTERS.has(letters) && !(digits.length === 4 && /^(?:19|20)\d\d$/.test(digits))) return true;
  }
  return false;
}

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

export interface NameWords {
  negative: boolean;
  course: boolean;
}

/** Looks at the link's path, the file name and the document title together, so a word that is in two of them counts once. */
export function nameWords(link: LinkParts | null, fileName: string, title: string | null = null): NameWords {
  const joined = `${link?.path ?? ''} ${fileName} ${title ?? ''}`;
  const all = [...new Set(words(joined))];
  const negative = all.some((w) => NEGATIVE_NAME_WORDS.has(w));
  const course =
    all.some((w) => COURSE_NAME_WORDS.has(w) || /^(?:ps|ch|wk|lec|week)\d{1,2}$/.test(w)) || hasDepartmentCode(joined);
  return { negative, course };
}

// R94: a scan has no text to read, so its title is all there is: the link's path, the file name and the PDF's own title.
const PRIVATE_TITLE_WORDS = new Set(['bank', 'tax', 'cv', 'resume', 'passport']);
/** A camera or scanner name: IMG_1234, DSC01234, Scan_2023-01-02. */
const DEVICE_NAME = /(?:^|[^a-z0-9])(?:img|dsc[nf]?|pxl|mvimg|scan|image|photo|cam)[ _-]?\d{3,}/;
/** A course code: CS50, MATH101, EC1A1, 14.01. */
const MIT_NUMBER = /(?:^|[\s_-])\d{1,2}\.\d{2,3}(?![a-z0-9]|\.\d)/;

/** True when a no-text scan's title looks like a course reading and not like paperwork or a camera's file name (R94). */
export function scanTitleLooksLikeLearning(link: LinkParts | null, fileName: string, title: string | null): boolean {
  const text = `${link?.path ?? ''} ${fileName} ${title ?? ''}`.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replaceAll('.pdf', ' ');
  const { negative, course } = nameWords(link, fileName, title);
  if (negative || DEVICE_NAME.test(text) || text.split(/[^a-z0-9]+/).some((w) => PRIVATE_TITLE_WORDS.has(w))) return false;
  return course || /problem[ _-]?sets?/.test(text) || hasDepartmentCode(text) || MIT_NUMBER.test(text);
}

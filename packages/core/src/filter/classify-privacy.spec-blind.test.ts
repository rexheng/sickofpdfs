// Spec-blind tests for the filter's privacy promises and for "zero false saves" on private documents written by hand.
//
// Sources:
//   contract section 5: "Privacy. A FilterDecision never holds PDF text, numbers or matched strings. Reasons are fixed labels."
//   plan S2: "Reasons are fixed plain-words labels, never PDF text." "Pure and synchronous."
//   plan, phase gate 1: "Zero false saves." Plan T1: "the privacy canary (a unique string put in the text never appears in the decision)".
//   spec, "Learning filter and privacy": the filter "forgets" the text; research 04 B.6.
//   plan S6 (what the 44 fixtures miss): a tenancy agreement, a university fee invoice, a CV or job letter, a lab result or
//     insurance letter, another bank statement. I wrote one stand-in for each, in the layouts real ones use.
import { describe, expect, it } from 'vitest';
import { LATEX, SCHOLARLY_URL, asInput, deepFreeze, lines, mkInput, rulesOf } from '../../test/spec-blind/filter-kit';
import type { FilterDecision, FilterInput, FilterRules, Spec } from '../../test/spec-blind/filter-kit';
import { classify } from './classify';
import { nudge } from './nudge';

const decide = (input: FilterInput, rules: Partial<FilterRules> = {}): FilterDecision => classify(deepFreeze(input), deepFreeze(rulesOf(rules)));

/** Every string anywhere inside a value. */
function allStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => allStrings(x, out));
  else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => (out.push(k), allStrings(x, out)));
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
describe('privacy canary: nothing from the input comes back in the decision', () => {
  // Ten unique strings. Each goes into a different place a PDF or its link can carry text.
  const C = Array.from({ length: 12 }, (_, i) => `ZQXCANARY${String.fromCharCode(65 + i)}${(0x7f3a91 + i * 4099).toString(16)}`);
  const HOST = `${C[11].toLowerCase()}.example`;
  const NUMBERS = ['4111 1111 1111 1111', '4111111111111111', 'GB82 WEST 1234 5698 7654 32', 'AB 12 34 56 C', '512-48-3917', '40-47-84', '12345678'];

  const meta = { title: `${C[0]} title`, author: `${C[1]} Author`, subject: `${C[2]} subject`, keywords: `${C[3]}, words`, creator: `${C[4]} creator`, producer: `pdfTeX-1.40.25 ${C[5]}` };
  const carry = (extra: Spec): Spec => ({
    url: `https://${HOST}/${C[6]}/paper.pdf?token=${C[7]}`,
    fileName: `${C[8]}.pdf`,
    viaPage: `https://${HOST}/${C[9]}`,
    metadata: meta,
    first: `${C[10]} appears in a heading${'\r\n'}and ${C[11]} in a sentence`,
    ...extra,
  });

  const scenarios: Array<{ name: string; spec: Spec; rules?: Partial<FilterRules>; rule?: string }> = [
    { name: 'learning by score', spec: carry({ pageCount: 100 }), rule: 'score' },
    { name: 'not-learning by score', spec: carry({ pageCount: 1, last: lines('Subtotal', 'VAT', 'Payment method', 'Amount due') }), rule: 'score' },
    { name: 'unsure by score', spec: carry({ pageCount: 30 }), rule: 'score' },
    { name: 'hard block on a card number', spec: carry({ pageCount: 4, last: `Paid by card ${NUMBERS[0]} ${C[0]}` }), rule: 'hard-block' },
    { name: 'hard block on an IBAN and an NI number', spec: carry({ pageCount: 4, last: lines(`IBAN ${NUMBERS[2]} ${C[1]}`, `National Insurance number ${NUMBERS[3]} ${C[2]}`) }), rule: 'hard-block' },
    { name: 'a SSN and a sort code with account number', spec: carry({ pageCount: 4, last: lines(`SSN ${NUMBERS[4]}`, `Sort code ${NUMBERS[5]} Account number ${NUMBERS[6]}`) }), rule: 'hard-block' },
    { name: 'force save', spec: carry({ pageCount: 4, first: `arXiv:2301.12345v2 [cs.LG] ${C[10]}`, last: lines('References', `Author. ${C[11]}. Journal, 2020.`) }), rule: 'force-save' },
    { name: 'allow list', spec: carry({ pageCount: 4 }), rules: { allow: [HOST] }, rule: 'allow-list' },
    { name: 'deny list', spec: carry({ pageCount: 100, metadata: { ...meta, producer: `pdfTeX-1.40.25 ${C[5]}` } }), rules: { deny: [HOST] }, rule: 'deny-list' },
    { name: 'your choice (save)', spec: carry({ pageCount: 4 }), rules: { fileChoice: 'save' }, rule: 'file-choice' },
    { name: 'your choice (never)', spec: carry({ pageCount: 100 }), rules: { fileChoice: 'never' }, rule: 'file-choice' },
    { name: 'a scan with no text', spec: carry({ pageCount: 8, sampleText: ['', '', '', '', ''] }), rule: 'no-text' },
  ];

  it.each(scenarios)('$name: no canary, number, host or file name appears anywhere in the decision', ({ spec, rules, rule }) => {
    const d = decide(mkInput(spec), rules);
    if (rule) expect(d.rule).toBe(rule);
    const everything = allStrings(d).join('\n').toLowerCase();
    for (const needle of [...C, HOST, ...NUMBERS, 'token=', 'paper.pdf']) {
      expect(everything, `"${needle}" leaked into ${JSON.stringify(d).slice(0, 300)}`).not.toContain(needle.toLowerCase());
    }
    // the digits of a card, an IBAN or an SSN, in any grouping
    expect(everything.replace(/[\s-]/g, '')).not.toMatch(/4111111111111111|gb82west|512483917|404784|12345678/i);
  });

  it('the same input with the canaries swapped gives the same decision (reasons depend on signals, not on text)', () => {
    const swap = (s: string) => s.replace(/ZQXCANARY/g, 'QQQOTHERTHING');
    const a = decide(mkInput(carry({ pageCount: 100 })));
    const b = decide(
      mkInput({
        ...carry({ pageCount: 100 }),
        url: swap(carry({}).url!),
        fileName: swap(carry({}).fileName!),
        viaPage: swap(carry({}).viaPage!),
        metadata: Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, swap(v)])),
        first: swap(carry({}).first!),
      }),
    );
    expect(b).toEqual(a);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('pure and robust', () => {
  it('is deterministic and leaves its input alone (a frozen input and frozen rules are accepted twice)', () => {
    const input = deepFreeze(mkInput({ pageCount: 30, metadata: LATEX, url: SCHOLARLY_URL, first: 'Abstract' }));
    const rules = deepFreeze(rulesOf({ deny: ['example.org'], allow: ['example.com'] }));
    expect(classify(input, rules)).toEqual(classify(input, rules));
  });

  it('two different inputs do not share state (the answer for one does not depend on the previous call)', () => {
    const paper = mkInput({ pageCount: 100, metadata: LATEX });
    const receipt = mkInput({ pageCount: 1, first: lines('Invoice', 'Subtotal', 'VAT', 'Payment method') });
    const alone = decide(receipt);
    decide(paper);
    expect(decide(receipt)).toEqual(alone);
    decide(receipt);
    expect(decide(paper)).toEqual(decide(paper));
  });

  const oddLinks = [
    'not a url',
    '',
    'javascript:alert(1)',
    'blob:chrome-extension://abcdefghijklmnopabcdefghijklmnop/0f2c1c2b-1111-2222-3333-444455556666',
    'file:///',
    'https://',
    'https://exa mple.com/x.pdf',
    'data:application/pdf;base64,AAAA',
    'chrome-extension://abcdefghijklmnopabcdefghijklmnop/viewer.html?source=https%3A%2F%2Farxiv.org%2Fpdf%2F2301.12345',
    'https://münchen.example/x.pdf',
    'http://[::1]:8080/x.pdf',
    'https://user:pw@example.com/x.pdf',
    `https://example.com/${'a'.repeat(20000)}.pdf`,
  ];
  it.each(oddLinks.map((u) => [u.slice(0, 70), u]))('a strange link never throws and never saves a neutral document: %s', (_label, url) => {
    const d = decide(mkInput({ pageCount: 4, url }), { allow: ['example.org'], deny: ['example.net'] });
    expect(d.verdict).not.toBe('learning');
  });

  it.each([
    ['zero pages', { pageCount: 0, sampleText: [] as string[], pageSizes: [] as unknown[] }],
    ['page sizes missing', { pageCount: 5, pageSizes: [] as unknown[] }],
    ['a zero-width page', { pageCount: 5, pageSizes: [{ width: 0, height: 0, rotation: 0 }] }],
    ['a huge page count with a normal sample', { pageCount: 100_000 }],
    ['no file name', { fileName: '' }],
    ['rotated pages', { pageSizes: Array.from({ length: 4 }, () => ({ width: 612, height: 792, rotation: 90 })) }],
  ])('a degenerate input never throws: %s', (_name, over) => {
    const base = mkInput({ pageCount: 4 });
    const d = decide(asInput({ ...base, ...over }));
    expect(['learning', 'not-learning', 'unsure']).toContain(d.verdict);
    if (over && 'pageCount' in over && over.pageCount === 0) expect(d.verdict).not.toBe('learning');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Hand-written private documents. Each page is a realistic layout; a document of n pages is the pages in turn.

const TENANCY = [
  lines(
    'ASSURED SHORTHOLD TENANCY AGREEMENT',
    'This Agreement is made on 1 September 2026 between the Landlord and the Tenant named in the Schedule (together the parties).',
    '1. Definitions and interpretation',
    'In this Agreement the Landlord means the person named as such in the Schedule and the Tenant means the person named as such in the Schedule, hereinafter referred to as the Tenant. Words in the singular include the plural and words in the plural include the singular.',
    '2. The tenancy',
    'The Landlord lets and the Tenant takes the Property for a fixed term of twelve months from the start date at a rent of £1,150 per month payable monthly in advance on the first day of each month by standing order to the account notified by the Landlord.',
    '3. Deposit',
    'The Tenant shall pay a deposit of £1,326 which the Landlord shall protect in an authorised tenancy deposit scheme within thirty days of receipt and shall give the Tenant the prescribed information.',
  ),
  lines(
    '4. The Tenant agrees',
    'To pay the rent on the days and in the manner set out above; to keep the interior of the Property in good and clean condition; to allow the Landlord or an agent access on giving twenty-four hours notice in writing; not to keep any pet without the written consent of the Landlord; and to pay all council tax and charges for gas, electricity, water and telephone during the tenancy.',
    '5. The Landlord agrees',
    'To allow the Tenant quiet enjoyment of the Property; to keep in repair the structure and exterior; to insure the building; and to comply with the terms and conditions of the deposit protection scheme.',
    '6. Ending the tenancy',
    'Either party may end the tenancy at the end of the fixed term by giving not less than two months notice in writing. Any notice served by the Landlord must comply with the Housing Act.',
  ),
  lines(
    'SIGNED as an agreement',
    'Signature of Landlord: ______________________   Date: ____________',
    'Signature of Tenant: ______________________   Date: ____________',
    'Witnessed by: ______________________   Address of witness: ______________________',
    'Schedule: the Property, 14 Mill Lane, Eastbridge. Rent £1,150 per month. Deposit £1,326. Term twelve months.',
  ),
];

const FEE_INVOICE = [
  lines(
    'University of Eastbridge',
    'Student Finance Office',
    'INVOICE',
    'Invoice number: 2026-004711     Invoice date: 14 September 2026',
    'Bill to: Ms A. Student, 12 Station Road, Eastbridge',
    'Tuition fee 2026/27 (Year 2, full-time)                £9,250.00',
    'Accommodation (Hall B, 39 weeks)                       £5,410.00',
    'Sub-total   £14,660.00     VAT   £0.00     Total amount due   £14,660.00',
    'Payment method: bank transfer, quoting your invoice number.',
    'Sort code 20-45-67     Account number 11223344',
    'Payment terms: due within 30 days of the invoice date. Late payment may affect your enrolment.',
  ),
  lines('Notes on paying your fees', 'You can pay by debit card online, by bank transfer or by instalments. Instalment plans are arranged with the Finance Office and must be agreed before the due date shown on your invoice.'),
];

const CV_REFERENCES = [
  lines(
    'Curriculum Vitae',
    'Alex Student  |  alex.student@example.com  |  Eastbridge',
    'Education',
    'BSc Economics, University of Eastbridge, 2023 to 2026, first class honours expected.',
    'Experience',
    'Summer intern, Harbour Analytics, 2025. Built weekly dashboards and cleaned survey data for the research team.',
    'Part-time tutor, Eastbridge Learning Centre, 2024 to 2026. Taught GCSE mathematics to groups of six pupils.',
    'Skills',
    'Spreadsheets, statistics software, report writing, presenting to small groups.',
    'References',
    'Available on request.',
  ),
];

const CV_RESUME = [
  lines(
    'Résumé',
    'Alex Student  |  alex.student@example.com  |  Eastbridge',
    'Education and work history are listed below. Interests include choral singing, cycling and community gardening.',
    'Employment',
    'Barista, Corner Coffee, 2022 to 2024. Customer service, till and stock control.',
    'References',
    'Available on request.',
  ),
];

const BANK_STATEMENT = [
  lines(
    'Northern Bank plc',
    'Statement of account',
    'Account name: MR A STUDENT     Sort code: 40-47-84     Account number: 12345678',
    'IBAN: GB82 WEST 1234 5698 7654 32     BIC: WESTGB2L',
    'Statement date: 30 September 2026     Opening balance £1,204.18     Closing balance £842.77',
    'Date       Description                      Paid out     Paid in     Balance',
    '01 Sep     DIRECT DEBIT THAMES WATER        £28.00                   £1,176.18',
    '03 Sep     CARD PAYMENT COOP FOOD           £14.62                   £1,161.56',
    '05 Sep     FASTER PAYMENT FROM EMPLOYER                  £420.00     £1,581.56',
    '09 Sep     STANDING ORDER RENT              £700.00                  £881.56',
  ),
  lines('Your overdraft limit is £0.00. Interest rates and charges are shown in your terms and conditions. Registered office: 1 High Street, Eastbridge.'),
];

const LAB_RESULT = [
  lines(
    'Pathology Laboratory Report',
    'Patient: Student, Alex     Date of birth: 02/03/1998     NHS number 943 476 5919',
    'Specimen: Serum     Collected: 12 Oct 2026 08:40     Reported: 12 Oct 2026 14:05',
    'Test            Result     Units      Reference range',
    'Sodium          139        mmol/L     133 - 146',
    'Potassium       4.1        mmol/L     3.5 - 5.3',
    'Urea            5.2        mmol/L     2.5 - 7.8',
    'Clinical comment: results are within the expected range. Repeat in three months if symptoms persist.',
  ),
];

const INSURANCE_LETTER = [
  lines(
    'Hartley Home Insurance',
    'Dear Ms Student,',
    'Your policy number HH-4471-209 renews on 1 November 2026. Your annual premium will be £212.40, a change of £9.10 from last year.',
    'If you wish to change your cover, please contact us before the renewal date. If we do not hear from you, we will collect the premium by direct debit in twelve monthly instalments.',
    'Yours sincerely,',
    'Customer Services',
  ),
  lines('Important information about your cover', 'Your excess is £100. Claims for accidental damage must be reported within thirty days. This letter is not a certificate of insurance.'),
];

const PAYSLIP = [
  lines(
    'PAYSLIP',
    'Employee: A. Student     NI number: AB 12 34 56 C     Tax code: 1257L     Pay date: 28 Sep 2026',
    'Gross pay £2,150.00',
    'Deductions: PAYE tax £214.60, National Insurance £120.33, Pension £64.50',
    'Net pay £1,750.57',
    'Year to date (YTD) gross £12,900.00     YTD tax £1,287.60',
  ),
];

const CARD_STATEMENT = [
  lines(
    'Visa Platinum Card Statement',
    'Card number: 4111 1111 1111 1111     Statement date: 30 September 2026',
    'Previous balance £310.45     New purchases £188.20     Payments received £310.45',
    'Minimum payment due £25.00     Payment due date 25 October 2026',
    'Date        Merchant                       Amount',
    '03 Sep      Corner Coffee                  £3.80',
    '07 Sep      Eastbridge Books               £24.99',
  ),
];

const E_TICKET = [
  lines(
    'Akademy Airways e-ticket and boarding pass',
    'Passenger: STUDENT/ALEX MS     Booking reference (PNR): ABC123',
    'Flight AK 1996     Gate A36     Seat 14C     Departs 10 Nov 2026 15:45',
    'M1STUDENT/ALEX        EABC123 VIEMXPAK 1996 314Y014C0012 100',
    'Baggage: 1 x 23 kg. Boarding closes 40 minutes before departure.',
  ),
];

const OFFER_LETTER = [
  lines(
    'Harbour Analytics Ltd',
    'Dear Alex,',
    'We are pleased to offer you the position of Junior Analyst at a salary of £32,000 per year, paid monthly, starting on 4 January 2027.',
    'This offer is subject to satisfactory references and proof of your right to work in the United Kingdom. The terms and conditions of your employment are set out in the enclosed contract, which you should sign and return within fourteen days.',
    'Yours sincerely,',
    'People Team',
  ),
];

const PASSPORT_APPLICATION = [
  lines(
    'Application for a visa: supporting documents',
    'Passport details copied from the identity page:',
    'P<UTOERIKSSON<<ANNA<MARIA'.padEnd(44, '<'),
    'L898902C36UTO7408122F1204159ZE184226B<<<<<10',
    'Please attach a recent photograph and proof of address.',
  ),
];

const EXPENSES = [
  lines(
    'Expense claim form',
    'Claimant: A. Student     Department: Finance',
    'Date        Description                    Amount',
    '12 Oct      Train ticket, Eastbridge to Bonn      £78.75',
    '12 Oct      Hotel receipt, 2 nights               £212.00',
    '14 Oct      Taxi receipt                          £18.50',
    'Total claimed £309.25. Attach all receipts. Approved by: ______________',
  ),
];

const LATEX_INVOICE = [
  lines(
    'INVOICE',
    'Invoice number: 2026-18     Date: 3 October 2026',
    'Bill to: Eastbridge Gardens Ltd',
    'Consulting services, October     £1,800.00',
    'Subtotal £1,800.00     VAT 20% £360.00     Amount due £2,160.00',
    'Payment method: bank transfer. Sort code 40-47-84, Account number 12345678.',
  ),
];

interface Private {
  name: string;
  pages: string[];
  /** Strict: not-learning. Otherwise "anything but learning" (the research accepts an ask for these). */
  strict: boolean;
  /** What a hand-made PDF of this kind is likely to be. */
  producer?: string;
}

const PRIVATE: Private[] = [
  { name: 'tenancy agreement', pages: TENANCY, strict: true, producer: 'Microsoft® Word 2019' },
  { name: 'university fee invoice', pages: FEE_INVOICE, strict: true, producer: 'Apache FOP Version 2.3' },
  { name: 'bank statement with IBAN, sort code and account', pages: BANK_STATEMENT, strict: true, producer: 'Adobe PDF Library 17.0' },
  { name: 'lab result', pages: LAB_RESULT, strict: true, producer: 'Crystal Reports' },
  { name: 'insurance letter', pages: INSURANCE_LETTER, strict: true, producer: 'Microsoft® Word 2019' },
  { name: 'payslip with an NI number', pages: PAYSLIP, strict: true, producer: 'iText 5.5.13' },
  { name: 'card statement with a card number', pages: CARD_STATEMENT, strict: true, producer: 'Adobe PDF Library 17.0' },
  { name: 'e-ticket and boarding pass', pages: E_TICKET, strict: true, producer: 'cairo 1.16.0' },
  { name: 'job offer letter', pages: OFFER_LETTER, strict: true, producer: 'Microsoft® Word 2019' },
  { name: 'visa application with a passport line', pages: PASSPORT_APPLICATION, strict: true, producer: 'Microsoft® Word 2019' },
  { name: 'expense claim', pages: EXPENSES, strict: true, producer: 'Microsoft® Excel 2019' },
  { name: 'invoice made with LaTeX', pages: LATEX_INVOICE, strict: true, producer: 'pdfTeX-1.40.25' },
  { name: 'CV with a References heading', pages: CV_REFERENCES, strict: false, producer: 'Microsoft® Word 2019' },
  { name: 'Résumé (CV) with a References heading', pages: CV_RESUME, strict: false, producer: 'Microsoft® Word 2019' },
];

const sampleFor = (pages: string[], pageCount: number): string[] => Array.from({ length: Math.min(pageCount, 10) }, (_, i) => pages[i % pages.length]);

describe('zero false saves: hand-written private documents, as the owner would meet them', () => {
  it.each(PRIVATE)('$name is not saved by its content alone', ({ pages, strict, producer }) => {
    const pageCount = Math.max(pages.length, 1);
    const d = decide(mkInput({ pageCount, sampleText: sampleFor(pages, pageCount), metadata: producer ? { producer } : {} }));
    const why = `${JSON.stringify(d.reasons)} score ${d.score}`;
    if (strict) expect(d.verdict, why).toBe('not-learning');
    else expect(d.verdict, why).not.toBe('learning');
    expect(d.reasons.length).toBeGreaterThan(0);
  });

  // 14 documents x page counts x links x producers. Nothing here may come out "learning".
  const LINKS: Array<string | null> = [
    null,
    'file:///C:/Users/me/Downloads/document.pdf',
    'https://mail.google.com/mail/u/0/?ui=2&view=att&th=1234',
    'https://www.barclays.co.uk/documents/abc.pdf',
    'https://shop.example.com/orders/123/document.pdf',
    'https://www.example.ac.uk/~astudent/document.pdf',
  ];
  const PAGE_COUNTS = [1, 2, 3, 5, 7];
  const PRODUCERS = [undefined, 'pdfTeX-1.40.25'];

  it('no private document, at any length, from any of these links, made by any of these tools, gets the verdict learning', () => {
    const failures: string[] = [];
    let n = 0;
    for (const doc of PRIVATE) {
      for (const pageCount of PAGE_COUNTS) {
        for (const url of LINKS) {
          for (const producer of PRODUCERS) {
            n++;
            const d = decide(mkInput({ pageCount, url, sampleText: sampleFor(doc.pages, pageCount), metadata: producer ? { producer } : { producer: doc.producer ?? null } }));
            if (d.verdict === 'learning') failures.push(`${doc.name} | ${pageCount} pages | ${url ?? 'no link'} | ${producer ?? doc.producer ?? 'no producer'} | score ${d.score} | ${d.rule}`);
          }
        }
      }
    }
    expect(n).toBe(PRIVATE.length * PAGE_COUNTS.length * LINKS.length * PRODUCERS.length);
    expect(failures, `${failures.length} false saves:\n${failures.join('\n')}`).toEqual([]);
  });

  it('a card statement and a bank statement are hard-blocked even when they are long, LaTeX-made and on a university site', () => {
    for (const pages of [CARD_STATEMENT, BANK_STATEMENT]) {
      const d = decide(mkInput({ pageCount: 30, url: 'https://www.example.ac.uk/files/statement.pdf', metadata: LATEX, sampleText: sampleFor(pages, 30) }));
      expect(d.verdict).toBe('not-learning');
      expect(d.rule).toBe('hard-block');
    }
  });
});

// DECIDED (spec, "Decided while building the filter"): "CVs never save by score. CV evidence counts against saving: CV, resume or
// curriculum vitae titles, Education, Experience or Skills headings, and a contact block on page 1. A CV laid out like a paper,
// with a References heading, is personal, not learning." (Before this was decided, a LaTeX CV with a References heading scored 3.0.)
describe('CVs never save by score, even when laid out like a paper', () => {
  const CONTACT = 'Alex Student  |  alex.student@example.com  |  +44 20 7946 0958  |  Eastbridge';
  const PUBLICATIONS = lines(
    'Publications',
    'A. Student, "Rents and tenancy deposits", Journal of Housing, 2025. doi:10.1000/jhousing.2025.114',
    'A. Student and B. Colleague, "Heating bills", Energy Economics, 2026. doi:10.1000/ee.2026.209',
  );
  const NUMBERED_REFEREES = lines(
    'References',
    '[1] Prof. A. Referee, University of Eastbridge',
    '[2] Dr B. Referee, Harbour Analytics',
    '[3] Ms C. Referee, Corner Coffee',
    '[4] Prof. D. Referee, University of Westbridge',
    '[5] Dr E. Referee, Eastbridge Learning Centre',
    '[6] Mr F. Referee, Harbour Analytics',
  );
  const SECTIONS = lines('Education', 'BSc Economics, University of Eastbridge, 2023 to 2026.', 'Experience', 'Summer intern, Harbour Analytics, 2025.', 'Skills', 'Spreadsheets, statistics software, report writing.');

  const cvs: Array<[string, Spec]> = [
    ['a 3-page LaTeX CV with a References heading', { pageCount: 3, metadata: LATEX, sampleText: sampleFor(CV_REFERENCES, 3) }],
    ['a 2-page LaTeX CV with a References heading on a university site', { pageCount: 2, url: 'https://www.example.ac.uk/~astudent/cv.pdf', metadata: LATEX, sampleText: sampleFor(CV_REFERENCES, 2) }],
    ['a LaTeX Resume (title, contact block, Education, Experience, Skills) with a References heading, 8 pages', { pageCount: 8, metadata: LATEX, first: lines('Résumé', CONTACT, SECTIONS), last: 'References\r\nAvailable on request.' }],
    ['an academic CV of 35 pages on a .edu site, LaTeX, with a publication list and numbered referees', { pageCount: 35, url: 'https://www.example.edu/~astudent/cv.pdf', metadata: LATEX, first: lines('Curriculum Vitae', CONTACT, SECTIONS, PUBLICATIONS), last: NUMBERED_REFEREES }],
    ['a CV with no title, found by its contact block and headings alone, LaTeX, 3 pages, References heading', { pageCount: 3, metadata: LATEX, first: lines(CONTACT, SECTIONS), last: NUMBERED_REFEREES }],
    ['a CV laid out like a paper: Abstract-style summary, DOIs, References, LaTeX, 30 pages, on a scholarly-looking site', { pageCount: 30, url: SCHOLARLY_URL, metadata: LATEX, first: lines('Curriculum Vitae', CONTACT, 'Summary', 'Applied economist working on housing and energy bills.', SECTIONS, PUBLICATIONS), last: NUMBERED_REFEREES }],
  ];

  it.each(cvs)('%s is not saved', (_name, spec) => {
    const d = decide(mkInput(spec));
    expect(d.verdict, `${JSON.stringify(d.reasons)} score ${d.score} rule ${d.rule}`).not.toBe('learning');
    expect(d.reasons.length).toBeGreaterThan(0);
  });

  it('a CV is not rescued by the model: nudge cannot turn it into learning either', () => {
    // nudge only moves "unsure"; if a CV comes back unsure, the strongest similarity must still not save it.
    const d = decide(mkInput(cvs[0][1]));
    if (d.verdict === 'unsure') expect(nudge(d, { learning: 0.95, notLearning: 0.05 }).verdict).not.toBe('learning');
  });

  // The counter-check: one or two CV-like headings are not "CV evidence" by themselves. A labour-economics paper has sections
  // called Education and Experience, and it is a reading. (Guess: the spec lists headings, titles and a contact block as
  // evidence, but not how much is needed; a paper with two section names, no CV title and no contact block must still save.)
  it('a paper with sections called Education and Experience, no CV title and no contact block, is still saved', () => {
    const d = decide(
      mkInput({
        pageCount: 30,
        metadata: LATEX,
        first: lines('Returns to Education and Experience', 'Abstract', 'We describe how pay changes with years of schooling and years of work.'),
        pages: [],
        last: lines('Education', 'Experience', 'References', 'A. Author. A Title. Journal of Things, 2020.'),
      }),
    );
    expect(d.verdict).toBe('learning');
  });
});

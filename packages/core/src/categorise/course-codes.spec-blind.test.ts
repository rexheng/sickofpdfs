// Spec-blind tests for findCourseCodes (R92, "Auto tags", kind "Course").
//
// Sources:
//   spec R92: "Course: a course code found in the link, the folder or page 1 (such as EC1A1, CS50 or 14.01) becomes
//     'Course: EC1A1'." and the Courses row: "Groups by course code found in the link, folder or first page (such as EC1A1)".
//   interface: findCourseCodes({ url?, path?, firstPageText? }): string[]. Codes such as EC1A1, CS50, 14.01, MATH 2301, PH1105,
//     EC2B1, ECON 101. "Returns codes normalised to upper case without the inner space ("MATH2301"), unique, most specific
//     source first (link, then folder, then page 1). It never returns years (2023), page numbers, section numbers ("2.3"),
//     DOIs, arXiv ids, ISBNs, phone numbers or money amounts."
//   brief: dates and version numbers (v2.1) are never returned either. Empty input gives [].
//
// How the tables are split. The spec fixes the code shapes and the "never" list. It does not say how an implementation
// tells "ECON 101" from "Table 12", or "14.01" from "$14.01". So:
//   - "firm" describes use only what the spec or the brief states, or what every lecture-notes page 1 contains
//     ("Lecture 4", "Problem Set 3", "Page 2", "Section 2.3", a date, a phone number in a syllabus).
//   - "careful reader" describes are things a person would call a bug in the Courses tag but the spec never lists
//     (encoded spaces, "hw02.pdf", postcodes, "Python 3.11", currency codes). Expect some to disagree; each is one table
//     row, so a disagreement is one line to triage. Every guess is written down in the report.
//
// Guesses that apply to the whole file:
//   G1  `path` is a file-system path, Windows (C:\...) or Mac/Linux (/Users/...). The file name counts as part of it.
//   G2  Inside one source, codes come back in the order they appear, left to right.
//   G3  A code is the same code however it is spaced or cased: "Math 2301", "math2301" and "MATH\u00a02301" are all "MATH2301".
//   G4  A code written the same in two sources is returned once, at the position of the most specific source.
//   G5  The whole link counts, host name included (cdn.cs50.net), not just the path.
//   G6  Lower-case letters with a space in running text ("of 30", "to 14") are words, not codes; so a spaced code is only
//       expected in capitals or Title Case ("MATH 2301", "Math 2301"). Without a space any case is a code ("math2301").
import { describe, expect, it } from 'vitest';
import { findCourseCodes } from './course-codes';

type Src = Parameters<typeof findCourseCodes>[0];
type Found = [name: string, src: Src, expected: string[]];
type NotFound = [name: string, src: Src];

const link = (url: string): Src => ({ url });
const folder = (path: string): Src => ({ path });
const page1 = (firstPageText: string): Src => ({ firstPageText });
const lines = (...ls: string[]): string => ls.join('\n');

const expectCodes = ([, src, expected]: Found) => expect(findCourseCodes(src)).toEqual(expected);

// ---------------------------------------------------------------------------------------------------------------------
describe('firm: a code in the link', () => {
  it.each<Found>([
    ['LSE Moodle file: code, underscore, lecture number', link('https://moodle.lse.ac.uk/pluginfile.php/1234567/mod_resource/content/2/EC1A1_Lecture_3.pdf'), ['EC1A1']],
    ['UCL Moodle file: four letters, four digits', link('https://moodle.ucl.ac.uk/pluginfile.php/4567890/mod_resource/content/1/ECON0001_Week_2.pdf'), ['ECON0001']],
    ['Stanford class page: lower-case code in the path, "notes1" is not a code', link('https://web.stanford.edu/class/cs229/notes/cs229-notes1.pdf'), ['CS229']],
    ['Warwick module page: lower-case code in the path', link('https://warwick.ac.uk/fac/soc/economics/current/modules/ec226/lectures/week5.pdf'), ['EC226']],
    ['CS50 in the host name; the year in the path is not a code', link('https://cdn.cs50.net/2023/x/lectures/0/lecture0.pdf'), ['CS50']],
    ['Blackboard-style path of ids, then the code in the file name', link('https://learn.ed.ac.uk/bbcswebdav/pid-5123456-dt-content-rid-9876543_1/courses/PH1105-notes.pdf'), ['PH1105']],
    ['Moodle link with a download flag', link('https://moodle.lse.ac.uk/pluginfile.php/1234567/mod_resource/content/2/EC1A1_Lecture_3.pdf?forcedownload=1'), ['EC1A1']],
    ['two codes in one link come back left to right (G2)', link('https://example.edu/courses/econ101/readings/finc201-week3.pdf'), ['ECON101', 'FINC201']],
    ['file: link to a Mac folder', link('file:///Users/rex/Documents/LSE/EC1A1/week3.pdf'), ['EC1A1']],
    ['file: link to a Windows folder', link('file:///C:/Users/Rex/Documents/CS50/lecture0.pdf'), ['CS50']],
  ])('%s', (...row) => expectCodes(row));

  it.each<NotFound>([
    ['Moodle course page: only ids in the query', link('https://moodle.lse.ac.uk/course/view.php?id=2345&section=3')],
    ['Moodle file with no code in its name', link('https://moodle.lse.ac.uk/pluginfile.php/1234567/mod_resource/content/2/Lecture1.pdf')],
    ['Moodle web-service link with a hex token in the query', link('https://moodle.lse.ac.uk/webservice/pluginfile.php/1234567/mod_resource/content/2/Lecture1.pdf?token=0a1b2c3d4e5f60718293a4b5c6d7e8f9')],
    ['JSTOR stable id', link('https://www.jstor.org/stable/pdf/2118029.pdf')],
    ['Springer link with the DOI in the path', link('https://link.springer.com/content/pdf/10.1007/s10654-020-00698-4.pdf')],
    ['ScienceDirect article id', link('https://www.sciencedirect.com/science/article/pii/S0304405X19302995/pdfft')],
    ['Canvas download link', link('https://canvas.harvard.edu/courses/123456/files/7890123/download?download_frd=1')],
    ['Google Drive share link with a long id', link('https://drive.google.com/file/d/1x2Y3z4W5v6U7t8S9r0QpOnMlKjIhGfEdCbA/view?usp=sharing')],
    ['Dropbox link with an id and a flag', link('https://www.dropbox.com/s/a1b2c3d4e5f6g7h/notes.pdf?dl=0')],
    ['NBER working paper number (one letter)', link('https://www.nber.org/system/files/working_papers/w29000/w29000.pdf')],
    ['IMF working paper file name (long digit run)', link('https://www.imf.org/-/media/Files/Publications/WP/2023/English/wpiea2023198-print-pdf.ashx')],
    ['SSRN ids', link('https://papers.ssrn.com/sol3/Delivery.cfm/SSRN_ID3477332_code2392391.pdf?abstractid=3477332&mirid=1')],
    ['Chrome page and zoom fragment', link('https://example.edu/notes.pdf#page=14&zoom=100')],
    ['page in the query', link('https://example.edu/notes.pdf?page=14')],
    ['tracking campaign named for the season', link('https://example.edu/reading.pdf?utm_source=newsletter&utm_campaign=fall2023')],
    ['blob link with a UUID', link('blob:https://example.com/4b9f3c1e-8d2a-4c75-9f0e-1a2b3c4d5e6f')],
    ['Cambridge teaching pages use a year code (2223)', link('https://www.cl.cam.ac.uk/teaching/2223/Algorithms/algorithms-notes.pdf')],
  ])('%s: nothing', (_name, src) => {
    expect(findCourseCodes(src)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('firm: a code in the folder', () => {
  it.each<Found>([
    ['Windows OneDrive folder named for the code (G1)', folder('C:\\Users\\Rex\\OneDrive - LSE\\Year 1\\EC1A1 Economics A\\Lectures\\Lecture 4.pdf'), ['EC1A1']],
    ['Mac folder named only the code', folder('/Users/rex/Documents/LSE/EC2B1/week3.pdf'), ['EC2B1']],
    ['Mac iCloud path with "Year 2" and "Problem Sheet 2" around the code', folder('/Users/rex/Library/Mobile Documents/com~apple~CloudDocs/Uni/Year 2/PH1105 Classical Mechanics/Problem Sheet 2.pdf'), ['PH1105']],
    ['MIT folder named 14.01 on a Windows drive', folder('D:\\MIT\\14.01 Microeconomics\\Lectures\\lec05.pdf'), ['14.01']],
    ['only a file name, no folder (G1)', folder('EC1A1_Lecture_3.pdf'), ['EC1A1']],
    ['code folder in a project tree', folder('/Users/rex/Courses/CS50/pset1/notes.pdf'), ['CS50']],
    ['code with a space in the file name', folder('C:\\Users\\Rex\\Downloads\\MATH 2301 Syllabus.pdf'), ['MATH2301']],
    ['code with a space in a Mac folder', folder('~/Documents/Uni/ECON 101/Reading 3.pdf'), ['ECON101']],
    ['lower-case folder on Linux', folder('/home/rex/uni/ec1a1/lecture-2.pdf'), ['EC1A1']],
    ['date, then code, in the file name', folder('/Users/rex/Downloads/2023-10-31 EC1A1 Lecture.pdf'), ['EC1A1']],
    ['term folder and code folder: only the code', folder('D:\\Uni\\Michaelmas 2023\\EC2B1\\Week 4\\slides.pdf'), ['EC2B1']],
  ])('%s', (...row) => expectCodes(row));

  it.each<NotFound>([
    ['plain Downloads folder', folder('C:\\Users\\Rex\\Downloads\\paper.pdf')],
    ['receipt with a date in the name', folder('/Users/rex/Downloads/Receipt-2023-10-31.pdf')],
    ['year folder and a UK P60 form (one letter)', folder('C:\\Users\\Rex\\Documents\\2022\\Taxes\\P60.pdf')],
    ['camera-style name with a date and time', folder('C:\\Users\\Rex\\Desktop\\20231031_142501.pdf')],
    ['dotted date in the file name', folder('C:\\Users\\Rex\\Downloads\\Statement 14.01.2023.pdf')],
    ['week and lecture numbers only', folder('/Users/rex/Uni/Week 3/Lecture 12.pdf')],
  ])('%s: nothing', (_name, src) => {
    expect(findCourseCodes(src)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('firm: a code on page 1', () => {
  it.each<Found>([
    [
      'lecture notes, LSE style',
      page1(lines('EC1A1 Economics A', 'Lecture 4: Supply and demand', 'Michaelmas Term 2023', 'Dr A. Jones, Department of Economics')),
      ['EC1A1'],
    ],
    ['lecture notes, Stanford style', page1(lines('CS229 Lecture Notes', 'Andrew Ng', 'Supervised learning', 'Lets start by talking about a few examples of supervised learning problems.')), ['CS229']],
    ['lecture slides with just the code and a number', page1(lines('CS50', 'Lecture 0', 'Scratch', 'David J. Malan')), ['CS50']],
    [
      'problem set: a due date and marks around the code',
      page1(lines('MATH 2301 \u2014 Problem Set 3', 'Due: Friday 14 October 2022, 5 pm', 'Answer all questions. Show your working.', 'Question 1 (10 marks)')),
      ['MATH2301'],
    ],
    [
      'syllabus: phone, ISBN, e-mail and an edition around the code',
      page1(
        lines(
          'ECON 101: Principles of Microeconomics',
          'Syllabus, Fall 2023',
          'Instructor: Prof. Maria Santos',
          'Office hours: Tuesdays 2:00-4:00 pm',
          'Email: msantos@university.edu   Phone: (555) 123-4567',
          'Textbook: Mankiw, Principles of Economics, 9th edition. ISBN 978-1-337-79202-3',
        ),
      ),
      ['ECON101'],
    ],
    ['tutorial sheet', page1(lines('PH1105 Classical Mechanics', 'Tutorial sheet 2', '1. A particle of mass 2 kg moves at 3 m/s along a rough plane.')), ['PH1105']],
    ['MIT numbered course as the heading line', page1(lines('14.01 Principles of Microeconomics', 'Fall 2018', 'Lecture 5: Consumer Theory', 'MIT OpenCourseWare')), ['14.01']],
    ['the code is labelled', page1('Course code: PH1105'), ['PH1105']],
    ['the code sits inside a sentence', page1('These notes accompany EC2B1 (Macroeconomics B), taught in Lent Term.'), ['EC2B1']],
    ['cross-listed courses come back in the order written (G2)', page1('Cross-listed: ECON 101 / FINC 201'), ['ECON101', 'FINC201']],
    ['a slash between two codes with no spaces', page1('PH1105/EC2B1'), ['PH1105', 'EC2B1']],
  ])('%s', (...row) => expectCodes(row));

  it.each<[string, string, string[]]>([
    ['round brackets', '(PH1105) Classical Mechanics', ['PH1105']],
    ['square brackets', '[CS50] Introduction to Computer Science', ['CS50']],
    ['a colon after', 'PH1105: Classical Mechanics', ['PH1105']],
    ['quotes round a spaced code', 'Welcome to "MATH 2301".', ['MATH2301']],
    ['a full stop after a letter-digit code', 'The module is EC1A1.', ['EC1A1']],
    ['a comma after', 'Take ECON 101, then ECON 102.', ['ECON101', 'ECON102']],
    ['an exclamation mark after', 'Welcome to CS50!', ['CS50']],
  ])('code next to punctuation: %s', (_name, text, expected) => {
    expect(findCourseCodes(page1(text))).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('firm: normalised to upper case without the inner space (G3)', () => {
  it.each(['MATH 2301', 'Math 2301', 'MATH2301', 'Math2301', 'math2301'])('page 1 says "%s"', (spelled) => {
    expect(findCourseCodes(page1(`${spelled} Syllabus`))).toEqual(['MATH2301']);
  });

  it('lower-case code in the link is returned in upper case', () => {
    expect(findCourseCodes(link('https://example.edu/files/math2301/notes.pdf'))).toEqual(['MATH2301']);
  });

  it('a two-letter code with a space is joined: "CS 50" is CS50', () => {
    expect(findCourseCodes(page1('CS 50 Lecture 1'))).toEqual(['CS50']);
  });

  it('mixed letters and digits keep their order: "ec1a1" is EC1A1', () => {
    expect(findCourseCodes(link('https://example.edu/ec1a1/week1.pdf'))).toEqual(['EC1A1']);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('firm: order (link, folder, page 1) and no duplicates (G4)', () => {
  it('each source adds its own code, most specific first', () => {
    expect(
      findCourseCodes({
        url: 'https://web.stanford.edu/class/cs229/notes/cs229-notes1.pdf',
        path: '/Users/rex/Documents/LSE/EC1A1/week3.pdf',
        firstPageText: 'PH1105 Classical Mechanics',
      }),
    ).toEqual(['CS229', 'EC1A1', 'PH1105']);
  });

  it('the order does not depend on which key is written first in the object', () => {
    expect(
      findCourseCodes({
        firstPageText: 'PH1105 Classical Mechanics',
        path: '/Users/rex/Documents/LSE/EC1A1/week3.pdf',
        url: 'https://web.stanford.edu/class/cs229/notes/cs229-notes1.pdf',
      }),
    ).toEqual(['CS229', 'EC1A1', 'PH1105']);
  });

  it('the same code in all three places is returned once', () => {
    expect(
      findCourseCodes({
        url: 'https://moodle.lse.ac.uk/pluginfile.php/1/mod_resource/content/1/EC1A1_Lecture_3.pdf',
        path: 'C:\\Users\\Rex\\OneDrive\\LSE\\EC1A1\\Lecture 3.pdf',
        firstPageText: 'EC1A1 Economics A\nLecture 3\nEC1A1 is taught in Michaelmas Term.',
      }),
    ).toEqual(['EC1A1']);
  });

  it('a repeat on page 1 does not move a code from the link to the end', () => {
    expect(
      findCourseCodes({
        url: 'https://example.edu/ec1a1/notes.pdf',
        path: '/Users/rex/ph1105/notes.pdf',
        firstPageText: 'EC1A1 and PH1105 and EC2B1',
      }),
    ).toEqual(['EC1A1', 'PH1105', 'EC2B1']);
  });

  it('the same code spelled two ways counts once', () => {
    expect(findCourseCodes({ url: 'https://example.edu/math2301/notes.pdf', firstPageText: 'Math 2301 \u2014 Problem Set 3' })).toEqual(['MATH2301']);
  });

  it('one code repeated many times on page 1 is returned once', () => {
    expect(findCourseCodes(page1('ECON 101 ECON 101 Econ 101 ECON101 ECON 101'))).toEqual(['ECON101']);
  });

  it('only a folder', () => {
    expect(findCourseCodes({ path: '/Users/rex/Documents/LSE/EC2B1/week3.pdf' })).toEqual(['EC2B1']);
  });

  it('only a link', () => {
    expect(findCourseCodes({ url: 'https://example.edu/ec226/week5.pdf' })).toEqual(['EC226']);
  });

  it('the link has no code, so the folder comes before page 1', () => {
    expect(
      findCourseCodes({
        url: 'https://moodle.lse.ac.uk/course/view.php?id=2345',
        path: '/Users/rex/Documents/LSE/EC2B1/week3.pdf',
        firstPageText: 'PH1105 Classical Mechanics',
      }),
    ).toEqual(['EC2B1', 'PH1105']);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('firm: things that are never a course code', () => {
  const rows: Record<string, Array<[name: string, text: string]>> = {
    'years (2023)': [
      ['a bare year', '2023'],
      ['a year after a season', 'Fall 2023'],
      ['a copyright line', '\u00a9 2021 Elsevier B.V. All rights reserved.'],
      ['academic year with a slash', 'Academic year 2022/23'],
      ['academic year with a dash', 'Michaelmas Term 2023-24'],
      ['years in a sentence', 'In 1999 the committee published its first report, revised in 2004.'],
      ['conference names with a year', 'Proceedings of ICML 2020, NeurIPS 2023 and CVPR 2016'],
    ],
    'dates': [
      ['dotted European date', 'Due 14.01.2023'],
      ['dotted date, short year', 'Date: 14.01.23'],
      ['day and month with dots and a full stop', 'Hand in by 14.01.'],
      ['slash date', '14/01/2023'],
      ['ISO date', 'Submitted 2023-01-14'],
      ['long date', 'Friday 14 October 2022, 5 pm'],
      ['month, day, year', 'January 14, 2023'],
      ['one-digit day', '3.10.2023'],
      ['a time of day', 'The lecture starts at 14:01'],
    ],
    'page numbers': [
      ['Page 14', 'Page 14'],
      ['page 2 of 30', 'page 2 of 30'],
      ['p. 14', 'See p. 14 for the proof.'],
      ['pp. 14-20', 'pp. 14-20'],
      ['p.3 without a space', 'p.3'],
      ['14 / 30', '14 / 30'],
      ['a page number between dashes', '- 14 -'],
    ],
    'section numbers (2.3)': [
      ['2.3 alone', '2.3'],
      ['Section 2.3', 'See Section 2.3 for details.'],
      ['paragraph sign', '\u00a7 2.3 Estimation'],
      ['2.3.1 heading', '2.3.1 Definitions'],
      ['Theorem 3.2', 'Theorem 3.2 (Existence).'],
      ['Figure 2.3', 'Figure 2.3: Inflation and unemployment'],
      ['Table 4.12', 'Table 4.12 reports the estimates.'],
      ['Equation (3.14)', 'Substituting into equation (3.14) gives the result.'],
      ['Chapter 14', 'Chapter 14: Consumer theory'],
      ['a contents list', '1. Introduction\n1.1 Motivation\n1.2 Related work\n2. Model\n2.3 Estimation\n12.4 Conclusion'],
    ],
    'small words in front of a number': [
      ['page x of y', 'Page 2 of 30'],
      ['in 20 words', 'Answer in 20 words or fewer.'],
      ['up to 100 marks', 'Allow up to 100 marks for this paper.'],
      ['questions 1 to 15', 'Questions 1 to 15 are compulsory.'],
      ['at 10 am by 12 noon', 'Meet at 10 am and leave by 12 noon.'],
      ['is 14 and was 15', 'The class size is 14 and last year it was 15.'],
    ],
    'lecture-notes labels': [
      ['Lecture 4', 'Lecture 4: Supply and demand'],
      ['Week 3', 'Week 3 reading list'],
      ['Problem Set 3', 'Problem Set 3'],
      ['Exercise 5', 'Exercise 5. Show that the sequence converges.'],
      ['Question 12', 'Question 12 (4 marks)'],
      ['Lecture 12', 'Lecture 12'],
    ],
    'DOIs': [
      ['QJE style', 'https://doi.org/10.1093/qje/qjw024'],
      ['Review of Economic Studies style', 'doi:10.1093/restud/rdx045'],
      ['Journal of Finance', 'DOI: 10.1111/jofi.12345'],
      ['JFE with dotted year', '10.1016/j.jfineco.2019.01.001'],
      ['AER', 'doi.org/10.1257/aer.20150361'],
      ['ACM', 'https://doi.org/10.1145/3292500.3330701'],
      ['Physical Review', 'https://doi.org/10.1103/PhysRevLett.116.061102'],
      ['Chicago Press', 'DOI: 10.1086/705716'],
      ['DataCite arXiv DOI', '10.48550/arXiv.1706.03762'],
    ],
    'arXiv ids': [
      ['new style with version', 'arXiv:1706.03762v5'],
      ['new style, five digits', 'arXiv:2005.14165 [cs.CL] 22 Jul 2020'],
      ['abs link', 'https://arxiv.org/abs/2303.08774'],
      ['old style', 'arXiv:hep-th/9711200v3'],
      ['bare id', '1706.03762'],
    ],
    'ISBNs': [
      ['ISBN-13 with hyphens', 'ISBN 978-0-262-03384-8'],
      ['ISBN-10 with hyphens', 'ISBN: 0-262-03384-4'],
      ['ISBN-13 without hyphens', 'ISBN 9780262033848'],
      ['labelled ISBN-13', 'ISBN-13: 978-3-16-148410-0'],
    ],
    'money amounts': [
      ['dollars', 'Total: $14.01'],
      ['pounds', 'Total \u00a314.01 incl. VAT'],
      ['euros', 'Price \u20ac 14.01'],
      ['thousands and cents', 'Balance $1,401.00'],
      ['pounds, no pence', 'Tuition \u00a32,301 per term'],
    ],
    'phone numbers': [
      ['London landline', 'Tel: 020 7955 7777'],
      ['UK with country code', 'Tel: +44 (0)20 7955 7777'],
      ['US with brackets', 'Tel: (617) 253-1000'],
      ['US with hyphens', 'Tel: 617-253-1000'],
      ['US with dots', 'Tel: 617.253.1000'],
      ['US with country code', 'Tel: +1 617 253 1000'],
      ['UK freephone', 'Tel: 0800 123 4567'],
      ['France', 'Tel: +33 1 42 68 53 00'],
    ],
    'version numbers': [
      ['v2.1', 'This is v2.1 of the handout.'],
      ['v1.0.3', 'Release notes for v1.0.3'],
      ['version 2.1', 'version 2.1'],
      ['Version 3.2.1', 'Version 3.2.1 (draft)'],
      ['a two-digit major version', 'Draft v14.01'],
    ],
  };

  for (const [kind, table] of Object.entries(rows)) {
    it.each(table)(`${kind}: %s`, (_name, text) => {
      expect(findCourseCodes(page1(text))).toEqual([]);
    });
  }

  it('JEL codes on an economics paper are not course codes (one letter)', () => {
    expect(findCourseCodes(page1('JEL classification: E31, E52, E58, G12'))).toEqual([]);
  });

  it('page 1 of a machine-learning paper is full of numbers and has no course code', () => {
    const text = lines(
      'Attention Is All You Need',
      'Ashish Vaswani Google Brain avaswani@google.com',
      '31st Conference on Neural Information Processing Systems (NIPS 2017), Long Beach, CA, USA.',
      'arXiv:1706.03762v7 [cs.CL] 2 Aug 2023',
      'Abstract: The dominant sequence transduction models ... 28.4 BLEU on the WMT 2014 English-to-German task, improving over',
      'the existing best results by over 2 BLEU. We achieve 41.8 after training for 3.5 days on eight GPUs.',
    );
    expect(findCourseCodes(page1(text))).toEqual([]);
  });

  it('page 1 of a journal article is full of identifiers and has no course code', () => {
    const text = lines(
      'The Quarterly Journal of Economics, Vol. 131, No. 2, May 2016, pp. 1-45',
      'Why Has Inflation Stayed Low? Evidence from 1990-2015',
      'DOI: 10.1093/qje/qjw024',
      'JEL: E31, E52. First version 14.01.2015; this version v2.1.',
      'Contact: +44 (0)20 7955 7777. Funded by grant ES/L011859/1. \u00a3250,000 over 3 years.',
    );
    expect(findCourseCodes(page1(text))).toEqual([]);
  });

  it('every decoy together with one real code returns only the code', () => {
    const text = lines(
      'MATH 2301 \u2014 Problem Set 3',
      'Due 14.01.2023, 14:01. Page 14 of 30. See Section 2.3 and Table 4.12.',
      'Total \u00a314.01. Call 617.253.1000 or +44 (0)20 7955 7777.',
      'doi:10.1093/qje/qjw024. arXiv:1706.03762v5. ISBN 978-0-262-03384-8. v2.1. \u00a9 2023.',
    );
    expect(findCourseCodes({ url: 'https://example.edu/notes.pdf?page=14&v=2.1', path: 'C:\\Users\\Rex\\Downloads\\Statement 14.01.2023.pdf', firstPageText: text })).toEqual(['MATH2301']);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('firm: empty and odd input', () => {
  it.each<[string, Src]>([
    ['no keys', {}],
    ['empty strings', { url: '', path: '', firstPageText: '' }],
    ['keys present but undefined', { url: undefined, path: undefined, firstPageText: undefined }],
    ['only white space on page 1', { firstPageText: '   \n\t \r\n ' }],
  ])('%s gives []', (_name, src) => {
    expect(findCourseCodes(src)).toEqual([]);
  });

  it('a link that is not a URL does not throw', () => {
    expect(Array.isArray(findCourseCodes({ url: 'not a url at all' }))).toBe(true);
  });

  it('a link with a broken % escape does not throw and still finds the code', () => {
    expect(findCourseCodes({ url: 'https://example.edu/%E0%A4%A/EC1A1.pdf' })).toEqual(['EC1A1']);
  });

  it('strange characters on page 1 do not throw', () => {
    expect(findCourseCodes(page1('EC1A1 \u0000 \ud800 \u202e \ufeff \u200b caf\u00e9 \u4e2d\u6587 \ud83d\ude00'))).toEqual(['EC1A1']);
  });

  it('the answer is a fresh array each time and the input is left alone', () => {
    const src = Object.freeze({ url: 'https://example.edu/ec226/week5.pdf', path: '/Users/rex/PH1105/a.pdf', firstPageText: 'CS50' });
    const first = findCourseCodes(src);
    first.push('JUNK');
    expect(findCourseCodes(src)).toEqual(['EC226', 'PH1105', 'CS50']);
  });

  it.each([
    ['one very long word', 'A'.repeat(60_000)],
    ['one very long digit run then a letter', `${'9'.repeat(60_000)}x`],
    ['a very long run of spaces', `${' '.repeat(60_000)}x`],
    ['dotted digits without end', '1.'.repeat(30_000)],
    ['two letters and a space, repeated', 'EC '.repeat(20_000)],
    ['120 KB of ordinary lecture text', 'Consumers choose the bundle that maximises utility given the prices and the budget line. '.repeat(1_300)],
  ])('stays fast on %s', (_name, text) => {
    const t0 = performance.now();
    const out = findCourseCodes(page1(text));
    const ms = performance.now() - t0;
    expect(out).toEqual([]);
    expect(ms, `took ${ms.toFixed(0)} ms`).toBeLessThan(2000);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// careful reader: the spec never lists these, a person would still call each one a bug.

describe('careful reader: more ways to write a code', () => {
  it.each<Found>([
    ['hyphen between letters and digits in a file name', link('https://example.edu/files/MATH-2301_syllabus.pdf'), ['MATH2301']],
    ['underscore between letters and digits in a file name', link('https://www.example.edu/files/MATH_2301_syllabus.pdf'), ['MATH2301']],
    ['hyphen on page 1', page1('ECON-101 Principles of Microeconomics'), ['ECON101']],
    ['lower-case code with a space on page 1', page1('math 2301 Syllabus'), ['MATH2301']],
    ['two spaces inside a code', page1('MATH  2301 Syllabus'), ['MATH2301']],
    ['non-breaking space inside a code (PDF text often has one)', page1('MATH\u00a02301 Final Exam'), ['MATH2301']],
    ['percent-encoded space in a Moodle link', link('https://moodle.lse.ac.uk/pluginfile.php/777777/mod_resource/content/1/EC2B1%20Lecture%204.pdf'), ['EC2B1']],
    ['percent-encoded space in a file: link', link('file:///Users/rex/Documents/MATH%202301/notes.pdf'), ['MATH2301']],
    ['MIT OpenCourseWare course path uses a dash (14-01)', link('https://ocw.mit.edu/courses/14-01-principles-of-microeconomics-fall-2018/mit14_01f18_lec01.pdf'), ['14.01']],
    ['MIT OpenCourseWare three-digit course (6-006)', link('https://ocw.mit.edu/courses/6-006-introduction-to-algorithms-spring-2020/'), ['6.006']],
    ['MIT code as the start of a file name', link('https://example.edu/files/14.01_Lecture5.pdf'), ['14.01']],
    ['numbered course with a dash in a folder name', folder('D:\\MIT\\14-01 Microeconomics\\lec05.pdf'), ['14.01']],
    ['MIT linear algebra at the head of page 1', page1(lines('18.06 Linear Algebra', 'Spring 2020', 'Problem set 4')), ['18.06']],
    ['MIT physics at the head of page 1', page1(lines('8.01 Physics I: Classical Mechanics', 'Lecture 7')), ['8.01']],
    ['MIT algorithms at the head of page 1', page1(lines('6.006 Introduction to Algorithms', 'Lecture 3: Sorting')), ['6.006']],
    ['MIT numbered course after the school name', page1('MIT 14.01: Lecture 5. Consumer theory and the budget line.'), ['14.01']],
    ['numbered course at the end of a sentence', page1('This is the problem set for 14.01.\nDue Friday.'), ['14.01']],
    ['syllabus with grading percentages next to the code', page1(lines('ECON 101: Principles of Microeconomics', 'Grading: Midterm 30%, Final 40%, Problem sets 30%')), ['ECON101']],
    [
      'tutorial sheet with decimals and units around the code',
      page1(lines('PH1105 Classical Mechanics', 'Tutorial sheet 2', '1. A particle of mass 2.0 kg moves at 3.5 m/s. Take g = 9.81 m/s^2.')),
      ['PH1105'],
    ],
  ])('%s', (...row) => expectCodes(row));
});

describe('careful reader: decimals, units and labels that sit next to a number', () => {
  it.each<[string, string]>([
    ['a decimal followed by a unit', 'The cart accelerates at 9.81 m/s^2.'],
    ['a percentage', 'Unemployment fell to 14.01%.'],
    ['a decimal in a sentence', 'The total was 14.01 at the end of the day.'],
    ['a p-value and an interval', 'p < 0.05, 95% CI [1.96, 2.58]'],
    ['an amount with a trailing currency code', 'The fee is 14.01 USD.'],
    ['a section number that has two digits', 'Section 14.01 Termination'],
    ['a table number with a leading zero', 'Table 2.03 Summary statistics'],
    ['Term 2', 'Term 2 starts on Monday'],
    ['Year 2', 'Year 2 students'],
    ['Part 3', 'Part 3: Applications'],
    ['Unit 4', 'Unit 4 Reading'],
    ['Module 3', 'Module 3 Reading'],
    ['a room number', 'Office: Room 214, Houghton Street'],
    ['a PO box', 'PO Box 1234, Cambridge'],
  ])('%s', (_name, text) => {
    expect(findCourseCodes(page1(text))).toEqual([]);
  });
});

describe('careful reader: file-name stems that look like a code', () => {
  it.each<[string, string]>([
    ['hw02', '/Users/rex/Uni/hw02.pdf'],
    ['ps03', 'C:\\Users\\Rex\\Uni\\ps03.pdf'],
    ['lec05', '/Users/rex/Uni/lec05.pdf'],
    ['Lecture01', '/Users/rex/Uni/Lecture01.pdf'],
    ['week04_slides', '/Users/rex/Uni/week04_slides.pdf'],
    ['slides12', '/Users/rex/Uni/slides12.pdf'],
    ['ch12', 'C:\\Users\\Rex\\Uni\\ch12.pdf'],
    ['Problem_Set_3', '/Users/rex/Uni/Problem_Set_3.pdf'],
    ['IMG_4521', '/Users/rex/Downloads/IMG_4521.pdf'],
    ['scan0012', '/Users/rex/Downloads/scan0012.pdf'],
    ['Document1', 'C:\\Users\\Rex\\Documents\\Document1.pdf'],
  ])('%s', (_name, path) => {
    expect(findCourseCodes(folder(path))).toEqual([]);
  });

  it.each([['lecturenote01.html'], ['lec03.pdf'], ['hw2.pdf']])('a link ending in %s', (end) => {
    expect(findCourseCodes(link(`https://www.cs.cornell.edu/courses/lectures/${end}`))).toEqual([]);
  });
});

describe('careful reader: other things with letters and numbers in them', () => {
  it.each<[string, string]>([
    ['UK postcode of the LSE', 'London School of Economics, Houghton Street, London WC2A 2AE'],
    ['UK postcode of Oxford', 'Department of Economics, Manor Road, Oxford OX1 3UQ'],
    ['UK postcode of Cambridge', 'Faculty of Economics, Austin Robinson Building, Cambridge CB3 9DD'],
    ['currency code and an amount', 'Fee: GBP 250 per term, or USD 1500 per year'],
    ['a currency code with three digits, like a course', 'Tuition EUR 101'],
    ['ISSN', 'ISSN 0022-1082'],
    ['COVID-19', 'Inflation during COVID-19'],
    ['carbon dioxide', 'CO2 emissions fell by 4%'],
    ['fine particles', 'PM2.5 levels in Delhi'],
    ['methane', 'CH4 and N2O are also greenhouse gases'],
    ['operating system versions', 'Tested on macOS 10.15 and iOS 17.2'],
    ['a language version', 'Requires Python 3.11'],
  ])('%s', (_name, text) => {
    expect(findCourseCodes(page1(text))).toEqual([]);
  });
});

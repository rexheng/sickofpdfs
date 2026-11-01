// Spec-blind tests for Task 31, `decideFormBounce`: when does a PDF go to Chrome's own viewer?
//
// Sources:
//   spec, Release 1 criterion 1: "PDFs loaded by a form post, and PDFs with fillable forms, stay in Chrome's viewer."
//   spec, Reading basics, "Forms": "PDFs with real fillable fields ... are classified first and saved if they are learning PDFs, then
//     reopen in Chrome's own viewer to be filled, through a one-time allow rule for that link and tab. Link boxes that LaTeX adds to
//     papers do not count. If the link can't be fetched again, our view stays, with a banner."
//   interface file (Tasks 30+31): `decideFormBounce({ fillable, source, refetchable }) -> 'stay' | 'bounce' | 'stay-with-banner'`.
//   CLAUDE.md: "no network traffic except what the owner turns on" (so a PDF that is not a form never reaches the bounce).
//
// GUESSES (the interface file does not say; written down in task-30-tests-report.md):
//   G7  A fillable PDF that has no link to fetch again (source null: a file the person picked or dropped) cannot go to Chrome's viewer;
//       it stays with the banner, whatever `refetchable` says (nothing to open).
//   G8  A PDF that is not fillable stays quietly, whatever the link can do: no banner for an ordinary paper whose link happens to be
//       one-time.
import { describe, expect, it } from 'vitest';
import { decideFormBounce, type FormBounceAction } from './form-bounce';

const WEB = 'https://www.gov.uk/government/uploads/sa100.pdf';
const FILE = 'file:///C:/Users/me/Documents/sa100.pdf';

describe('decideFormBounce', () => {
  it.each<{ name: string; fillable: boolean; source: string | null; refetchable: boolean; want: FormBounceAction }>([
    // not a form: our viewer, and no banner
    { name: 'a paper with link boxes only, web link that can be fetched again', fillable: false, source: WEB, refetchable: true, want: 'stay' },
    { name: 'a paper with link boxes only, web link that cannot (G8)', fillable: false, source: WEB, refetchable: false, want: 'stay' },
    { name: 'a paper opened from a file on this computer', fillable: false, source: FILE, refetchable: true, want: 'stay' },
    { name: 'a paper the person picked from disk (no link) (G8)', fillable: false, source: null, refetchable: false, want: 'stay' },
    // a real form, link can be fetched again: Chrome's viewer
    { name: 'a real form, web link that can be fetched again', fillable: true, source: WEB, refetchable: true, want: 'bounce' },
    { name: 'a real form, file on this computer that can be read again', fillable: true, source: FILE, refetchable: true, want: 'bounce' },
    // a real form, link cannot be fetched again: our viewer stays, with a banner
    { name: 'a real form whose web link cannot be fetched again (a one-time link, a login, a Referer check)', fillable: true, source: WEB, refetchable: false, want: 'stay-with-banner' },
    { name: 'a real form whose file cannot be read again', fillable: true, source: FILE, refetchable: false, want: 'stay-with-banner' },
    { name: 'a real form the person picked from disk (no link) (G7)', fillable: true, source: null, refetchable: false, want: 'stay-with-banner' },
    { name: 'a real form with no link, though the probe claims success (G7)', fillable: true, source: null, refetchable: true, want: 'stay-with-banner' },
  ])('$name -> $want', ({ fillable, source, refetchable, want }) => {
    expect(decideFormBounce({ fillable, source, refetchable })).toBe(want);
  });
});

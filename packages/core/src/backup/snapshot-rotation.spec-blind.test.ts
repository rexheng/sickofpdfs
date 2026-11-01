// Spec-blind table tests for the rotation of the nightly copies of library.json (Phase 3, pack T3).
//
// Sources: contracts section 5 ("Backup format v1": `snapshots/library-<YYYY-MM-DD>.json`, "the last 7 nightly copies of
// library.json (open decision D6)") and decision D6 ("Keep the last 7 nightly copies of `library.json` (small), so a bad day
// never overwrites the only good copy. PDFs are not duplicated."), spec "Backups" ("Every night, and after each session with new
// notes, a backup goes to a folder you pick, such as one inside Google Drive for desktop or OneDrive"), CLAUDE.md ("no lost
// notes"; "Receipts and private documents are never touched").
//
// How the tests read a rotation: as the list of files that are in `snapshots/` once tonight's copy is written and the old ones are
// pruned. The kit works that out from whatever the function returns (a list to delete, a list to keep, or a plan with both).
import { describe, expect, it } from 'vitest';
import { days, foldersAfterRotation, snapName } from '../../test/spec-blind/backup-kit';

const names = (dates: readonly string[]): string[] => dates.map(snapName);

interface Row {
  name: string;
  /** What is in snapshots/ before tonight's copy is written. */
  existing: string[];
  today: string;
  /** What should be there afterwards. */
  expected: string[];
}

const rows: Row[] = [
  {
    name: 'a long history is cut to the 7 newest, and tonight\'s copy is one of them',
    existing: names(days('2026-09-20', 12)),
    today: '2026-10-02',
    expected: names(days('2026-09-26', 7)),
  },
  {
    name: 'fewer than 7 copies: nothing is removed',
    existing: names(days('2026-10-28', 3)),
    today: '2026-10-31',
    expected: names([...days('2026-10-28', 3), '2026-10-31']),
  },
  {
    name: 'six old copies and tonight\'s make exactly 7: nothing is removed',
    existing: names(days('2026-10-26', 6)),
    today: '2026-11-01',
    expected: names(days('2026-10-26', 7)),
  },
  {
    name: 'a second backup on the same night does not add a second copy for that night',
    existing: names(days('2026-10-26', 7)),
    today: '2026-11-01',
    expected: names(days('2026-10-26', 7)),
  },
  {
    name: 'missed nights: it keeps the last 7 copies, not the copies of the last 7 days',
    // The computer was off for a month. A calendar window would delete every old copy and leave one.
    existing: names(days('2026-09-25', 7)),
    today: '2026-11-02',
    expected: names([...days('2026-09-26', 6), '2026-11-02']),
  },
  {
    name: 'across a month end and a new year the order is by date, not by day of the month',
    existing: names(days('2026-12-28', 7)),
    today: '2027-01-04',
    expected: names(days('2026-12-29', 7)),
  },
  {
    name: 'the order the folder is listed in does not matter',
    existing: [4, 0, 7, 2, 8, 1, 6, 3, 5].map((i) => names(days('2026-10-10', 9))[i]),
    today: '2026-10-19',
    expected: names(days('2026-10-13', 7)),
  },
  {
    name: 'files in the folder that are not nightly copies are left alone',
    existing: [...names(days('2026-10-10', 8)), 'README.txt', 'library-notes.txt', 'keep-me.json'],
    today: '2026-10-18',
    expected: [...names(days('2026-10-12', 7)), 'README.txt', 'library-notes.txt', 'keep-me.json'],
  },
];

describe('snapshot rotation: the last 7 nightly copies of library.json', () => {
  it.each(rows)('$name', async ({ existing, today, expected }) => {
    const left = await foldersAfterRotation(existing, today);
    expect(left).toEqual([...expected].sort());
  });
});

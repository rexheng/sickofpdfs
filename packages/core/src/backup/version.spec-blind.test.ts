// Spec-blind table tests for the backup version check (Phase 3, pack T3).
//
// Sources: contracts section 5 ("Backup format v1": manifest.json is `{ format: 'sop-backup', version: 1, createdAt,
// schemaVersion, appVersion, counts, pdfs }`; "Versions. Restore reads any `version` up to the one it knows. It refuses a higher
// one with 'Update sickofpdfs first'"), section 4 (a newer version is never written over, and the owner is told in plain words),
// CLAUDE.md ("plain, clear wording in the UI"; "no lost notes").
//
// How the tests read the check: was the backup accepted, and if not, what would the owner be told. The kit finds the function and
// treats a thrown error as a refusal with the error's message.
import { describe, expect, it } from 'vitest';
import { knownVersion, manifest, versionVerdict } from '../../test/spec-blind/backup-kit';

const known = await knownVersion();
const without = (key: string): Record<string, unknown> => {
  const m = manifest();
  delete m[key];
  return m;
};

describe('the backup format version', () => {
  it.each(Array.from({ length: known }, (_, i) => i + 1))('reads a backup of version %s', async (v) => {
    const verdict = await versionVerdict(manifest({ version: v }));
    expect(verdict.accepted, verdict.message).toBe(true);
  });

  it('goes by the format version only: a newer app or database version on the label does not stop a restore', () =>
    versionVerdict(manifest({ appVersion: '99.0.0', schemaVersion: 3, createdAt: Date.UTC(2031, 0, 1) })).then((verdict) => {
      expect(verdict.accepted, verdict.message).toBe(true);
    }));

  const higher = [known + 1, 99, Number.MAX_SAFE_INTEGER];
  it.each(higher)('refuses version %s, and says "Update sickofpdfs first"', async (v) => {
    const verdict = await versionVerdict(manifest({ version: v }));
    expect(verdict.accepted).toBe(false);
    expect(verdict.message).toMatch(/update sickofpdfs first/i);
  });

  const notBackups: [name: string, value: unknown][] = [
    ['a different format', manifest({ format: 'something-else' })],
    ['no format', without('format')],
    ['no version', without('version')],
    ['a version of null', manifest({ version: null })],
    ['a version that is not a number', manifest({ version: 'one' })],
    ['a version of NaN', manifest({ version: Number.NaN })],
    ['a version of 0', manifest({ version: 0 })],
    ['a negative version', manifest({ version: -1 })],
    ['a version that is not a whole number', manifest({ version: 1.5 })],
    ['an empty object', {}],
    ['null', null],
    ['an array', []],
    ['plain text', 'not a manifest'],
    ['a number', 42],
  ];
  it('refuses anything that is not a backup this app wrote, in plain words and without crashing', async () => {
    const failures: string[] = [];
    for (const [name, value] of notBackups) {
      const verdict = await versionVerdict(value);
      if (verdict.accepted) failures.push(`${name}: accepted`);
      else if (verdict.message.trim().length === 0) failures.push(`${name}: refused, but the owner is told nothing`);
      else if (/undefined|\bnull\b|TypeError|Cannot read|\[object|\bat\s.+:\d+/.test(verdict.message)) failures.push(`${name}: the words are a JavaScript error: ${verdict.message}`);
    }
    expect(failures).toEqual([]);
  });
});

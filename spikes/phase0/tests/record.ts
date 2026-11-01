import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from '@playwright/test';

export const RESULTS_DIR = fileURLToPath(new URL('../results/', import.meta.url));

export interface CheckResult {
  pass: boolean | 'blocked';
  measured: string;
  note?: string;
  /** A part of the check that was not run, by decision: what and why (the report marks the check PART DEFERRED). */
  deferred?: string;
}

/** The last result each test recorded in this worker, by test id (see recordedBy). */
const recordedByTest = new Map<string, CheckResult>();

/**
 * Appends one measurement to results/<id>.json. Appending keeps every run of a check
 * (per engine, zoom or worker count); scripts/report.mjs uses the latest entry of each test.
 */
export async function record(id: `P0-${number}`, r: CheckResult): Promise<void> {
  const file = join(RESULTS_DIR, `${id}.json`);
  await mkdir(RESULTS_DIR, { recursive: true });
  const entries: unknown[] = existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) : [];
  const info = currentTest();
  entries.push({ ...r, test: info?.title, at: new Date().toISOString() });
  await writeFile(file, `${JSON.stringify(entries, null, 2)}\n`);
  if (info) recordedByTest.set(info.testId, r);
}

/** What the test with this id recorded last in this run, so a failure entry can keep its measurements. */
export function recordedBy(testId: string): CheckResult | undefined {
  return recordedByTest.get(testId);
}

function currentTest(): { title: string; testId: string } | undefined {
  try {
    return test.info();
  } catch {
    return undefined; // called outside a test
  }
}

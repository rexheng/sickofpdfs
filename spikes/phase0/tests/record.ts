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
}

/**
 * Appends one measurement to results/<id>.json. Appending keeps every run of a check
 * (per engine, zoom or worker count); scripts/report.mjs uses the latest entry of each test.
 */
export async function record(id: `P0-${number}`, r: CheckResult): Promise<void> {
  const file = join(RESULTS_DIR, `${id}.json`);
  await mkdir(RESULTS_DIR, { recursive: true });
  const entries: unknown[] = existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) : [];
  entries.push({ ...r, test: currentTestTitle(), at: new Date().toISOString() });
  await writeFile(file, `${JSON.stringify(entries, null, 2)}\n`);
}

function currentTestTitle(): string | undefined {
  try {
    return test.info().title;
  } catch {
    return undefined; // called outside a test
  }
}

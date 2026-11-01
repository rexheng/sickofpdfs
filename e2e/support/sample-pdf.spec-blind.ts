// Writes the small PDF that the Task 12 spec-blind tests open. Kept apart from raw-launch.spec-blind.ts so that
// Vitest can use it without loading Playwright.
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts } from 'pdf-lib';

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Makes sure test-assets/<name> exists (the fixture server serves test-assets/ at /f/<name>): a small
 * 3-page PDF with real text, so these tests do not depend on the downloaded fixture set.
 */
export async function ensureSamplePdf(name: string): Promise<{ path: string; bytes: Uint8Array }> {
  const dir = join(REPO_ROOT, 'test-assets');
  const path = join(dir, name);
  await mkdir(dir, { recursive: true });
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 3; i++) {
    doc.addPage([420, 595]).drawText(`sickofpdfs task 12 sample, page ${i}`, { x: 40, y: 540, size: 18, font });
  }
  const bytes = await doc.save();
  // Written to a temp name first so a parallel run never serves half a file.
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, bytes);
  await rename(tmp, path);
  return { path, bytes };
}

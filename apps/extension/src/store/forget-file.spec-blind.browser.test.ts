// Spec-blind browser test for Task 28: Forget on the REAL library file in OPFS (ruling R13).
//
// Sources:
//   interface file (Task 28), migrate: "pragmas foreign_keys=ON, journal_mode=TRUNCATE, synchronous=FULL, secure_delete=ON. Deleted rows
//     are overwritten in the file, and the journal is truncated rather than left in a free OPFS slot, so a forgotten PDF leaves no bytes
//     behind (ruling R13)"; forgetDocument runs FTS5 'optimize' "so no deleted words stay in the index files".
//   spec, Privacy: "'Forget this PDF' removes it completely".
//   spec, Storage: the database is SQLite in the origin private file system.
// What it does: one worker fills the library file and is stopped; the test then reads EVERY file the file layer keeps in OPFS (database
// slots and journal slots) and looks for the PDF's words in the raw bytes; a second worker forgets the PDF; the files are read again.
// The workers use the same SAH-pool file layer the real store worker uses; the store code under test runs inside them.
import { afterEach, describe, expect, it } from 'vitest';

const dirs: string[] = [];
const workers: Worker[] = [];
afterEach(async () => {
  for (const w of workers.splice(0)) w.terminate();
  const root = await navigator.storage.getDirectory();
  for (const d of dirs.splice(0)) await root.removeEntry(d, { recursive: true }).catch(() => undefined);
});

async function once(cmd: 'fill' | 'forget', dir: string): Promise<{ settings: Record<string, unknown> }> {
  const worker = new Worker(new URL('./forget-file.spec-blind.worker.ts', import.meta.url), { type: 'module' });
  workers.push(worker);
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`worker did not answer ${cmd}`)), 30_000);
      worker.onmessage = (e: MessageEvent<{ ok: boolean; value?: { settings: Record<string, unknown> }; error?: string }>) => {
        clearTimeout(timer);
        if (e.data.ok) resolve(e.data.value!);
        else reject(new Error(e.data.error));
      };
      worker.onerror = (e) => reject(new Error(e.message));
      worker.postMessage({ id: 1, cmd, dir });
    });
  } finally {
    worker.terminate();
  }
}

/** Every file below `dir` in OPFS, read whole, as latin-1 text (so ASCII words can be found with `includes`). */
async function readAllFiles(dir: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const walk = async (handle: FileSystemDirectoryHandle, path: string): Promise<void> => {
    for await (const [name, child] of handle.entries()) {
      if (child.kind === 'directory') {
        await walk(child, `${path}/${name}`);
        continue;
      }
      let bytes: ArrayBuffer | undefined;
      for (let i = 0; i < 30 && bytes === undefined; i++) {
        try {
          bytes = await (await (child).getFile()).arrayBuffer();
        } catch {
          await new Promise((r) => setTimeout(r, 100)); // the stopped worker's handles are let go a moment later
        }
      }
      found.set(`${path}/${name}`, bytes === undefined ? '' : new TextDecoder('latin1').decode(bytes));
    }
  };
  await walk(await (await navigator.storage.getDirectory()).getDirectoryHandle(dir), dir);
  return found;
}

const where = (files: Map<string, string>, needle: string): string[] => [...files].filter(([, text]) => text.includes(needle)).map(([path]) => path);

describe('Forget on the real file', () => {
  const GONE = ['Quokkanomics', 'quokkanomics', 'Zibbleton', 'zibbleton', 'platypusword', 'echidnaword', 'quokka-links.example'];
  const STAYS = ['Marmoset', 'Tamarin', 'Gibbonword'];

  it('opens the file with the safety settings the spec names, and after Forget no byte of the PDF is left in any file: database, index or journal', async () => {
    const dir = `sop-test-${crypto.randomUUID()}`;
    dirs.push(dir);

    const filled = await once('fill', dir);
    // Ruling N5 (backup re-check, 2 Nov): schema v4 adds the local forgotten list, so the newest version is 4 (was 3).
    expect(filled.settings).toMatchObject({ user_version: 5, foreign_keys: 1, secure_delete: 1, synchronous: 2 });
    expect(String(filled.settings['journal_mode']).toLowerCase(), 'a journal left in a free slot would keep old bytes').toBe('truncate');

    const before = await readAllFiles(dir);
    expect(before.size, 'the file layer keeps its files here').toBeGreaterThan(0);
    for (const word of [...GONE, ...STAYS]) expect(where(before, word).length, `the scan finds "${word}" before Forget`).toBeGreaterThan(0);

    await once('forget', dir);

    const after = await readAllFiles(dir);
    for (const word of GONE) expect(where(after, word), `"${word}" is still in the file`).toEqual([]);
    for (const word of STAYS) expect(where(after, word).length, `the other PDF's "${word}" must stay`).toBeGreaterThan(0);
  });
});

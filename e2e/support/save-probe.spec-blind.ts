// Helpers for the save-decision and form-bounce user tests (Tasks 30 and 31). Written from the interface file only.
//
//  - The viewer publishes `blobStore` and `save: { state(), documentId(), firstMark() }` on the test hooks (interface file, Task 30). The
//    shapes are declared here, not imported, so these tests load whether or not that code exists yet.
//  - The chip sits in the header ("the chip goes in the header slot"); its words are the interface file's chip table.
//  - Files are looked at in the extension's private file storage (OPFS) the way the owner's disk would hold them: the stored copies live
//    in `pdf/<first two hex digits>/<sha256>.pdf` (Task 29's binding layout), the library database under `.sop-db/`.
import type { Locator, Page, Worker } from '@playwright/test';
import { hooks } from './test';

export interface SaveStateShape {
  kind: string;
  documentId?: string;
  undoable?: boolean;
  reasons?: string[];
}
interface SaveHooks {
  blobStore: { has(sha: string): Promise<boolean> } | null | undefined;
  save: { state(): SaveStateShape; documentId(): string | null; firstMark(): Promise<void> } | undefined;
}

/** The save controller as the viewer publishes it. */
export const save = (page: Page) => ({
  state: (): Promise<SaveStateShape | null> => hooks(page).eval((h) => (h as unknown as SaveHooks).save?.state() ?? null),
  documentId: (): Promise<string | null> => hooks(page).eval((h) => (h as unknown as SaveHooks).save?.documentId() ?? null),
  /** What the mark flow (Phase 2) will call on the first mark. */
  firstMark: (): Promise<void> => hooks(page).eval((h) => (h as unknown as SaveHooks).save!.firstMark()),
  /** 'null' in Incognito, 'missing' when the viewer publishes none. */
  blobStore: (): Promise<'present' | 'null' | 'missing'> =>
    hooks(page).eval((h) => {
      const b = (h as unknown as SaveHooks).blobStore;
      return b === undefined ? 'missing' : b === null ? 'null' : 'present';
    }),
  hasBlob: (sha: string): Promise<boolean> => hooks(page).eval((h, s) => (h as unknown as SaveHooks).blobStore!.has(s), sha),
});

/** The header's chip area. */
export const header = (page: Page): Locator => page.locator('header');
/** A button in the header whose name matches (the chip, "Undo"). */
export const headerButton = (page: Page, name: string | RegExp): Locator => header(page).getByRole('button', { name });

export const CHIP = {
  saved: /Saved to library/,
  unsure: /Not sure: Save\?/,
  incognito: /Incognito: view only/,
} as const;

/** Waits until the save decision has been made (the chip is not in its "checking" state any more). */
export async function waitDecided(page: Page, timeout = 20_000): Promise<SaveStateShape> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const state = await save(page).state();
    if (state !== null && state.kind !== 'checking') return state;
    if (Date.now() > deadline) throw new Error(`the save decision never settled (state: ${JSON.stringify(state)})`);
    await page.waitForTimeout(100);
  }
}

export interface OpfsFile {
  /** From the OPFS root, with `/`. */
  path: string;
  size: number;
}

/**
 * The files under the OPFS folder `dir` ('' for the root), recursively; [] when the folder does not exist. `target` is a page or the
 * extension's service worker: both see the extension's origin.
 */
export function listOpfs(target: Pick<Worker, 'evaluate'>, dir: string): Promise<OpfsFile[]> {
  return target.evaluate(async (wanted: string) => {
    let folder = await navigator.storage.getDirectory();
    for (const part of wanted.split('/').filter(Boolean)) {
      try {
        folder = await folder.getDirectoryHandle(part);
      } catch {
        return [];
      }
    }
    const out: { path: string; size: number }[] = [];
    const walk = async (d: FileSystemDirectoryHandle, base: string): Promise<void> => {
      for await (const [name, handle] of d.entries()) {
        const path = base === '' ? name : `${base}/${name}`;
        if (handle.kind === 'directory') await walk(handle, path);
        else out.push({ path, size: (await handle.getFile()).size });
      }
    };
    await walk(folder, wanted.split('/').filter(Boolean).join('/'));
    return out;
  }, dir);
}

/** The OPFS files (from the root) whose bytes contain `needle` as text. Files that cannot be opened are not searched. */
export function opfsFilesContaining(target: Pick<Worker, 'evaluate'>, needle: string): Promise<string[]> {
  return target.evaluate(async (wanted: string) => {
    const found: string[] = [];
    const walk = async (dir: FileSystemDirectoryHandle, path: string): Promise<void> => {
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind === 'directory') {
          await walk(handle, `${path}${name}/`);
          continue;
        }
        try {
          const bytes = await (await handle.getFile()).arrayBuffer();
          if (new TextDecoder('latin1').decode(bytes).includes(wanted)) found.push(`${path}${name}`);
        } catch {
          // unreadable: not a file anyone could search either
        }
      }
    };
    await walk(await navigator.storage.getDirectory(), '');
    return found;
  }, needle);
}

/** The SHA-256 (lower-case hex) of the OPFS file at `path`, computed in the page. */
export function opfsSha256(page: Page, path: string): Promise<string> {
  return page.evaluate(async (p: string) => {
    let dir = await navigator.storage.getDirectory();
    const parts = p.split('/').filter(Boolean);
    const name = parts.pop()!;
    for (const part of parts) dir = await dir.getDirectoryHandle(part);
    const bytes = await (await (await dir.getFileHandle(name)).getFile()).arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  }, path);
}

/** Where Task 29's blob store keeps the copy of a saved PDF. */
export const blobPathOf = (sha: string): string => `pdf/${sha.slice(0, 2)}/${sha}.pdf`;

import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { BrowserContext } from '@playwright/test';
import { EXTENSION_ID } from '../../apps/extension/scripts/extension-id.mjs';
import { launchExtension } from './launch';

/**
 * Which Chrome extension toggles a profile starts with.
 * - `seeded`: "Allow access to file URLs" and "Allow in Incognito" are both on.
 * - `bare`: both are off, as for an unpacked extension a person has just loaded in Chrome. Chromium switches file
 *   access on by itself for an extension loaded with `--load-extension`, so a profile that skips seeding would not
 *   be bare; this one switches it off.
 */
export type ProfileKind = 'seeded' | 'bare';

const TOGGLES = {
  file: { label: 'Allow access to file URLs', isOn: () => chrome.extension.isAllowedFileSchemeAccess() },
  incognito: { label: 'Allow in Incognito', isOn: () => chrome.extension.isAllowedIncognitoAccess() },
} as const;

/**
 * Reads a toggle through an extension page. A toggle reloads the extension, and a reloaded service worker with no
 * event to answer stays asleep, so the worker is not a dependable place to ask.
 */
async function readToggle(context: BrowserContext, key: keyof typeof TOGGLES): Promise<boolean | null> {
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${EXTENSION_ID}/viewer.html`);
    return await page.evaluate(TOGGLES[key].isOn);
  } catch {
    return null; // the extension is reloading
  } finally {
    await page.close().catch(() => {});
  }
}

/** Clicks the extensions-page toggle until the extension reports `want`; fails after `timeout` ms. */
async function setToggle(context: BrowserContext, key: keyof typeof TOGGLES, want: boolean, timeout = 15_000): Promise<void> {
  if ((await readToggle(context, key)) === want) return;
  const page = await context.newPage();
  try {
    await page.goto(`chrome://extensions/?id=${EXTENSION_ID}`);
    await page.locator('extensions-toggle-row', { hasText: TOGGLES[key].label }).locator('cr-toggle').click({ timeout });
    const deadline = Date.now() + timeout;
    while ((await readToggle(context, key)) !== want) {
      if (Date.now() > deadline) throw new Error(`"${TOGGLES[key].label}" did not become ${want ? 'on' : 'off'}`);
      await page.waitForTimeout(200);
    }
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Switches on "Developer mode". Without it, Chromium turns an unpacked extension off the first time it reloads, and
 * a toggle below reloads it. A person who loads an unpacked extension has developer mode on too.
 */
async function enableDeveloperMode(context: BrowserContext): Promise<void> {
  const page = await context.newPage();
  try {
    await page.goto('chrome://extensions/');
    const toggle = page.locator('extensions-toolbar cr-toggle#devMode');
    if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
    await page.locator('extensions-toolbar cr-toggle#devMode[aria-pressed="true"]').waitFor();
  } finally {
    await page.close().catch(() => {});
  }
}

/** Starts the test build in the empty folder `dir`, sets the toggles for `kind`, and closes Chromium so the settings are saved. */
export async function seedProfile(kind: ProfileKind, dir: string): Promise<void> {
  const on = kind === 'seeded';
  const context = await launchExtension({ userDataDir: dir });
  try {
    await enableDeveloperMode(context);
    await setToggle(context, 'file', on);
    await setToggle(context, 'incognito', on);
    // the toggles reload the extension; once it is back, it must report what was asked for
    if ((await readToggle(context, 'file')) !== on || (await readToggle(context, 'incognito')) !== on) {
      throw new Error(`profile "${kind}" was not seeded`);
    }
  } finally {
    await context.close();
  }
}

/** A seeded profile per kind, made on first use and kept until `dispose()`; each launch copies it. */
export function profileTemplates() {
  const made = new Map<ProfileKind, Promise<string>>();
  const roots: string[] = [];
  return {
    /** A fresh copy of the `kind` profile, for one browser launch. Delete it with `rm` when the launch is over. */
    async copy(kind: ProfileKind): Promise<string> {
      if (!made.has(kind)) {
        made.set(
          kind,
          (async () => {
            const root = await mkdtemp(join(tmpdir(), `sop-profile-${kind}-`));
            roots.push(root);
            const template = join(root, 'template');
            await seedProfile(kind, template);
            return template;
          })(),
        );
      }
      const template = await made.get(kind)!;
      const dest = await mkdtemp(join(tmpdir(), `sop-run-${kind}-`));
      // a closed Chromium leaves no lock files, but a crashed one does, and they would stop the copy from starting
      await cp(template, dest, { recursive: true, filter: (src) => !basename(src).startsWith('Singleton') });
      return dest;
    },
    async dispose(): Promise<void> {
      await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })));
    },
  };
}

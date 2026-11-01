// Launches Chromium (new headless, the full build, as the Phase 0 spike does) with the built extension, and returns the
// extension's bench page plus helpers to read the browser's memory from /proc.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

export const DIST = fileURLToPath(new URL(`../${process.env.SOP_DIST ?? 'dist'}/`, import.meta.url));
const PREINSTALLED = '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome';

const procs = () =>
  readdirSync('/proc')
    .filter((d) => /^\d+$/.test(d))
    .map((d) => {
      try {
        const stat = readFileSync(`/proc/${d}/stat`, 'utf8');
        const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
        return { pid: Number(d), ppid };
      } catch {
        return null;
      }
    })
    .filter(Boolean);

function status(pid) {
  try {
    const s = readFileSync(`/proc/${pid}/status`, 'utf8');
    const kb = (k) => Number(new RegExp(`^${k}:\\s+(\\d+) kB`, 'm').exec(s)?.[1] ?? 0);
    const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
    return { pid, rssMB: kb('VmRSS') / 1024, peakMB: kb('VmHWM') / 1024, type: /--type=([a-z-]+)/.exec(cmd)?.[1] ?? 'browser', extension: cmd.includes('--extension-process') };
  } catch {
    return null;
  }
}

/** CPU seconds (user + system) used so far by the browser and all its child processes, from /proc. */
export function cpuSeconds(rootPid) {
  const all = procs();
  const kids = new Set([rootPid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of all) if (!kids.has(p.pid) && kids.has(p.ppid)) (kids.add(p.pid), (grew = true));
  }
  let ticks = 0;
  for (const pid of kids) {
    try {
      const st = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const f = st.slice(st.lastIndexOf(')') + 2).split(' ');
      ticks += Number(f[11]) + Number(f[12]); // utime, stime (fields 14, 15)
    } catch {}
  }
  return ticks / 100;
}

/** RSS and peak RSS (MB) of the browser and every child process, from /proc. */
export function memory(rootPid) {
  const all = procs();
  const kids = new Set([rootPid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of all) if (!kids.has(p.pid) && kids.has(p.ppid)) (kids.add(p.pid), (grew = true));
  }
  const rows = [...kids].map(status).filter(Boolean);
  const sum = (f) => rows.reduce((a, r) => a + f(r), 0);
  return { totalRssMB: sum((r) => r.rssMB), renderers: rows.filter((r) => r.type === 'renderer').map((r) => ({ pid: r.pid, rssMB: Math.round(r.rssMB), peakMB: Math.round(r.peakMB), extension: r.extension })), gpuMB: Math.round(sum((r) => (r.type === 'gpu-process' ? r.rssMB : 0))), rows: rows.map((r) => ({ type: r.type, pid: r.pid, rssMB: Math.round(r.rssMB), peakMB: Math.round(r.peakMB) })) };
}

export async function launch({ serverOrigin, args = [], requestLog } = {}) {
  const userDataDir = await mkdtemp(join(tmpdir(), 'sop-ocr-'));
  // SOP_CHROME=<path to chrome.exe / chrome> and SOP_HEADED=1 are for the Windows hand runs (real GPU, real Chrome).
  const executablePath = process.env.SOP_CHROME ?? (!existsSync(chromium.executablePath()) && existsSync(PREINSTALLED) ? PREINSTALLED : undefined);
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: process.env.SOP_CHROME ? undefined : 'chromium',
    headless: process.env.SOP_HEADED !== '1',
    viewport: { width: 1000, height: 700 },
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, ...args],
    ...(executablePath ? { executablePath } : {}),
  });
  const isExt = (w) => w.url().startsWith('chrome-extension://');
  const worker = context.serviceWorkers().find(isExt) ?? (await context.waitForEvent('serviceworker', { predicate: isExt, timeout: 15000 }));
  const extensionId = new URL(worker.url()).host;
  // every request any page or worker makes: the "no request except the PDF" check
  context.on('request', (r) => requestLog?.push({ url: r.url().slice(0, 160), type: r.resourceType() }));
  const page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(0);
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && problems.push(`${m.type()}: ${m.text().slice(0, 300)}`));
  await page.goto(`chrome-extension://${extensionId}/bench.html?server=${encodeURIComponent(serverOrigin)}`);
  await page.waitForFunction(() => window.__benchReady === true);
  // the browser process: the one in /proc that has our user-data-dir and no --type=
  const root = readdirSync('/proc').filter((d) => /^\d+$/.test(d)).find((d) => {
    try {
      const c = readFileSync(`/proc/${d}/cmdline`, 'utf8');
      return c.includes(userDataDir) && !c.includes('--type=') && !c.includes('crashpad');
    } catch {
      return false;
    }
  });
  return {
    context,
    page,
    worker,
    extensionId,
    problems,
    rootPid: Number(root),
    memory: () => memory(Number(root)),
    cpuSeconds: () => cpuSeconds(Number(root)),
    async close() {
      await context.close();
      await rm(userDataDir, { recursive: true, force: true });
    },
  };
}

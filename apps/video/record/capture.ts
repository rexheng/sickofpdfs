// Real footage for the launch video: a tab's own frames, taken through the DevTools protocol as fast as the tab gives them, then
// turned into a 30 fps MP4 clip with ffmpeg (each frame is held until the next one).
//
//   const clip = await startClip(page, 'marks');
//   clip.mark('highlight');      // a moment the video cuts or captions on, in seconds from the clip's start
//   await clip.stop();           // writes public/clips/marks.mp4 and its marks, and deletes the frames
//
// A drawn arrow stands in for the mouse pointer, which a headless browser does not paint (installPointer).
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CDPSession, Page } from '@playwright/test';

export const VIDEO_ROOT = fileURLToPath(new URL('../', import.meta.url));
/** The clips and their marks, read by the Remotion project (staticFile('clips/…')). Not committed. */
export const CLIPS_DIR = join(VIDEO_ROOT, 'public', 'clips');
/** Frames wait here until they are encoded, then are deleted. */
const FRAMES_ROOT = process.env.SOP_VIDEO_FRAMES ?? join(VIDEO_ROOT, '.frames');
const MANIFEST = join(CLIPS_DIR, 'manifest.json');

export interface ClipInfo {
  /** Seconds. */
  duration: number;
  width: number;
  height: number;
  marks: Record<string, number>;
}

export interface Clip {
  mark(name: string): void;
  stop(): Promise<ClipInfo>;
}

/** `scale`: device pixels per CSS px (the context's deviceScaleFactor; a page's own devicePixelRatio also moves with its zoom). */
export async function startClip(page: Page, name: string, scale: number): Promise<Clip> {
  const dir = join(FRAMES_ROOT, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  let cdp: CDPSession = await page.context().newCDPSession(page);
  const frames: { file: string; t: number }[] = [];
  const marks: Record<string, number> = {};
  const t0 = Date.now() / 1000;
  // A screenshot loop rather than the screencast: the screencast sends frames at CSS-pixel size, and the video wants the
  // window's real pixels (1.2 per CSS px). A plain capture comes at CSS-pixel size too; a clip with the device scale draws
  // the real pixels. Each frame is stamped with the moment between asking and getting it.
  // When the tab moves to another process (a link opens the extension's viewer), the old session stops answering: after a
  // call that hangs, a new session is made.
  const within = <T>(p: Promise<T>, ms: number): Promise<T | null> =>
    Promise.race([p.catch(() => null), new Promise<null>((res) => setTimeout(() => res(null), ms))]);
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      const asked = Date.now() / 1000;
      const m = await within(cdp.send('Page.getLayoutMetrics'), 2000);
      const v = m?.cssVisualViewport;
      const clip = v ? { x: v.pageX, y: v.pageY, width: v.clientWidth, height: v.clientHeight, scale } : undefined;
      const r = m ? await within(cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 92, optimizeForSpeed: true, ...(clip ? { clip } : {}) }), 3000) : null;
      if (!r) {
        const old = cdp;
        void old.detach().catch(() => {});
        const next = await within(page.context().newCDPSession(page), 3000);
        if (next) cdp = next;
        await new Promise((res) => setTimeout(res, 30));
        continue;
      }
      const file = join(dir, `${String(frames.length).padStart(6, '0')}.jpg`);
      writeFileSync(file, Buffer.from(r.data, 'base64'));
      frames.push({ file, t: (asked + Date.now() / 1000) / 2 });
    }
  })();
  while (frames.length === 0) await new Promise((res) => setTimeout(res, 20));
  return {
    mark(m) {
      marks[m] = Date.now() / 1000 - t0;
    },
    async stop() {
      const tEnd = Date.now() / 1000;
      stopped = true;
      await loop;
      await cdp.detach().catch(() => {});
      if (frames.length === 0) throw new Error(`clip ${name}: no frames`);
      // The frames carry wall-clock times (seconds since the epoch), like the marks: the clip starts at the first frame.
      const start = frames[0].t;
      for (const k of Object.keys(marks)) marks[k] = Math.max(0, marks[k] + t0 - start);
      const lines = ['ffconcat version 1.0'];
      frames.forEach((f, i) => {
        const next = i + 1 < frames.length ? frames[i + 1].t : tEnd;
        lines.push(`file '${f.file}'`, `duration ${Math.max(1 / 60, next - f.t).toFixed(4)}`);
      });
      lines.push(`file '${frames[frames.length - 1].file}'`);
      const list = join(dir, 'list.ffconcat');
      writeFileSync(list, lines.join('\n'));
      mkdirSync(CLIPS_DIR, { recursive: true });
      const out = join(CLIPS_DIR, `${name}.mp4`);
      const r = spawnSync(
        'ffmpeg',
        ['-y', '-loglevel', 'error', '-safe', '0', '-f', 'concat', '-i', list, '-vf', 'fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p', '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-an', out],
        { stdio: 'inherit' },
      );
      if (r.status !== 0) throw new Error(`clip ${name}: ffmpeg failed`);
      const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', out], { encoding: 'utf8' });
      const j = JSON.parse(probe.stdout) as { streams: { width: number; height: number }[]; format: { duration: string } };
      const info: ClipInfo = { duration: Number(j.format.duration), width: j.streams[0].width, height: j.streams[0].height, marks };
      rmSync(dir, { recursive: true, force: true });
      const manifest = existsSync(MANIFEST) ? (JSON.parse(readFileSync(MANIFEST, 'utf8')) as Record<string, ClipInfo>) : {};
      manifest[name] = info;
      writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
      return info;
    },
  };
}

/** Draws an arrow where the mouse is (headless Chromium paints no pointer). Run it again after every navigation. */
export async function installPointer(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (document.getElementById('__video_pointer')) return;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.id = '__video_pointer';
    svg.setAttribute('width', '26');
    svg.setAttribute('height', '30');
    svg.setAttribute('viewBox', '0 0 26 30');
    svg.setAttribute('aria-hidden', 'true');
    Object.assign(svg.style, { position: 'fixed', left: '0', top: '0', zIndex: '2147483647', pointerEvents: 'none', transform: 'translate(-80px,-80px)', filter: 'drop-shadow(0 1px 2px rgba(0,0,0,.35))' });
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', 'M2 2 L2 23 L7.5 17.8 L11.2 26.5 L15 24.9 L11.4 16.4 L19 16.4 Z');
    path.setAttribute('fill', '#1f1f1f');
    path.setAttribute('stroke', '#ffffff');
    path.setAttribute('stroke-width', '1.6');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    document.documentElement.appendChild(svg);
    const move = (e: MouseEvent) => {
      svg.style.transform = `translate(${e.clientX - 2}px,${e.clientY - 2}px)`;
    };
    addEventListener('mousemove', move, true);
    addEventListener('pointermove', move, true);
    addEventListener('pointerdown', move, true);
  });
}

/** Moves the mouse to (x, y) over `ms`, eased, as a hand would. */
export async function glide(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, ms = 600): Promise<void> {
  const steps = Math.max(8, Math.round(ms / 16));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
    await page.mouse.move(from.x + (to.x - from.x) * e, from.y + (to.y - from.y) * e);
    await page.waitForTimeout(ms / steps);
  }
}

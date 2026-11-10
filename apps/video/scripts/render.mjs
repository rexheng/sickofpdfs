// Renders both cuts of the launch video to MP4 from the recorded clips (pnpm record first).
//   node scripts/render.mjs [outDir] [--only=16x9|9x16] [--frames=0-90]
// Uses the Chromium headless shell Playwright installed, so nothing is downloaded. The audio track is silent (no music).
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import { chromium } from '@playwright/test';

const root = fileURLToPath(new URL('../', import.meta.url));
const publicDir = join(root, 'public');
const args = process.argv.slice(2);
const outDir = args.find((a) => !a.startsWith('--')) ?? join(root, 'out');
const only = args.find((a) => a.startsWith('--only='))?.slice(7);
const frames = args.find((a) => a.startsWith('--frames='))?.slice(9).split('-').map(Number);
mkdirSync(outDir, { recursive: true });

const manifestPath = join(publicDir, 'clips', 'manifest.json');
if (!existsSync(manifestPath)) throw new Error('no recordings: run "pnpm record" first');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
// The sponsor's logo, unaltered, from the site.
copyFileSync(join(root, '../site/public/elevenlabs-logo-black.svg'), join(publicDir, 'elevenlabs-logo-black.svg'));

const shell = chromium.executablePath().replace(/chromium-(\d+)\/chrome-linux64\/chrome$/, 'chromium_headless_shell-$1/chrome-headless-shell-linux64/chrome-headless-shell');
const browserExecutable = existsSync(shell) ? shell : undefined;

const serveUrl = await bundle({ entryPoint: join(root, 'src/index.ts'), publicDir });
for (const cut of ['16x9', '9x16']) {
  if (only && only !== cut) continue;
  const inputProps = { manifest, vertical: cut === '9x16' };
  const composition = await selectComposition({ serveUrl, id: `launch-${cut}`, inputProps, browserExecutable });
  const outputLocation = join(outDir, `sickofpdfs-launch-${cut}.mp4`);
  await renderMedia({
    composition,
    serveUrl,
    codec: 'h264',
    crf: 18,
    outputLocation,
    inputProps,
    browserExecutable,
    enforceAudioTrack: true,
    concurrency: 1,
    offthreadVideoCacheSizeInBytes: 256 * 1024 * 1024,
    ...(frames ? { frameRange: [frames[0], frames[1]] } : {}),
    onProgress: ({ progress }) => process.stdout.write(`\r${cut}: ${Math.round(progress * 100)}%   `),
  });
  console.log(`\n${outputLocation} (${composition.durationInFrames / composition.fps} s)`);
}

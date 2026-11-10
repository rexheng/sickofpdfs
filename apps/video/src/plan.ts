// The video's running order: which recorded clip plays when, which part of it, how fast, and the caption over it. Times inside a
// clip are taken from the marks the recorder wrote (record/record.spec.ts), so a new recording keeps its cuts.
export const FPS = 30;

export interface ClipInfo {
  duration: number;
  width: number;
  height: number;
  marks: Record<string, number>;
}
export type Manifest = Record<string, ClipInfo>;

/** One stretch of a clip: from and to in the clip's seconds, played `rate` times as fast. */
export interface Segment {
  from: number;
  to: number;
  rate: number;
}

/** Where the 9:16 cut looks, as the centre x of the frame (0 to 1), from a time in the scene (seconds) on. */
export interface Focus {
  at: number;
  x: number;
}

/** A part of the recording (in its 1920 × 1080 pixels) to show instead of all of it, for each cut. */
export interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Crops {
  wide: Crop;
  tall: Crop;
}

/** A slow push-in on one point of the recording (x, y from 0 to 1), from `from` to `to` seconds into the scene. */
export interface Push {
  from: number;
  to: number;
  x: number;
  y: number;
  scale: number;
}
export interface Pushes {
  wide?: Push;
  tall?: Push;
}

export interface Caption {
  /** Seconds into the scene. */
  at: number;
  text: string;
}

export interface KeyPress {
  /** Seconds into the scene. */
  at: number;
  keys: string[];
}

export interface SideBySide {
  clip: string;
  label: string;
  segments: Segment[];
}

export type Scene =
  | { kind: 'title'; seconds: number }
  | { kind: 'clip'; clip: string; segments: Segment[]; captions: Caption[]; keys: KeyPress[]; focus: Focus[]; crop?: Crops; push?: Pushes; seconds: number }
  | { kind: 'phone'; clip: string; segments: Segment[]; captions: Caption[]; seconds: number }
  /**
   * Two recordings side by side, each under its label (Chrome's own viewer on the left, ours on the right), then from `zoomAt`
   * seconds on, the right one grows to fill the frame (the next scene's footage takes over from it).
   */
  | { kind: 'compare'; left: SideBySide; right: SideBySide; zoomAt: number; seconds: number }
  | { kind: 'end'; seconds: number };

/** Frames that two scenes overlap by (a cross-fade). */
export const OVERLAP = 10;

const segmentsLength = (s: Segment[]): number => s.reduce((n, g) => n + (g.to - g.from) / g.rate, 0);

/** The scene time (seconds) at which clip time `t` plays, given the scene's segments. */
function sceneTimeOf(segments: Segment[], t: number): number {
  let acc = 0;
  for (const g of segments) {
    if (t <= g.to) return acc + Math.max(0, t - g.from) / g.rate;
    acc += (g.to - g.from) / g.rate;
  }
  return acc;
}

/** The side-by-side: 2.6 s of both, then 0.8 s of moving in on ours. */
const COMPARE_ZOOM = 0.8;
const COMPARE_SECONDS = 2.6 + COMPARE_ZOOM;

export function buildPlan(m: Manifest): Scene[] {
  const mark = (clip: string, name: string, fallback = 0): number => m[clip]?.marks[name] ?? fallback;
  const dur = (clip: string): number => m[clip]?.duration ?? 1;
  const clipScene = (
    clip: string,
    segments: Segment[],
    captions: { atClip?: number; at?: number; text: string }[],
    keys: { atClip: number; keys: string[] }[],
    focus: { atClip?: number; at?: number; x: number }[],
    crop?: Crops,
    push?: (at: (clipTime: number) => number) => Pushes,
  ): Scene => {
    const t = (c: { atClip?: number; at?: number }) => (c.atClip !== undefined ? sceneTimeOf(segments, c.atClip) : (c.at ?? 0));
    return {
      kind: 'clip',
      clip,
      segments,
      seconds: segmentsLength(segments),
      captions: captions.map((c) => ({ at: t(c), text: c.text })),
      keys: keys.map((k) => ({ at: sceneTimeOf(segments, k.atClip), keys: k.keys })),
      focus: focus.map((f) => ({ at: t(f), x: f.x })),
      ...(crop ? { crop } : {}),
      ...(push ? { push: push((c) => sceneTimeOf(segments, c)) } : {}),
    };
  };

  // The pointer reaches "View PDF" about 0.8 s before the tab leaves arXiv's page; its move starts about 1.6 s before.
  const arxivMove = mark('arxiv', 'opened') - 1.7;
  const marksSel = mark('marks', 'selected');
  const marksH = mark('marks', 'key-h');
  const marksB = mark('marks', 'key-b');
  const commentSel = mark('comment', 'selected');
  const claudeAnswered = mark('claude', 'answered');
  const grab = mark('reorder', 'grab');
  const dragging = mark('reorder', 'dragging');
  const over = mark('reorder', 'over');
  const dropped = mark('reorder', 'dropped');
  const scanRead = mark('scan', 'read');
  const scanSel = mark('scan', 'selected');
  const scanB = mark('scan', 'key-b');

  return [
    { kind: 'title', seconds: 2 },
    clipScene(
      'arxiv',
      // The page, then the pointer's way to "View PDF" and the click, up to the moment the tab leaves the page.
      [
        { from: 0.3, to: arxivMove - 0.4, rate: 1.6 },
        { from: arxivMove - 0.4, to: Math.min(dur('arxiv'), mark('arxiv', 'opened') - 0.1), rate: 1.0 },
      ],
      [{ at: 0, text: 'Open any PDF in Chrome' }],
      [],
      // The abstract first, then the "View PDF" link at the top right.
      [{ at: 0, x: 0.3 }, { atClip: arxivMove, x: 0.8 }],
      undefined,
      // As the pointer goes to "View PDF", the camera moves in on it (the page is small at full width).
      (at) => ({
        wide: { from: at(arxivMove - 0.3), to: at(arxivMove + 0.9), x: 0.88, y: 0.11, scale: 1.9 },
        tall: { from: at(arxivMove - 0.3), to: at(arxivMove + 0.9), x: 0.88, y: 0.11, scale: 1.35 },
      }),
    ),
    // The same paper, the moment it opens: Chrome's own viewer, and ours, each from its first frame with the paper on screen.
    {
      kind: 'compare',
      left: { clip: 'side-chrome', label: 'Chrome’s own viewer', segments: [{ from: Math.max(0, mark('side-chrome', 'shown') - 0.1), to: mark('side-chrome', 'shown') - 0.1 + COMPARE_SECONDS, rate: 1 }] },
      right: { clip: 'side-ours', label: 'sickofpdfs', segments: [{ from: Math.max(0, mark('side-ours', 'shown') - 0.1), to: mark('side-ours', 'shown') - 0.1 + COMPARE_SECONDS, rate: 1 }] },
      zoomAt: COMPARE_SECONDS - COMPARE_ZOOM,
      seconds: COMPARE_SECONDS,
    },
    clipScene(
      'marks',
      [
        { from: marksSel - 2.6, to: marksH + 1.0, rate: 1.7 },
        { from: marksB - 2.6, to: Math.min(dur('marks'), marksB + 1.5), rate: 1.7 },
      ],
      [{ at: 0, text: 'Select, then press H' }, { atClip: marksB - 2.6, text: 'Ctrl+B makes it bold' }],
      [
        { atClip: marksH, keys: ['H'] },
        { atClip: marksB, keys: ['Ctrl', 'B'] },
      ],
      [{ at: 0, x: 0.47 }],
    ),
    clipScene(
      'comment',
      [{ from: commentSel - 0.8, to: Math.min(dur('comment'), mark('comment', 'posted') + 1.2), rate: 2.4 }],
      [{ at: 0, text: 'Write a comment' }],
      [],
      [{ at: 0, x: 0.5 }, { atClip: mark('comment', 'box'), x: 0.8 }],
    ),
    clipScene(
      'claude',
      [{ from: Math.max(0, mark('claude', 'typing') - 0.3), to: Math.min(dur('claude'), claudeAnswered + 1.5), rate: 2.2 }],
      [{ at: 0, text: 'Ask @Claude about it' }],
      [],
      [{ at: 0, x: 0.84 }],
    ),
    // The whole drag, then the page in its new place for a beat. The recorder takes the drag in small steps, one frame each
    // (slow on a busy machine), so that part is sped up to an easy 1.8 s.
    clipScene(
      'reorder',
      [
        { from: Math.max(0, grab - 0.6), to: dragging, rate: 1.2 },
        { from: dragging, to: over, rate: Math.max(1, (over - dragging) / 1.8) },
        { from: over, to: dropped + 0.2, rate: Math.max(1, (dropped + 0.2 - over) / 0.6) },
        { from: dropped + 0.2, to: Math.min(dur('reorder'), dropped + 2.2), rate: 1.0 },
      ],
      [{ at: 0, text: 'Drag pages into order' }],
      [],
      [{ at: 0, x: 0.28 }],
      undefined,
      // In 16:9 the thumbnails are small: move in on them as the drag begins.
      (at) => ({ wide: { from: at(grab - 0.4), to: at(dragging), x: 0, y: 0.32, scale: 1.6 } }),
    ),
    clipScene(
      'library',
      [
        { from: 0.2, to: mark('library', 'courses') + 1.4, rate: 1.0 },
        { from: mark('library', 'courses') + 1.4, to: dur('library'), rate: 2.0 },
      ],
      [{ at: 0, text: 'Automatically save your pdfs to a reading list and library' }, { atClip: mark('library', 'courses') + 1.3, text: 'Grouped by course' }],
      [],
      [{ at: 0, x: 0.27 }],
    ),
    clipScene(
      'scan',
      [
        // The "Reading text" chip as the scan opens, then the page of running text once it is read.
        { from: mark('scan', 'opened'), to: mark('scan', 'opened') + 2.4, rate: 1.4 },
        { from: scanRead - 0.3, to: scanRead + 1.0, rate: 1.3 },
        { from: scanSel - 2.2, to: Math.min(dur('scan'), scanB + 1.6), rate: 1.9 },
      ],
      [{ at: 0, text: 'Scans are read on your computer' }, { atClip: scanSel - 2.2, text: 'Then mark them like text' }],
      [{ atClip: scanB, keys: ['Ctrl', 'B'] }],
      [{ at: 0, x: 0.5 }],
    ),
    {
      kind: 'phone',
      clip: 'phone',
      segments: [{ from: 0.3, to: dur('phone'), rate: 2.0 }],
      captions: [{ at: 0, text: 'The Android app is coming' }],
      seconds: (dur('phone') - 0.3) / 2.0,
    },
    // The site is one narrow column at the top left: show that part, larger.
    clipScene('site', [{ from: 0.2, to: dur('site'), rate: 2.0 }], [{ at: 0, text: 'Join the cloud sync waitlist' }], [], [], {
      wide: { x: 0, y: 0, w: 1280, h: 720 },
      tall: { x: 0, y: 0, w: 1160, h: 640 },
    }),
    // Long enough to scan the QR code with a phone.
    { kind: 'end', seconds: 6 },
  ];
}

export const sceneFrames = (s: Scene): number => Math.round(s.seconds * FPS);

/** The scenes' start frames, and the whole length (scenes overlap by OVERLAP frames). */
export function timeline(plan: Scene[]): { starts: number[]; total: number } {
  const starts: number[] = [];
  let at = 0;
  for (const s of plan) {
    starts.push(at);
    at += sceneFrames(s) - OVERLAP;
  }
  return { starts, total: at + OVERLAP };
}

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

export type Scene =
  | { kind: 'title'; seconds: number }
  | { kind: 'clip'; clip: string; segments: Segment[]; captions: Caption[]; keys: KeyPress[]; focus: Focus[]; crop?: Crops; seconds: number }
  | { kind: 'phone'; clip: string; segments: Segment[]; captions: Caption[]; seconds: number }
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
    };
  };

  const marksSel = mark('marks', 'selected');
  const marksH = mark('marks', 'key-h');
  const marksB = mark('marks', 'key-b');
  const commentSel = mark('comment', 'selected');
  const claudeAnswered = mark('claude', 'answered');
  const grab = mark('reorder', 'grab');
  const dropped = mark('reorder', 'dropped');
  const scanRead = mark('scan', 'read');
  const scanSel = mark('scan', 'selected');
  const scanB = mark('scan', 'key-b');

  return [
    { kind: 'title', seconds: 2 },
    clipScene(
      'takeover',
      [{ from: 0.6, to: Math.min(dur('takeover'), mark('takeover', 'opened') + 2.0), rate: 1.4 }],
      [{ at: 0, text: 'Open any PDF in Chrome' }, { atClip: mark('takeover', 'opened') + 0.3, text: 'It opens here instead' }],
      [],
      [{ at: 0, x: 0.3 }, { atClip: mark('takeover', 'opened'), x: 0.5 }],
    ),
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
    clipScene(
      'reorder',
      [{ from: Math.max(0, grab - 0.8), to: Math.min(dur('reorder'), dropped + 1.4), rate: 2.6 }],
      [{ at: 0, text: 'Drag pages into order' }],
      [],
      [{ at: 0, x: 0.28 }],
    ),
    clipScene(
      'library',
      [
        { from: 0.2, to: mark('library', 'courses') + 1.4, rate: 1.0 },
        { from: mark('library', 'courses') + 1.4, to: dur('library'), rate: 2.0 },
      ],
      [{ at: 0, text: 'Every saved PDF, in one library' }, { atClip: mark('library', 'courses') + 1.3, text: 'Grouped by course' }],
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
    { kind: 'end', seconds: 3.6 },
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

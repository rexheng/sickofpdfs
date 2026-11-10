// The launch video: real recordings of the extension, the phone app and the site, in a calm, Drive-like frame. One component
// draws both cuts; `vertical` lays it out for phones (1080 × 1920).
import type { CSSProperties, ReactNode } from 'react';
import { AbsoluteFill, Easing, Img, interpolate, OffthreadVideo, Sequence, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { buildPlan, FPS, OVERLAP, sceneFrames, timeline, type Caption, type Crop, type Focus, type KeyPress, type Manifest, type Push, type Scene, type Segment } from './plan';

export interface LaunchProps {
  manifest: Manifest;
  vertical: boolean;
  [key: string]: unknown;
}

export const SITE_ADDRESS = 'sickofpdfs-site.rexheng-policy.workers.dev';

const C = {
  bg: '#f8fafd',
  ink: '#1f1f1f',
  muted: '#5f6368',
  blue: '#0b57d0',
  card: '#ffffff',
  line: '#dde3ea',
};
const FONT = 'Inter, Roboto, "Segoe UI", system-ui, sans-serif';

/** 0 → 1 over the first `OVERLAP` frames and 1 → 0 over the last (the cross-fade between scenes). */
function useFade(length: number): number {
  const f = useCurrentFrame();
  return interpolate(f, [0, OVERLAP, length - OVERLAP, length], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
}

/** The caption on screen now: each one fades and rises in when its time comes. */
function Captions({ captions, vertical }: { captions: Caption[]; vertical: boolean }) {
  const f = useCurrentFrame();
  const t = f / FPS;
  const i = captions.reduce((n, c, k) => (c.at <= t ? k : n), 0);
  const c = captions[i];
  const since = f - Math.round(c.at * FPS);
  const p = interpolate(since, [0, 9], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) });
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        top: vertical ? 210 : 34,
        textAlign: 'center',
        fontFamily: FONT,
        fontWeight: 500,
        fontSize: vertical ? 64 : 50,
        lineHeight: 1.2,
        letterSpacing: '-0.01em',
        color: C.ink,
        padding: '0 70px',
        opacity: p,
        transform: `translateY(${(1 - p) * 14}px)`,
      }}
    >
      {c.text}
    </div>
  );
}

/** A keyboard badge (H, Ctrl + B) that pops up when the key is pressed in the footage. */
function Keys({ keys, vertical }: { keys: KeyPress[]; vertical: boolean }) {
  const f = useCurrentFrame();
  return (
    <>
      {keys.map((k, n) => {
        const since = f - Math.round(k.at * FPS);
        if (since < -3 || since > 40) return null;
        const o = interpolate(since, [-3, 3, 30, 40], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
        const s = interpolate(since, [-3, 4], [0.85, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.back(2)) });
        return (
          <div
            key={n}
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: vertical ? 250 : 64,
              display: 'flex',
              justifyContent: 'center',
              gap: 14,
              opacity: o,
              transform: `scale(${s})`,
            }}
          >
            {k.keys.map((key, j) => (
              <span key={j} style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                {j > 0 && <span style={{ fontFamily: FONT, fontSize: 40, color: C.muted }}>+</span>}
                <span
                  style={{
                    minWidth: 76,
                    padding: '14px 24px',
                    borderRadius: 16,
                    background: C.card,
                    border: `2px solid ${C.line}`,
                    boxShadow: '0 3px 0 #c4cbd3, 0 8px 22px rgba(60,64,67,.18)',
                    fontFamily: FONT,
                    fontWeight: 600,
                    fontSize: 42,
                    color: C.ink,
                    textAlign: 'center',
                  }}
                >
                  {key}
                </span>
              </span>
            ))}
          </div>
        );
      })}
    </>
  );
}

/** The clip's segments, one after another, each at its own speed. */
function Footage({ clip, segments, style }: { clip: string; segments: Segment[]; style?: CSSProperties }) {
  let at = 0;
  return (
    <>
      {segments.map((g, i) => {
        const length = Math.round(((g.to - g.from) / g.rate) * FPS);
        const from = at;
        at += length;
        const last = i === segments.length - 1;
        return (
          // Each segment but the last holds over into the next by a frame, so no blank frame shows between them.
          <Sequence key={i} from={from} durationInFrames={last ? length + 1 : length + 1} layout="none">
            <OffthreadVideo src={staticFile(`clips/${clip}.mp4`)} startFrom={Math.round(g.from * FPS)} playbackRate={g.rate} muted style={style} />
          </Sequence>
        );
      })}
    </>
  );
}

/** Part of the recording, scaled so the crop is `width` px wide. */
function Cropped({ crop, width, clip, segments }: { crop: Crop; width: number; clip: string; segments: Segment[] }) {
  const k = width / crop.w;
  return (
    <div style={{ position: 'absolute', left: -crop.x * k, top: -crop.y * k, width: 1920 * k, height: 1080 * k }}>
      <Footage clip={clip} segments={segments} style={{ width: '100%', height: '100%' }} />
    </div>
  );
}

/** The frame's centre x (0 to 1) for the 9:16 cut now, eased between focus points. */
function focusAt(focus: Focus[], t: number): number {
  if (focus.length === 0) return 0.5;
  let x = focus[0].x;
  for (let i = 1; i < focus.length; i++) {
    const f = focus[i];
    const p = interpolate(t, [f.at - 0.35, f.at + 0.35], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.inOut(Easing.cubic) });
    x = x + (f.x - x) * p;
  }
  return x;
}

/** The push-in's scale now (1 before it starts). */
function pushAt(push: Push | undefined, t: number): number {
  if (!push) return 1;
  return interpolate(t, [push.from, push.to], [1, push.scale], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.inOut(Easing.cubic) });
}

/** A recording of the browser window, in a soft card (16:9) or a tall crop that follows the action (9:16). */
function ClipScene({ scene, vertical }: { scene: Extract<Scene, { kind: 'clip' }>; vertical: boolean }) {
  const f = useCurrentFrame();
  const length = sceneFrames(scene);
  const fade = useFade(length);
  const zoom = interpolate(f, [0, length], [1, 1.025]);
  const wide = scene.push?.wide;
  const tallPush = scene.push?.tall;
  if (!vertical) {
    const w = 1600;
    const h = 900;
    return (
      <AbsoluteFill style={{ opacity: fade }}>
        <Captions captions={scene.captions} vertical={false} />
        <div
          style={{
            position: 'absolute',
            left: (1920 - w) / 2,
            top: 118,
            width: w,
            height: h,
            borderRadius: 18,
            overflow: 'hidden',
            background: '#202124',
            boxShadow: '0 1px 3px rgba(60,64,67,.25), 0 12px 40px rgba(60,64,67,.18)',
          }}
        >
          <div
            style={{
              width: '100%',
              height: '100%',
              transform: `scale(${zoom * pushAt(wide, f / FPS)})`,
              transformOrigin: wide ? `${wide.x * 100}% ${wide.y * 100}%` : '50% 40%',
            }}
          >
            {scene.crop ? (
              <Cropped crop={scene.crop.wide} width={w} clip={scene.clip} segments={scene.segments} />
            ) : (
              <Footage clip={scene.clip} segments={scene.segments} style={{ width: '100%', height: '100%' }} />
            )}
          </div>
        </div>
        <Keys keys={scene.keys} vertical={false} />
      </AbsoluteFill>
    );
  }
  // 9:16: a window 960 wide and 1200 tall, showing 864 × 1080 of the 1920 × 1080 recording around the focus (or the scene's crop).
  const cardW = 960;
  const tall = scene.crop?.tall;
  const cardH = tall ? Math.round((cardW * tall.h) / tall.w) : 1200;
  const srcW = 864;
  const k = cardW / srcW;
  const cx = focusAt(scene.focus, f / FPS) * 1920;
  const left = Math.min(0, Math.max(-(1920 - srcW), -(cx - srcW / 2)));
  return (
    <AbsoluteFill style={{ opacity: fade }}>
      <Captions captions={scene.captions} vertical />
      <div
        style={{
          position: 'absolute',
          left: (1080 - cardW) / 2,
          top: 400,
          width: cardW,
          height: cardH,
          borderRadius: 28,
          overflow: 'hidden',
          background: '#202124',
          boxShadow: '0 1px 3px rgba(60,64,67,.25), 0 16px 48px rgba(60,64,67,.2)',
        }}
      >
        {tall ? (
          <div style={{ width: '100%', height: '100%', transform: `scale(${zoom})`, transformOrigin: '30% 30%' }}>
            <Cropped crop={tall} width={cardW} clip={scene.clip} segments={scene.segments} />
          </div>
        ) : (
          <div
            style={{
              position: 'absolute',
              left: left * k,
              top: 0,
              width: 1920 * k,
              height: 1080 * k,
              transform: `scale(${zoom * pushAt(tallPush, f / FPS)})`,
              transformOrigin: `${(((tallPush ? tallPush.x * 1920 : cx) / 1920) * 100).toFixed(1)}% ${tallPush ? tallPush.y * 100 : 45}%`,
            }}
          >
            <Footage clip={scene.clip} segments={scene.segments} style={{ width: '100%', height: '100%' }} />
          </div>
        )}
      </div>
      <Keys keys={scene.keys} vertical />
    </AbsoluteFill>
  );
}

/** The phone app, in a plain phone outline. */
function PhoneScene({ scene, vertical }: { scene: Extract<Scene, { kind: 'phone' }>; vertical: boolean }) {
  const length = sceneFrames(scene);
  const fade = useFade(length);
  const h = vertical ? 1280 : 820;
  const w = Math.round((h * 1082) / 2202);
  return (
    <AbsoluteFill style={{ opacity: fade }}>
      <Captions captions={scene.captions} vertical={vertical} />
      <div
        style={{
          position: 'absolute',
          left: (vertical ? 1080 : 1920) / 2 - w / 2 - 14,
          top: vertical ? 420 : 150,
          padding: 14,
          borderRadius: 54,
          background: '#1f1f1f',
          boxShadow: '0 16px 48px rgba(60,64,67,.25)',
        }}
      >
        <div style={{ width: w, height: h, borderRadius: 42, overflow: 'hidden', background: '#202124' }}>
          <Footage clip={scene.clip} segments={scene.segments} style={{ width: '100%', height: '100%' }} />
        </div>
      </div>
    </AbsoluteFill>
  );
}

/** A box on the canvas, in px. */
interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}
const mix = (a: Box, b: Box, p: number): Box => ({
  left: a.left + (b.left - a.left) * p,
  top: a.top + (b.top - a.top) * p,
  width: a.width + (b.width - a.width) * p,
  height: a.height + (b.height - a.height) * p,
});

/**
 * Chrome's own viewer and ours, side by side (one above the other in 9:16), each under its label. Then the camera moves in on
 * ours: its card grows to where the next scene's card sits, and the next scene fades in over it.
 */
function CompareScene({ scene, vertical }: { scene: Extract<Scene, { kind: 'compare' }>; vertical: boolean }) {
  const f = useCurrentFrame();
  const length = sceneFrames(scene);
  const fade = useFade(length);
  const z = interpolate(f, [scene.zoomAt * FPS, length], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.inOut(Easing.cubic) });
  // Where each card sits, and (for ours) where the next scene's card is: the zoom ends there.
  const left: Box = vertical ? { left: 70, top: 140, width: 940, height: 760 } : { left: 48, top: 128, width: 888, height: 908 };
  const right: Box = vertical ? { left: 70, top: 1040, width: 940, height: 760 } : { left: 984, top: 128, width: 888, height: 908 };
  // 16:9: ours moves to the middle at the next card's height, where the next scene's page sits at nearly the same size.
  const target: Box = vertical ? { left: 60, top: 400, width: 960, height: 1200 } : { left: 520, top: 118, width: 880, height: 900 };
  const ours = mix(right, target, z);
  const card = (b: Box, extra: CSSProperties = {}): CSSProperties => ({
    position: 'absolute',
    ...b,
    borderRadius: vertical ? 28 : 18,
    overflow: 'hidden',
    background: '#202124',
    boxShadow: '0 1px 3px rgba(60,64,67,.25), 0 12px 40px rgba(60,64,67,.18)',
    ...extra,
  });
  const label = (text: string, b: Box): ReactNode => (
    <div
      style={{
        position: 'absolute',
        left: b.left,
        width: b.width,
        top: vertical ? b.top - 84 : 40,
        textAlign: 'center',
        fontFamily: FONT,
        fontWeight: 500,
        fontSize: vertical ? 54 : 46,
        letterSpacing: '-0.01em',
        color: C.ink,
        opacity: 1 - z * 1.6,
      }}
    >
      {text}
    </div>
  );
  // The recordings keep their shape: each fills its card, from the top (the toolbar and the paper's first page).
  const fill: CSSProperties = { width: '100%', height: '100%', objectFit: 'cover', objectPosition: '50% 0%' };
  return (
    <AbsoluteFill style={{ opacity: fade }}>
      {label(scene.left.label, left)}
      {label(scene.right.label, right)}
      <div style={card(left, { opacity: 1 - z, transform: `translate${vertical ? 'Y' : 'X'}(${-z * 120}px)` })}>
        <Footage clip={scene.left.clip} segments={scene.left.segments} style={fill} />
      </div>
      <div style={card(ours)}>
        <Footage clip={scene.right.clip} segments={scene.right.segments} style={fill} />
      </div>
    </AbsoluteFill>
  );
}

function Wordmark({ size }: { size: number }) {
  return (
    <div style={{ fontFamily: FONT, fontWeight: 600, fontSize: size, letterSpacing: '-0.03em', color: C.ink }}>
      sickof<span style={{ color: C.blue }}>pdfs</span>
    </div>
  );
}

function TitleScene({ scene, vertical }: { scene: Scene; vertical: boolean }) {
  const f = useCurrentFrame();
  const length = sceneFrames(scene);
  const out = interpolate(f, [length - OVERLAP, length], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const p = interpolate(f, [0, 14], [0, 1], { extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) });
  const q = interpolate(f, [8, 22], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) });
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', opacity: out }}>
      <div style={{ opacity: p, transform: `translateY(${(1 - p) * 16}px)` }}>
        <Wordmark size={vertical ? 132 : 140} />
      </div>
      <div style={{ marginTop: 18, fontFamily: FONT, fontSize: vertical ? 50 : 46, color: C.muted, opacity: q, textAlign: 'center', padding: '0 60px' }}>
        cus all pdf readers now kinda suck
      </div>
    </AbsoluteFill>
  );
}

/** What the end card says about the sponsor (R112): the owner's ElevenReader offer, with the QR code that opens it. */
export const PARTNER_LINE = 'Partnered with ElevenReader';
export const QR_LINE = 'Scan this QR code to get 1 free year';

function EndScene({ vertical }: { vertical: boolean }) {
  const f = useCurrentFrame();
  const p = interpolate(f, [0, 16], [0, 1], { extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) });
  const q = interpolate(f, [10, 26], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) });
  // The QR code is drawn large and sharp (its modules stay square), on white with its own quiet zone, so a phone can read it
  // off another screen: 440 px of 1080 in 16:9, 620 px of 1080 wide in 9:16.
  const qrSize = vertical ? 620 : 440;
  const qr = (
    <div style={{ background: '#ffffff', borderRadius: 24, padding: 10, boxShadow: '0 1px 3px rgba(60,64,67,.2), 0 10px 32px rgba(60,64,67,.14)' }}>
      <Img src={staticFile('elevenreader-qr.png')} style={{ display: 'block', width: qrSize, height: qrSize, imageRendering: 'pixelated' }} />
    </div>
  );
  // The sponsor's logo, from apps/site/public, as it is: only its height is set, so it keeps its own shape and colour.
  const logo = <Img src={staticFile('elevenlabs-logo-black.svg')} style={{ height: vertical ? 52 : 46, width: 'auto' }} />;
  const partner = <div style={{ fontFamily: FONT, fontWeight: 500, fontSize: vertical ? 46 : 42, color: C.ink }}>{PARTNER_LINE}</div>;
  const scan = <div style={{ fontFamily: FONT, fontSize: vertical ? 40 : 36, color: C.muted, lineHeight: 1.3 }}>{QR_LINE}</div>;
  if (vertical) {
    return (
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', opacity: p }}>
        <Wordmark size={124} />
        <div style={{ marginTop: 18, fontFamily: FONT, fontSize: 36, color: C.blue }}>{SITE_ADDRESS}</div>
        <div style={{ marginTop: 110, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 26, opacity: q }}>
          {partner}
          {logo}
          <div style={{ marginTop: 18 }}>{qr}</div>
          <div style={{ marginTop: 8 }}>{scan}</div>
        </div>
      </AbsoluteFill>
    );
  }
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', opacity: p }}>
      <Wordmark size={120} />
      <div style={{ marginTop: 16, fontFamily: FONT, fontSize: 38, color: C.blue }}>{SITE_ADDRESS}</div>
      <div style={{ marginTop: 64, display: 'flex', alignItems: 'center', gap: 64, opacity: q }}>
        {qr}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 28, whiteSpace: 'nowrap' }}>
          {partner}
          {logo}
          {scan}
        </div>
      </div>
    </AbsoluteFill>
  );
}

function SceneView({ scene, vertical }: { scene: Scene; vertical: boolean }): ReactNode {
  switch (scene.kind) {
    case 'title':
      return <TitleScene scene={scene} vertical={vertical} />;
    case 'clip':
      return <ClipScene scene={scene} vertical={vertical} />;
    case 'phone':
      return <PhoneScene scene={scene} vertical={vertical} />;
    case 'compare':
      return <CompareScene scene={scene} vertical={vertical} />;
    case 'end':
      return <EndScene vertical={vertical} />;
  }
}

export function Launch({ manifest, vertical }: LaunchProps) {
  const { durationInFrames } = useVideoConfig();
  const plan = buildPlan(manifest);
  const { starts } = timeline(plan);
  return (
    <AbsoluteFill style={{ background: C.bg }}>
      {plan.map((scene, i) => (
        <Sequence key={i} from={starts[i]} durationInFrames={i === plan.length - 1 ? durationInFrames - starts[i] : sceneFrames(scene)}>
          <SceneView scene={scene} vertical={vertical} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
}

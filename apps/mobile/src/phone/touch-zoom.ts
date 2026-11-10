// Pinch and double-tap zoom on the pages. The viewer already zooms smoothly for Chrome's trackpad pinch, which Chrome sends as
// Ctrl+wheel events (packages/viewer/src/react/PageList.tsx: anchored under the fingers, full renders held until the gesture
// settles). A touch pinch is turned into the same events, once a frame, so the phone uses exactly the desktop's zoom maths.
// One finger keeps the WebView's own scrolling, with its fling.
import { readRuntime } from '@ext/viewer/runtime';

/** PageList's wheel zoom: scale · exp(−deltaY / 400) (packages/viewer/src/layout/zoom.ts). */
const WHEEL_PX_PER_E = 400;
/** Two taps this close in time and place are a double tap. */
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_PX = 32;
/** A tap moves less than this and lasts less than TAP_MS. */
const TAP_SLOP_PX = 10;
const TAP_MS = 250;
/** A double tap on a page that fits its width zooms in this much, under the finger. */
const DOUBLE_TAP_ZOOM = 2.5;

const pagesEl = (): HTMLElement | null => document.querySelector<HTMLElement>('[role="document"]');

/** Zooms by `factor`, keeping the page point under (x, y) where it is. */
function zoomBy(factor: number, x: number, y: number): void {
  if (!Number.isFinite(factor) || factor <= 0 || Math.abs(factor - 1) < 1e-4) return;
  window.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -Math.log(factor) * WHEEL_PX_PER_E, deltaMode: 0, clientX: x, clientY: y, cancelable: true, bubbles: true }));
}

/** Back to fit width (the viewer's Ctrl+0). */
function fitWidth(): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: '0', code: 'Digit0', ctrlKey: true, bubbles: true, cancelable: true }));
}

const isFitWidth = (): boolean => readRuntime().viewer?.snapshot().zoom.kind === 'fit-width';

/** Starts the gestures for this page. Touches on buttons, links, fields and the chrome around the pages are left alone. */
export function installTouchZoom(): void {
  let pinch: { dist: number; x: number; y: number } | null = null;
  /** The zoom and pan still to apply at the next frame. */
  let pending = { factor: 1, dx: 0, dy: 0, x: 0, y: 0 };
  let frame = 0;
  let tap: { x: number; y: number; t: number; moved: boolean } | null = null;
  let lastTap: { x: number; y: number; t: number } | null = null;

  const onPages = (e: TouchEvent): boolean => {
    const pages = pagesEl();
    const t = e.target;
    if (pages === null || !(t instanceof Node) || !pages.contains(t)) return false;
    return !(t instanceof Element && t.closest('a, button, input, textarea, [role="button"], [contenteditable="true"]'));
  };

  const flush = () => {
    frame = 0;
    const { factor, dx, dy, x, y } = pending;
    pending = { factor: 1, dx: 0, dy: 0, x, y };
    zoomBy(factor, x, y);
    const pages = pagesEl();
    if (pages !== null && (dx !== 0 || dy !== 0)) {
      pages.scrollLeft -= dx;
      pages.scrollTop -= dy;
    }
  };

  const geometry = (e: TouchEvent) => {
    const [a, b] = [e.touches[0], e.touches[1]];
    return { dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
  };

  document.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length === 2 && onPages(e)) {
        pinch = geometry(e);
        tap = null;
        return;
      }
      if (e.touches.length === 1 && onPages(e)) {
        const t = e.touches[0];
        tap = { x: t.clientX, y: t.clientY, t: performance.now(), moved: false };
      } else {
        tap = null;
      }
    },
    { passive: true },
  );

  document.addEventListener(
    'touchmove',
    (e) => {
      if (pinch !== null && e.touches.length === 2) {
        if (e.cancelable) e.preventDefault(); // the pinch is ours: no scrolling under it
        const now = geometry(e);
        pending.factor *= now.dist / pinch.dist;
        pending.dx += now.x - pinch.x;
        pending.dy += now.y - pinch.y;
        pending.x = now.x;
        pending.y = now.y;
        pinch = now;
        frame ||= requestAnimationFrame(flush);
        return;
      }
      if (tap !== null) {
        const t = e.touches[0];
        if (Math.hypot(t.clientX - tap.x, t.clientY - tap.y) > TAP_SLOP_PX) tap.moved = true;
      }
    },
    { passive: false },
  );

  document.addEventListener(
    'touchend',
    (e) => {
      if (pinch !== null && e.touches.length < 2) pinch = null;
      if (tap === null || e.touches.length > 0) return;
      const was = tap;
      tap = null;
      const now = performance.now();
      if (was.moved || now - was.t > TAP_MS) {
        lastTap = null;
        return;
      }
      if (lastTap !== null && now - lastTap.t < DOUBLE_TAP_MS && Math.hypot(was.x - lastTap.x, was.y - lastTap.y) < DOUBLE_TAP_PX) {
        lastTap = null;
        if (e.cancelable) e.preventDefault(); // no click, no word selected
        if (isFitWidth()) zoomBy(DOUBLE_TAP_ZOOM, was.x, was.y);
        else fitWidth();
        return;
      }
      lastTap = { x: was.x, y: was.y, t: now };
    },
    { passive: false },
  );
}

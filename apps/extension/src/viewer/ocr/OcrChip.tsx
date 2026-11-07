// The scan's reading, in the header (Phase 7.5): a quiet chip at the right, before the library status chip, while the text of a
// scanned PDF is being read. No border and no fill, in the header's muted text colour, with a small ring that fills as pages are
// read (Drive's upload progress ring), so it is easy to ignore. It never covers the page and never opens anything on its own.
// Its hover says what it is (use-ocr.ts). A click opens a small card: how far it is, that it runs on this computer only, where the
// text is kept, and Pause or Resume. When every page is read it says "Text ready" once, then goes.
// While the menus are hidden it sits in the toolbar pill, as its state alone ("Reading text"); the count is in its hover.
import { Icon, Popover, Tooltip } from '@sop/ui';
import { type ComponentPropsWithRef, useState } from 'react';
import { type OcrChipLook, useOcrChip } from './use-ocr';
import type { ViewerOcr } from './wire';
import styles from './OcrChip.module.css';

export interface OcrChipProps {
  ocr: ViewerOcr | null;
  /** In the toolbar pill (the menus are hidden): the state only. */
  compact?: boolean;
}

export function OcrChip({ ocr, compact = false }: OcrChipProps) {
  const look = useOcrChip(ocr);
  const [open, setOpen] = useState(false);
  // A screen reader hears the start and the end, not every page in between (the chip's own words are not a live region).
  const said = look === null ? '' : look.kind === 'done' ? 'Text ready on this scan' : look.kind === 'starting' ? 'Reading text on this scan' : '';
  const chip =
    ocr === null || look === null ? null : (
      <Popover
        open={open && look.kind !== 'done'}
        onOpenChange={setOpen}
        title={look.kind === 'paused' ? 'Reading paused' : 'Reading text on this scan'}
        trigger={<IndicatorButton look={look} compact={compact} />}
        actions={
          look.kind === 'paused'
            ? [{ label: 'Resume', primary: true, onClick: () => (ocr.resume(), setOpen(false)) }]
            : look.kind === 'done'
              ? []
              : [{ label: 'Pause', onClick: () => (ocr.pause(), setOpen(false)) }]
        }
      >
        <CardBody look={look} />
      </Popover>
    );
  return (
    <span className={styles.slot} data-compact={compact ? '' : undefined}>
      {chip}
      <span role="status" className={styles.srOnly}>
        {said}
      </span>
    </span>
  );
}

/** The card's lines: how far, where it runs, and where the text is kept. */
function CardBody({ look }: { look: OcrChipLook }) {
  const howFar = look.done > 0 && look.total > 0 ? `${look.done} of ${look.total} pages are ready to select, mark and search.` : 'The first page is on its way.';
  return (
    <>
      <p>
        {howFar}
        {look.pages > 1 ? ' The page you’re on goes first.' : ''} Each page takes a few seconds.
      </p>
      <p>It runs on this computer only. Nothing is sent anywhere.</p>
      <p>
        {look.inTabOnly
          ? 'This PDF isn’t saved, so the text is kept in this tab only. It’s gone when you close the tab.'
          : 'The text is kept with this PDF in your library. Reading goes on if you close the tab.'}
      </p>
    </>
  );
}

type IndicatorButtonProps = Omit<ComponentPropsWithRef<'button'>, 'children'> & { look: OcrChipLook; compact: boolean };

/** The chip itself: the ring (or a tick when done), the state, and the count. Takes the popover trigger's props and ref. */
function IndicatorButton({ look, compact, className, ...rest }: IndicatorButtonProps) {
  const name = `${look.label}${look.detail ?? ''}`;
  return (
    <Tooltip label={look.tooltip}>
      <button
        type="button"
        {...rest}
        className={[styles.chip, className].filter(Boolean).join(' ')}
        data-kind={look.kind}
        aria-label={name}
      >
        {look.kind === 'done' ? <Icon name="check" size={20} className={styles.tick} /> : <Ring progress={look.progress} paused={look.kind === 'paused'} />}
        <span className={styles.label}>
          {look.label}
          {!compact && look.detail !== undefined && <span className={styles.detail}>{look.detail}</span>}
        </span>
      </button>
    </Tooltip>
  );
}

/** Circumference of the ring (r = 7 in a 20 × 20 box). */
const RING_C = 2 * Math.PI * 7;
/** A first page read still shows as a sliver, not as nothing. */
const RING_MIN = 0.04;

/** A 16 px progress ring in a 20 px icon box: the track, and the arc of pages read; an arc that turns while there is no count yet. */
function Ring({ progress, paused }: { progress: number | null; paused: boolean }) {
  const p = progress === null ? 0.25 : Math.max(RING_MIN, progress);
  return (
    <svg className={styles.ring} data-spinning={progress === null ? '' : undefined} data-paused={paused ? '' : undefined} viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
      <circle className={styles.track} cx="10" cy="10" r="7" />
      <circle className={styles.arc} cx="10" cy="10" r="7" strokeDasharray={`${RING_C}`} strokeDashoffset={`${RING_C * (1 - p)}`} />
    </svg>
  );
}

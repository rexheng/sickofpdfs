// What a figure or area note's card shows (Phase 2, S16; research 06 section 4): a 64 px thumbnail drawn on this
// computer, and the label "Figure 3 · Page 5" (ruling R74: pages are "Page N" everywhere, never "p. N"). A pin's card
// says which pin ("Figure 3 · Page 5 · Pin 2") and its thumbnail shows the pin; a part of a figure ("Part of Figure 3 ·
// Page 5") shows its box on the figure. An area note reads "Area · Page 5".
import type { CardFigure } from '@sop/ui';
import { useSyncExternalStore } from 'react';
import type { Resolution, ThreadRow } from '../annotations/boundary';
import type { NotesHost } from '../annotations/wire';
import { figureName, pinNumbers, placedAnchor } from './anchors';
import { thumbKey, thumbnailBlob, type ThumbMark } from './images';
import { controllerOf } from './registry';

/** For the margin's cards: each figure or area note's thumbnail and label (null for other notes). */
export function useFigureCards(host: NotesHost): (t: ThreadRow, r: Resolution | undefined) => CardFigure | null {
  const thumbs = controllerOf(host).thumbnails;
  useSyncExternalStore(thumbs.subscribe, thumbs.version); // a thumbnail that becomes ready draws its card again
  const s = host.session.state();
  const pins = pinNumbers(s.threads, s.placement);
  return (t, r) => {
    const a = placedAnchor(t, r) ?? t.anchor;
    if (a.kind !== 'figure' && a.kind !== 'area') return null;
    const size = host.pages[a.page];
    if (!size) return null;
    const mark: ThumbMark = a.kind === 'figure' && a.sub?.point ? { point: a.sub.point } : a.kind === 'figure' && a.sub?.rect ? { rect: a.sub.rect } : null;
    const thumbnail = thumbs.get(thumbKey(a.page, a.rect, mark), () => thumbnailBlob(host.backend, host.doc, a.page, size, a.rect, mark));
    const pin = pins.get(t.id);
    const name = figureName(a.kind === 'figure' ? a.figure.label : null);
    const label =
      a.kind === 'area'
        ? `Area · Page ${a.page + 1}`
        : a.sub?.rect
          ? `Part of ${name} · Page ${a.page + 1}`
          : `${name} · Page ${a.page + 1}${pin === undefined ? '' : ` · Pin ${pin}`}`;
    return { label, thumbnail };
  };
}

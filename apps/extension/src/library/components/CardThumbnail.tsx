import type { DocumentId } from '@sop/core';
import { PageThumbnail } from '@sop/ui/library';
import { useEffect, useRef, useState } from 'react';
import { useLibrary } from '../app/context';

/** A grid card's first page: asked for once the card comes near the screen, from the thumbnail cache. */
export function CardThumbnail({ id, stored }: { id: DocumentId; stored: boolean }) {
  const { thumbnails } = useLibrary();
  const box = useRef<HTMLSpanElement>(null);
  // undefined while it is being made; null when this reading has no picture
  const [src, setSrc] = useState<string | null | undefined>(stored ? undefined : null);
  useEffect(() => {
    const el = box.current;
    if (!stored || el === null) return;
    let live = true;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        observer.disconnect();
        void thumbnails.get(id).then((url) => live && setSrc(url));
      },
      { rootMargin: '200px' },
    );
    observer.observe(el);
    return () => {
      live = false;
      observer.disconnect();
    };
  }, [id, stored, thumbnails]);
  return (
    <span ref={box} style={{ display: 'block', inlineSize: '100%', blockSize: '100%' }}>
      <PageThumbnail src={src} />
    </span>
  );
}

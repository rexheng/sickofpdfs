import '../tokens/tokens.css';
import { useState } from 'react';
import { FileTypeIcon } from '../icons/FileTypeIcon';
import styles from './PageThumbnail.module.css';

export interface PageThumbnailProps {
  /** The first page as an image link (an object URL); null when there is none; undefined while it is being made. */
  src: string | null | undefined;
}

/**
 * The first page in a grid card's white box: its top part, the full width of the box, as Drive crops its previews.
 * While the picture is being made the box stays plain white; a PDF with no picture shows the PDF tile in its centre.
 */
export function PageThumbnail({ src }: PageThumbnailProps) {
  const [broken, setBroken] = useState<string | null>(null);
  if (src === undefined) return <span className={styles.placeholder} />;
  if (src === null || broken === src) {
    return (
      <span className={styles.placeholder}>
        <FileTypeIcon kind="pdf" size={32} />
      </span>
    );
  }
  return <img className={styles.image} src={src} alt="" draggable={false} decoding="async" onError={() => setBroken(src)} />;
}

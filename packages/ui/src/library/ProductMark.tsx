import '../tokens/tokens.css';
import styles from './ProductMark.module.css';

export interface ProductMarkProps {
  /** The word beside the tile, as Drive writes "Drive" beside its logo. */
  label: string;
}

/**
 * Our mark in Drive's logo slot (spec "Type and icons"): the Material Symbol menu_book, filled and white, on a primary
 * tile, drawn the way the extension icon is, then the product word in Drive's wordmark type (22/48).
 */
export function ProductMark({ label }: ProductMarkProps) {
  return (
    <span className={styles.mark}>
      <span className={styles.tile} aria-hidden="true">
        menu_book
      </span>
      <span className={styles.word}>{label}</span>
    </span>
  );
}

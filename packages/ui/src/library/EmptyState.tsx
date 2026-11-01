import '../tokens/tokens.css';
import type { ReactNode } from 'react';
import type { IconName } from '../icons/names';
import styles from './EmptyState.module.css';

export interface EmptyStateProps {
  icon: IconName;
  title: string;
  /** One or two short sentences. */
  children?: ReactNode;
  /** Buttons under the text. */
  actions?: ReactNode;
}

/**
 * What a page shows when it has nothing to list, in the place of Drive's illustrations (which are Google's own): a
 * large Material Symbol on a round tile, a heading and a line or two of plain words, and the way forward.
 */
export function EmptyState({ icon, title, children, actions }: EmptyStateProps) {
  return (
    <div className={styles.empty}>
      <span className={styles.art} aria-hidden="true">
        {icon}
      </span>
      <h2 className={styles.title}>{title}</h2>
      {children !== undefined && <div className={styles.body}>{children}</div>}
      {actions !== undefined && <div className={styles.actions}>{actions}</div>}
    </div>
  );
}

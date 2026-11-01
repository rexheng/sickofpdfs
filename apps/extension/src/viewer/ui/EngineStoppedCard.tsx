import { Icon, TextButton } from '@sop/ui';
import styles from './cards.module.css';

export interface EngineStoppedCardProps {
  onReload: () => void;
  /** The escape hatch; null when there is no address (a picked file). */
  onOpenInChrome: (() => void) | null;
}

/**
 * The PDF engine stopped (a crash, a hang or no memory) and starting it again did not help. Never a silent blank
 * page: the owner is told plainly, with the way back.
 */
export function EngineStoppedCard({ onReload, onOpenInChrome }: EngineStoppedCardProps) {
  return (
    <div className={styles.stage}>
      <section className={styles.card} role="alert" aria-labelledby="engine-stopped-title">
        <Icon name="error" className={styles.icon} />
        <h1 id="engine-stopped-title" className={styles.title}>
          The PDF viewer stopped
        </h1>
        <p className={styles.body}>Reload the page.</p>
        <div className={styles.actions}>
          {onOpenInChrome !== null && <TextButton label="Open in Chrome's viewer" icon="open_in_new" onClick={onOpenInChrome} />}
          <TextButton label="Reload page" onClick={onReload} />
        </div>
      </section>
    </div>
  );
}

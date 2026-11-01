import { Icon } from '../icons/Icon';
import styles from './Banner.module.css';
import { IconButton } from './IconButton';
import { TextButton } from './TextButton';

export interface BannerProps {
  message: string;
  actions?: { label: string; onClick: () => void }[];
  /** Shows a close button ("Dismiss"). */
  onDismiss?: () => void;
}

/**
 * A quiet notice row (role="status", so screen readers read it without moving focus): an info icon, the message,
 * text-button actions and an optional close button, on surface-container-high with a 12 px radius.
 */
export function Banner({ message, actions = [], onDismiss }: BannerProps) {
  return (
    <div role="status" className={styles.banner}>
      <Icon name="info" size={20} className={styles.icon} />
      <p className={styles.message}>{message}</p>
      {actions.length > 0 && (
        <div className={styles.actions}>
          {actions.map((action) => (
            <TextButton key={action.label} label={action.label} onClick={action.onClick} />
          ))}
        </div>
      )}
      {onDismiss !== undefined && <IconButton icon="close" label="Dismiss" onClick={onDismiss} />}
    </div>
  );
}

import '../tokens/tokens.css';
import { cx } from '../components/classes';
import { Icon } from '../icons/Icon';
import type { IconName } from '../icons/names';
import styles from './NavList.module.css';

export interface NavItem {
  id: string;
  label: string;
  icon: IconName;
  /** Where the link goes (the library uses `#/recent` and so on), so a middle-click opens it in a new tab. */
  href: string;
  /** Items with the same group sit together; groups are 16 px apart (Drive's three groups). */
  group: number;
}

export interface NavListProps {
  items: readonly NavItem[];
  /** The id of the page that is open: its pill is selected. */
  current: string | null;
  /** The accessible name of the navigation landmark. */
  label: string;
}

/**
 * Drive's left navigation (02 section 4.4): 32 px pills 224 px wide, 16 px in from the left, in groups 16 px apart. A
 * 20 px icon at x 32 and the label at x 68 (Google Sans Text 14/20). The selected pill is #c2e7ff with #001d35 text and
 * a filled icon; hover is an 8% state layer.
 */
export function NavList({ items, current, label }: NavListProps) {
  const groups = [...new Set(items.map((i) => i.group))];
  return (
    <nav className={styles.nav} aria-label={label}>
      {groups.map((group) => (
        <ul key={group} className={styles.group}>
          {items
            .filter((i) => i.group === group)
            .map((item) => {
              const selected = item.id === current;
              return (
                <li key={item.id}>
                  <a className={cx(styles.item, selected && styles.selected)} href={item.href} aria-current={selected ? 'page' : undefined}>
                    <Icon name={item.icon} size={20} filled={selected} />
                    <span className={styles.label}>{item.label}</span>
                  </a>
                </li>
              );
            })}
        </ul>
      ))}
    </nav>
  );
}

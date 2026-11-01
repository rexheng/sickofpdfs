import '../tokens/tokens.css';
import { forwardRef } from 'react';
import { IconButton } from '../components/IconButton';
import { Icon } from '../icons/Icon';
import styles from './SearchPill.module.css';

export interface SearchPillProps {
  value: string;
  onChange(this: void, value: string): void;
  /** The placeholder, and the field's accessible name: "Search in library". */
  label: string;
  /** Enter was pressed (not while an input method is composing). */
  onEnter?(this: void): void;
}

/**
 * Drive's search bar (02 section 4.2): a 48 px pill on surface-container-high (#e9eef6) with the search icon at the
 * left and the placeholder in Google Sans Text 16/24. While it has the focus it turns white and lifts (elevation 1).
 * A clear button shows once there is text; Escape clears it too, then leaves the field.
 */
export const SearchPill = forwardRef<HTMLInputElement, SearchPillProps>(function SearchPill({ value, onChange, label, onEnter }, ref) {
  return (
    <div className={styles.pill} role="search">
      <span className={styles.lead}>
        <Icon name="search" size={24} />
      </span>
      <input
        ref={ref}
        className={styles.input}
        type="search"
        value={value}
        placeholder={label}
        aria-label={label}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => onChange(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) onEnter?.();
          if (e.key === 'Escape') {
            e.preventDefault();
            if (value !== '') onChange('');
            else e.currentTarget.blur();
          }
        }}
      />
      {value !== '' && <IconButton className={styles.clear} icon="close" label="Clear search" size={40} onClick={() => onChange('')} />}
    </div>
  );
});

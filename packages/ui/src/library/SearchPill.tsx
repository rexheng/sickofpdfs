import '../tokens/tokens.css';
import { forwardRef } from 'react';
import { Icon } from '../icons/Icon';
import styles from './SearchPill.module.css';

export interface SearchPillProps {
  /** The placeholder, and the field's accessible name: "Search in library". */
  label: string;
  /**
   * Opens the search this bar stands for (the library's Ctrl+K palette, which then lies over the bar). `typed` is a
   * letter typed into the bar, which the search starts with; empty for a click, Enter or Down.
   */
  onOpen(this: void, typed: string): void;
}

/**
 * Drive's search bar (02 section 4.2): a 48 px pill on surface-container-high (#e9eef6) with the search icon at the
 * left and the placeholder in Google Sans Text 16/24. While it has the focus it turns white and lifts (elevation 1).
 *
 * TB5: one search box, as Drive's. The bar is where the search opens: a click, a typed letter, Enter or Down opens the
 * search over it, and the typing goes on there. The bar itself keeps no text. Escape leaves it.
 */
export const SearchPill = forwardRef<HTMLInputElement, SearchPillProps>(function SearchPill({ label, onOpen }, ref) {
  return (
    <div
      className={styles.pill}
      role="search"
      // The press opens the search where the bar is; the bar does not take the focus first.
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        onOpen('');
      }}
    >
      <span className={styles.lead}>
        <Icon name="search" size={24} />
      </span>
      <input
        ref={ref}
        className={styles.input}
        type="search"
        value=""
        placeholder={label}
        aria-label={label}
        aria-haspopup="dialog"
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => onOpen(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter' || e.key === 'ArrowDown') {
            e.preventDefault();
            onOpen('');
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
      />
    </div>
  );
});

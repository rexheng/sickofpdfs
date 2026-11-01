import '../tokens/tokens.css';
import { type ReactNode, type Ref } from 'react';
import styles from './LibraryShell.module.css';

export interface LibraryShellProps {
  /** The logo slot: ProductMark. */
  mark: ReactNode;
  /** The search pill, starting where the content card starts (x 256). */
  search: ReactNode;
  /** Icon buttons at the right of the top bar. */
  topEnd?: ReactNode;
  /** "+ New", above the navigation. */
  newButton: ReactNode;
  /** The navigation: NavList. */
  nav: ReactNode;
  /** The page, inside the white content card. */
  children: ReactNode;
}

/**
 * Drive's signed-in shell (02 section 4.1), light only: a 64 px top bar on #f8fafd with no divider, a 256 px column with
 * "+ New" and the navigation, and the white content card with 16 px corners, 16 px from the right and bottom edges.
 */
export function LibraryShell({ mark, search, topEnd, newButton, nav, children }: LibraryShellProps) {
  return (
    <div className={styles.shell}>
      <header className={styles.top}>
        <div className={styles.brand}>{mark}</div>
        <div className={styles.search}>{search}</div>
        {topEnd !== undefined && <div className={styles.topEnd}>{topEnd}</div>}
      </header>
      <aside className={styles.side}>
        <div className={styles.newSlot}>{newButton}</div>
        {nav}
      </aside>
      <main className={styles.main}>{children}</main>
    </div>
  );
}

export interface ContentCardProps {
  /** The title row and the chips: they stay in place while the body scrolls. */
  header?: ReactNode;
  children: ReactNode;
  /** The scrolling body, for the "load more" sentinel and keyboard scrolling. */
  bodyRef?: Ref<HTMLDivElement>;
}

/** The white content card (02 section 4.1): radius 16; the table area is padded 0 12 0 20 as Drive's is. */
export function ContentCard({ header, children, bodyRef }: ContentCardProps) {
  return (
    <section className={styles.card}>
      {header !== undefined && <div className={styles.cardHeader}>{header}</div>}
      <div ref={bodyRef} className={styles.cardBody}>
        {children}
      </div>
    </section>
  );
}

export interface PageTitleProps {
  title: string;
  /** At the right of the title row: the list/grid toggle. */
  end?: ReactNode;
}

/** The content header's title row (02 section 4.5): 64 px, the title in Google Sans 24/32. */
export function PageTitle({ title, end }: PageTitleProps) {
  return (
    <div className={styles.titleRow}>
      <h1 className={styles.title}>{title}</h1>
      {end !== undefined && <div className={styles.titleEnd}>{end}</div>}
    </div>
  );
}

/** The row of filter chips under the title, 8 px apart. */
export function ChipRow({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className={styles.chips} role="group" aria-label={label}>
      {children}
    </div>
  );
}

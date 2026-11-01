// What a reading is called in the library, and how readings are ordered by that name. The library's rows and cards show
// `shownTitle`, and the store sorts by it, so the order on screen can never disagree with the words on screen.

/** What a reading is called: its title, else the file name it was opened from, else "Untitled PDF". `link` is where it was last opened. */
export function shownTitle(title: string | null, link: string | null): string {
  const t = title?.trim();
  if (t !== undefined && t !== '') return t;
  if (link !== null) {
    try {
      const last = new URL(link).pathname.split('/').filter(Boolean).pop();
      if (last !== undefined) return decodeURIComponent(last);
    } catch {
      // not a link we can read: fall through
    }
  }
  return 'Untitled PDF';
}

// Case is ignored, accents are not, and numbers count as numbers ("Part 2" comes before "Part 10").
const collator = new Intl.Collator(undefined, { sensitivity: 'accent', numeric: true });

/** How two shown titles are ordered, A to Z. */
export function compareTitles(a: string, b: string): number {
  return collator.compare(a, b);
}

// The address of My library narrowed to one tag: `library.html#/library?tag=<tag id>`. Back, a reload and a bookmark keep
// it, as they keep the page; the left column's Tags list and a click on a tag chip lead here.
import { useEffect, useState } from 'react';

const ID = /^[\w-]{1,128}$/u;

/** The address of My library showing only the readings with this tag. */
export function tagHref(tagId: string): string {
  return `#/library?tag=${encodeURIComponent(tagId)}`;
}

/** The tag an address narrows My library to, or null. */
export function tagFromHash(hash: string): string | null {
  const m = /^#\/library\?(.*)$/u.exec(hash);
  if (m === null) return null;
  const id = new URLSearchParams(m[1]).get('tag');
  return id !== null && ID.test(id) ? id : null;
}

/** The tag in the address, kept up to date as it changes. */
export function useTagInAddress(): string | null {
  const [tag, setTag] = useState(() => tagFromHash(location.hash));
  useEffect(() => {
    const sync = () => setTag(tagFromHash(location.hash));
    addEventListener('hashchange', sync);
    return () => removeEventListener('hashchange', sync);
  }, []);
  return tag;
}

/** Shows My library with only this tag's readings. */
export function showTag(tagId: string): void {
  location.hash = tagHref(tagId);
}

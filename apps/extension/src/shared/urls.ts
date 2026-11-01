/** Addresses the takeover is willing to open: web pages' PDFs and local files. Anything else (javascript:, data:, blob:, ...) is not. */
export function isOpenableUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:' || protocol === 'file:';
  } catch {
    return false;
  }
}

/** `value` without its `#fragment`. */
export function stripFragment(value: string): string {
  const at = value.indexOf('#');
  return at < 0 ? value : value.slice(0, at);
}

/** The address without its fragment, and the page a `#page=N` fragment names (null for any other fragment). */
export function splitPageFragment(value: string): { url: string; page: number | null } {
  const at = value.indexOf('#');
  if (at < 0) return { url: value, page: null };
  const text = /(?:^|&)page=(\d+)(?:&|$)/.exec(value.slice(at + 1))?.[1];
  const page = text !== undefined && Number(text) >= 1 ? Number(text) : null;
  return { url: value.slice(0, at), page };
}

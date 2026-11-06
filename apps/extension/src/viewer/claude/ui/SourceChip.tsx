// A web page Claude searched and cited (plan §4 F). It reads as the site's name ("example.org") beside a small globe, so
// it is told apart from a page of the PDF at a glance; hovering shows the page's title and address. Pressing it opens
// the page in a new tab, and only an https address opens (jump.ts). It never opens inside the viewer.
import type { WebSource } from '@sop/core';
import { ReplyChip } from './CitationChip';
import { isHttps, openWebSource } from './jump-target';

/** "example.org" from "https://www.example.org/a/b"; the label from the body when the address is not usable. */
export function siteName(url: string, fallback: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./u, '');
    return host === '' ? fallback : host;
  } catch {
    return fallback;
  }
}

export interface SourceChipProps {
  /** The link text from the body ("source"). */
  label: string;
  /** `meta.webSources[n]`; null when the reply names a source it does not have. */
  source: WebSource | null;
}

export function SourceChip({ label, source }: SourceChipProps) {
  const usable = source !== null && isHttps(source.url);
  const site = source === null ? label : siteName(source.url, label);
  const where = usable ? source.url.replace(/^https:\/\//u, '').replace(/\/$/u, '') : 'This address can’t be opened from here';
  const tip = source === null ? null : [source.title.trim(), where].filter(Boolean).join(' · ');
  return (
    <ReplyChip
      kind="web"
      icon="language"
      label={site}
      name={usable ? `Open source in a new tab: ${site}` : `Source: ${site}`}
      tooltip={tip}
      missing={!usable}
      onPress={() => {
        if (source !== null) openWebSource(source.url);
      }}
    />
  );
}

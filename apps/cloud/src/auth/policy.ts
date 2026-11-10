// What a sign-in may get. The owner never ticks boxes: each resource has a fixed set, and the consent page says it plainly.

import type { ResourceKind, Scope } from './server';

/**
 * The scopes a new grant gets. The sync API: `sync` (which also reads the library). The connector: `library:read`, plus
 * `library:comment` when it asked to comment and the owner did not choose "Allow reading only". `offline_access` when asked.
 */
export function grantScopes(kind: ResourceKind, requested: readonly string[], readOnly: boolean): Scope[] {
  const out: Scope[] = kind === 'api' ? ['sync'] : ['library:read'];
  if (kind === 'mcp' && !readOnly && requested.includes('library:comment')) out.push('library:comment');
  if (requested.includes('offline_access')) out.push('offline_access');
  return out;
}

const LINES: Record<Scope, string> = {
  sync: 'Copy your readings and notes to and from this device',
  'library:read': 'Search and read your saved readings and notes',
  'library:comment': "Add comments to your readings. They are marked as Claude's, and it can never change or delete your own notes",
  offline_access: 'Stay connected until you remove it in Settings',
};

export const scopeLines = (scopes: readonly Scope[]): string[] => scopes.map((s) => LINES[s]);

/** An https address, or http on this computer. Anything else (an app's own scheme) is for the Android app only. */
export function isWebRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    return u.protocol === 'https:' || (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]'));
  } catch {
    return false;
  }
}

// The engine's connection to the owner's server, in the extension (CL11): the address and a fresh access token, both from the
// token broker in the service worker (background/cloud-broker.ts), by message. The offscreen document never sees the refresh
// token, and never opens `sop-local` (CA7).
//
// No server connected (or the broker cannot be reached): null, and the engine sends nothing. Signed out on purpose: null too, so
// sync is simply off (no "Sync has stopped", no badge); Settings → Cloud says "Signed out".
import type { EngineConnection } from '@sop/core/sync-client';
import { cloudStatus, cloudToken } from '../shared/cloud-messages';

export async function extensionConnection(): Promise<EngineConnection | null> {
  const s = await cloudStatus();
  if (!s.ok || !s.status.connected || s.status.server === null) return null;
  if (!s.status.signedIn && s.status.signedOutByYou) return null;
  const server = s.status.server;
  return {
    server,
    token: async (refresh = false) => {
      const t = await cloudToken(refresh);
      // A token for another server (the owner connected a different one meanwhile) is never sent here
      return t.ok && t.server === server ? t.token : null;
    },
  };
}

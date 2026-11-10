// One row in `audit` per grant change, session, Forget and Claude write. Never a body, a text, a token or a document id.
import type { Env } from '../env';

export async function audit(env: Env, e: { actor: string; clientId: string | null; action: string; target: string | null; batch?: string | null }): Promise<void> {
  try {
    await env.META.prepare('INSERT INTO audit (at, actor, client_id, action, target, batch) VALUES (?, ?, ?, ?, ?, ?)').bind(Date.now(), e.actor, e.clientId, e.action, e.target, e.batch ?? null).run();
  } catch {
    // the audit must never stop a sign-in
  }
}

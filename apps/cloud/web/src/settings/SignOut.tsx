// Sign out: a plain form post to /logout with the session's CSRF token (plan CA11). The Worker ends the session and clears its
// cookies; this page also forgets the unsent note texts it kept in the browser, so nothing is left on a shared computer. The
// library itself was only ever in this tab's memory.
import { csrfToken } from '../sync/api';
import { forgetAllDrafts } from '../reading/drafts';

export function SignOutForm({ id, hidden = false, children }: { id: string; hidden?: boolean; children?: React.ReactNode }) {
  return (
    <form id={id} method="post" action="/logout" hidden={hidden} onSubmit={() => forgetAllDrafts()}>
      <input type="hidden" name="csrf" value={csrfToken()} />
      {children}
    </form>
  );
}

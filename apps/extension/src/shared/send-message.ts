import type { RuntimeMessage, RuntimeReplyOf } from './messages';

/**
 * `chrome.runtime.sendMessage` with the reply typed from the message. Rejects when the service worker does not
 * answer, and when the extension was reloaded under the page (which makes the call throw): callers catch one thing.
 */
export async function sendRuntimeMessage<M extends RuntimeMessage>(message: M): Promise<RuntimeReplyOf<M>> {
  return chrome.runtime.sendMessage<M, RuntimeReplyOf<M>>(message);
}

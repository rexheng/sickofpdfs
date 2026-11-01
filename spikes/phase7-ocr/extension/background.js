// Service worker: opens the offscreen document on request and relays the self-check result (plan 7.0 "extension checks").
let result = null;
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.cmd === 'selfcheck-result') {
    result = msg.result;
    return false;
  }
  if (msg?.cmd === 'selfcheck-start') {
    result = null;
    (async () => {
      const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      if (!existing.length) {
        await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['WORKERS'], justification: 'OCR spike: run the OCR worker from the offscreen document, as the product will' });
      }
      reply({ started: true });
    })();
    return true;
  }
  if (msg?.cmd === 'selfcheck-poll') {
    reply({ result });
    return false;
  }
  return false;
});

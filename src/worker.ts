chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'golens:rewrite:ping') {
    (globalThis as typeof globalThis & { __golensRewriteRoundTrip?: boolean }).__golensRewriteRoundTrip = true;
    sendResponse('golens:rewrite:pong');
  }
  return false;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'prototype:ping') return false;
  sendResponse({
    ok: message.review.endsWith('/diffs'),
    source: 'service-worker',
  });
  return false;
});

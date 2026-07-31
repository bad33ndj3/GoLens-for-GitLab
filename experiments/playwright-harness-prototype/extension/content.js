const response = await chrome.runtime.sendMessage({
  type: 'prototype:ping',
  review: location.pathname,
});

document.body.dataset.golensPrototype = response.ok ? response.source : 'failed';

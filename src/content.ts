if (/\/-\/merge_requests\/\d+(?:\/|$)/.test(location.pathname)) {
  void chrome.runtime.sendMessage({ type: 'golens:rewrite:ping' }).catch(() => {});
}

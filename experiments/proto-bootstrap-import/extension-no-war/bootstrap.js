// PROTOTYPE — throwaway. Answers ticket 04 §7: can a contentscript dynamic-import a
// real ES module page bundle from a strict-CSP page, and survive SPA navigation.
const startTime = performance.now();
const report = { events: [], errors: [], chromeVersion: navigator.userAgent };

function record(kind, extra = {}) {
  report.events.push({ kind, t: Math.round((performance.now() - startTime) * 100) / 100, ...extra });
}

function publish() {
  document.documentElement.setAttribute('data-proto-report', JSON.stringify(report));
  console.log('[proto-bootstrap-import]', JSON.stringify(report));
}

async function attemptMount(reason) {
  try {
    const mod = await import(chrome.runtime.getURL('page/main.js'));
    const result = mod.mount();
    record('mount', { reason, result });
  } catch (error) {
    const message = String((error && error.stack) || error);
    report.errors.push({ reason, message });
    record('mount-error', { reason, message });
  }
  publish();
}

record('bootstrap-start');
attemptMount('initial');

// SPA navigation detection: content-script isolated world does not reliably observe
// pushState calls made by the page world, so poll location.href instead of hooking history.
let lastHref = location.href;
setInterval(() => {
  if (location.href === lastHref) return;
  lastHref = location.href;
  record('navigation-detected', { href: lastHref });
  attemptMount('navigation');
}, 50);

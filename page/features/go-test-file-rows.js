// page/features/go-test-file-rows.js — marks `_test.go` rows in the
// merge-request file tree (ticket 33; boundary from ticket 03 §2, interface
// from ticket 04 §3). The gap map.md flagged under tickets 13/22 ("Geen
// enkel ticket 13-21 claimt de go-test-file-rows-feature"). Carved out of
// content.js following the generated-files.js precedent (ticket 13): pure
// decision core in go-test-file-rows.internal.js, DOM/timers/subscriptions
// in this shell, fully self-contained once mounted (no reconcile() on the
// handle).
//
// Self-contained page-change observation, same as generated-files.js and
// discussion-line-link.js: its own MutationObserver plus the same event set
// content.js used to funnel into its retired schedulePageReconcile
// (popstate/turbo:load/pjax:end/visibilitychange), debounced through
// platform/clock at the same 50ms delay content.js used. Reacts to
// settings.subscribe('enabled').
import { createClock } from '../platform/clock.js';
import { isGoTestFileRow, shouldMarkGoTestFileRows } from './go-test-file-rows.internal.js';

const RECONCILE_DEBOUNCE_MS = 50;
const MARK_SELECTOR = '[data-golens-go-test-file-row]';

// Deliberate duplicate of content.js's own isMergeRequestDiff(), same
// rationale as generated-files.js's own copy of the same predicate: a
// one-line regex, not worth a shared module across the classic-script/
// ES-module boundary for one ticket's sake.
function isMergeRequestDiff(loc) {
  return /\/-\/merge_requests\/\d+\/diffs(?:$|\/|\?)/.test(loc.pathname + loc.search);
}

export function mount(ctx) {
  const settings = ctx.settings;
  const clock = ctx.clock || createClock();
  const doc = document;
  const win = window;
  const loc = location;

  let unmounted = false;
  let enabled = false;

  function restoreRows() {
    doc.querySelectorAll(MARK_SELECTOR).forEach((fileRow) => {
      fileRow.removeAttribute('data-golens-go-test-file-row');
    });
  }

  function reconcile() {
    if (unmounted) return;
    if (!shouldMarkGoTestFileRows({ enabled, isDiffPage: isMergeRequestDiff(loc) })) {
      restoreRows();
      return;
    }
    doc.querySelectorAll('[data-file-row]').forEach((fileRow) => {
      const labels = [
        fileRow.getAttribute('title'),
        fileRow.getAttribute('aria-label'),
        fileRow.textContent,
      ];
      fileRow.toggleAttribute('data-golens-go-test-file-row', isGoTestFileRow(labels));
    });
  }

  const scheduleReconcile = clock.debounceIdle(reconcile, { delayMs: RECONCILE_DEBOUNCE_MS });

  const observer = new MutationObserver(scheduleReconcile);
  observer.observe(doc.body, { childList: true, subtree: true });

  const onVisibilityChange = () => {
    if (doc.visibilityState === 'visible') scheduleReconcile();
  };
  win.addEventListener('popstate', scheduleReconcile);
  doc.addEventListener('turbo:load', scheduleReconcile);
  doc.addEventListener('pjax:end', scheduleReconcile);
  doc.addEventListener('visibilitychange', onVisibilityChange);

  let unsubscribeEnabled = null;
  if (settings) {
    settings.ready().then(() => {
      if (unmounted) return;
      enabled = Boolean(settings.get('enabled'));
      reconcile();
      unsubscribeEnabled = settings.subscribe('enabled', (value) => {
        enabled = Boolean(value);
        reconcile();
      });
    });
  }

  return {
    unmount() {
      if (unmounted) return;
      unmounted = true;
      scheduleReconcile.cancel();
      observer.disconnect();
      win.removeEventListener('popstate', scheduleReconcile);
      doc.removeEventListener('turbo:load', scheduleReconcile);
      doc.removeEventListener('pjax:end', scheduleReconcile);
      doc.removeEventListener('visibilitychange', onVisibilityChange);
      unsubscribeEnabled?.();
      restoreRows();
    },
  };
}

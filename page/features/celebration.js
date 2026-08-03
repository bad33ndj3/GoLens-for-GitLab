// page/features/celebration.js — hides: native MR action detection
// (approve/merge/resolve/create), celebration/discussion status polling
// cadence, and the mascot-moment overlay (ticket 14; boundary from ticket 03
// §2, interface from ticket 04 §3 — "fully autonomous once mounted", no
// methods on the handle beyond unmount()). Pure decision core in
// celebration.internal.js; this shell owns the click listener, the two
// GitLab REST fetches, the poll timers, and the overlay's shadow DOM — same
// shape as generated-files.js (ticket 13) and settings-overlay.js (ticket
// 16).
//
// "eigen fetches" (map.md's ticket-14 note): mergeRequestCelebrationStatus/
// mergeRequestDiscussionStatus used to live on go-navigation.js, reached
// through the globalThis.GoLensGoNavigation bridge. Unlike ticket 19's
// mr-preload (whose package/project traversal shares go-navigation.js's
// paginated fetch helpers with not-yet-migrated hover/click resolution),
// these two calls are small, self-contained GitLab REST endpoints with no
// other caller — duplicating their ~15 lines of fetch/pagination logic here
// is cheaper than a legacy bridge, so go-navigation.js's copies are deleted
// outright (see this ticket's report for the line-count).
//
// Mount-once lifetime, not pageKey-tracked: bootstrap.js remounts the whole
// page/main.js module graph on every location.href change (a deviation
// ticket 16 already documented for settings-overlay), so this module's own
// mount()/unmount() cycle already is content.js's former enter/leave-
// merge-request-page boundary — there is no separate reconcile-on-navigation
// step to write here. Documented behavior deviation from content.js's
// original: switching tabs within the SAME merge request (e.g. Overview ->
// Changes) now also tears down and re-fetches the celebration/discussion
// baseline and cancels any in-flight post-click poll, where content.js's own
// pageKey check kept both alive across such a same-MR navigation. Accepted
// per the same "any href change" deviation; not fixable within one feature's
// file-ownership (would need lifecycle-level state across remounts, outside
// ticket 04 §3's contract).
//
// Cross-feature pitstop trigger: content.js's own (not-yet-migrated) preload
// UI calls requestMoment('pitstop') when a preload completes. Ticket 03 §3
// bars feature -> feature calls, and there is no message route for this
// (every page/lifecycle/internal.js FEATURE_ROUTES entry has a real external
// sender today, per that file's own comment) — so, mirroring rpc-client.js's
// `methodNamespace` export and overlay-registry.js's module-scope-singleton
// pattern, this module exports a bare `requestMoment(kind)` that forwards to
// whichever instance is currently mounted (there is only ever one: this
// feature is not dual-mounted the way ticket 19's mr-preload is).
// content.js reaches it through the same dynamic-`import()` bridge it
// already uses for settings-store, clock, and overlay-registry. A call while
// nothing is mounted (page-load race, SPA remount gap) is a silent no-op —
// a dropped pitstop moment in that ~15-30ms window, not a crash;
// content.js already accepts the equivalent for its onboarding/settings
// overlays.
import { createClock } from '../platform/clock.js';
import { createOverlayRegistry } from '../platform/overlay-registry.js';
import {
  isGitLabPage,
  isMergeRequestPath,
  mergeRequestIID,
  projectFromPathname,
  normalizeCelebrationStatus,
  normalizeDiscussionStatus,
  celebrationReached,
  isFridayAfterFour,
  momentFor,
  matchMergeRequestAction,
  matchDiscussionResolveAction,
  matchCreateMergeRequestAction,
  nextPageNumber,
  discussionUnresolvedCount,
  confettiPieces,
  celebrationAnchor,
  CELEBRATION_POLL_INTERVALS_MS,
  FRIDAY_MR_CREATE_STORAGE_KEY,
} from './celebration.internal.js';

let active = null;

// requestMoment(kind) -> forwards to the currently-mounted instance, or
// no-ops. See header comment for why this exists outside the mount(ctx)
// contract.
export function requestMoment(kind) {
  active?.requestMascotMoment(kind);
}

function detectGitLabPage(doc, win) {
  return isGitLabPage({
    hasGitlabGlobal: Boolean(win.gon?.gitlab_url),
    hasCsrfMeta: Boolean(doc.querySelector('meta[name="csrf-token"]')),
    hasAppShell: Boolean(doc.querySelector('.super-sidebar, [data-testid="super-sidebar"], #js-top-bar, .layout-page, .ai-panels')),
  });
}

function buttonDetailsForTarget(target) {
  const button = target?.closest?.('button,[role="button"],a[data-testid]');
  if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') return null;
  return {
    testID: String(button.getAttribute('data-testid') || '').toLowerCase(),
    label: [button.textContent, button.getAttribute('aria-label'), button.title]
      .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().toLowerCase(),
  };
}

export function mount(ctx = {}) {
  const doc = document;
  const win = window;
  const loc = location;
  const clock = ctx.clock || createClock();
  const settings = ctx.settings;
  const overlays = ctx.overlays || createOverlayRegistry();

  let unmounted = false;
  let enabled = false;
  const isMergeRequestPage = detectGitLabPage(doc, win) && isMergeRequestPath(loc.pathname);

  let celebrationStatus = null;
  let celebrationRunID = 0;
  let cancelCelebrationPoll = null;
  let cancelCelebrationRemove = null;
  let discussionStatus = null;
  let discussionRunID = 0;
  let cancelDiscussionPoll = null;
  let queuedMoment = '';

  function authenticatedFetch(url) {
    return fetch(url, { credentials: 'include' });
  }

  async function fetchCelebrationStatus() {
    const context = projectFromPathname(loc.pathname);
    const mergeRequest = mergeRequestIID(loc.pathname);
    if (!context || !mergeRequest) throw new Error('GitLab merge request context is unavailable.');
    const encodedProject = encodeURIComponent(context.project);
    const response = await authenticatedFetch(
      `${loc.origin}/api/v4/projects/${encodedProject}/merge_requests/${encodeURIComponent(mergeRequest)}/approvals`,
    );
    if (!response.ok) throw new Error(`GitLab approval API returned ${response.status}`);
    const result = await response.json();
    const approvers = Array.isArray(result.approved_by)
      ? result.approved_by.map((approval) => approval?.user?.id || approval?.user?.username).filter(Boolean).map(String)
      : [];
    return { state: result.state || '', approvers };
  }

  async function fetchDiscussionStatus() {
    const context = projectFromPathname(loc.pathname);
    const mergeRequest = mergeRequestIID(loc.pathname);
    if (!context || !mergeRequest) throw new Error('GitLab merge request context is unavailable.');
    const encodedProject = encodeURIComponent(context.project);
    let unresolved = 0;
    for (let page = 1; page;) {
      if (page > 20) throw new Error('Merge request has too many discussion pages');
      const response = await authenticatedFetch(
        `${loc.origin}/api/v4/projects/${encodedProject}/merge_requests/${encodeURIComponent(mergeRequest)}/discussions?per_page=100&page=${page}`,
      );
      if (!response.ok) throw new Error(`GitLab discussions API returned ${response.status}`);
      const discussions = await response.json();
      if (!Array.isArray(discussions)) throw new Error('GitLab returned invalid merge request discussions');
      unresolved += discussionUnresolvedCount(discussions);
      page = nextPageNumber(response.headers.get('x-next-page'), page, discussions.length);
    }
    return { unresolved };
  }

  async function refreshCelebrationBaseline() {
    if (!enabled || !isMergeRequestPage) { celebrationStatus = null; return null; }
    try {
      const result = normalizeCelebrationStatus(await fetchCelebrationStatus());
      if (unmounted) return null;
      celebrationStatus = result;
      return result;
    } catch {
      if (!unmounted) celebrationStatus = null;
      return null;
    }
  }

  async function refreshDiscussionBaseline() {
    if (!enabled || !isMergeRequestPage) { discussionStatus = null; return null; }
    try {
      const result = normalizeDiscussionStatus(await fetchDiscussionStatus());
      if (unmounted) return null;
      discussionStatus = result;
      return result;
    } catch {
      if (!unmounted) discussionStatus = null;
      return null;
    }
  }

  function removeCelebrationOverlay() {
    cancelCelebrationRemove?.();
    cancelCelebrationRemove = null;
    doc.getElementById('golens-celebration-root')?.remove();
  }

  function cancelCelebrationActivity({ resetStatus = false } = {}) {
    celebrationRunID++;
    discussionRunID++;
    cancelCelebrationPoll?.();
    cancelDiscussionPoll?.();
    cancelCelebrationPoll = null;
    cancelDiscussionPoll = null;
    removeCelebrationOverlay();
    if (resetStatus) {
      celebrationStatus = null;
      discussionStatus = null;
      queuedMoment = '';
    }
  }

  function requestMascotMoment(kind) {
    if (unmounted || !enabled || !isMergeRequestPage) return;
    if (overlays.isAnyOpen()) {
      queuedMoment = kind;
      return;
    }
    showMascotMoment(kind);
  }

  function showMascotMoment(kind) {
    const moment = momentFor(kind);
    if (!moment) return;
    removeCelebrationOverlay();
    const host = doc.createElement('div');
    host.id = 'golens-celebration-root';
    host.dataset.celebration = kind;
    const controlsRect = doc.getElementById('gitlab-lens-root')?.getBoundingClientRect();
    const approvalWidth = Math.min(144, Math.max(104, win.innerWidth * .1));
    const anchor = celebrationAnchor({ controlsRect, viewportWidth: win.innerWidth, viewportHeight: win.innerHeight, approvalWidth });
    if (anchor) {
      host.style.setProperty('--golens-celebration-x', `${anchor.left}px`);
      host.style.setProperty('--golens-celebration-y', `${anchor.top}px`);
    }
    const confetti = kind === 'friday'
      ? `<div class="confetti-field" aria-hidden="true">${confettiPieces(48).map((piece) =>
          `<i class="confetti" style="--x:${piece.x}vw;--drift:${piece.drift}px;--delay:${piece.delay}ms;--fall:${piece.fall}ms;--turn:${piece.turn}deg"></i>`
        ).join('')}</div>`
      : '';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all:initial; position:fixed; inset:0; z-index:var(--golens-z-overlay); pointer-events:none; contain:layout style; }
        * { box-sizing:border-box; }
        .status { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
        .sprite { position:fixed; display:block; object-fit:contain; will-change:transform,opacity; }
        .approved,.resolved { left:var(--golens-celebration-x,calc(100vw - 168px)); top:var(--golens-celebration-y,24px); }
        .approved { width:clamp(104px,10vw,144px); animation:golens-approved 1600ms var(--golens-ease-out) both; }
        .resolved { width:clamp(120px,11vw,156px); animation:golens-resolved 1800ms var(--golens-ease-out) both; }
        .merged,.friday { left:0; bottom:max(12px,env(safe-area-inset-bottom)); width:clamp(240px,30vw,360px); animation:golens-lap 1900ms cubic-bezier(.18,.72,.25,1) both; }
        .friday { width:clamp(260px,32vw,380px); animation:golens-friday-lap 5500ms cubic-bezier(.18,.72,.25,1) both; }
        .pitstop { right:12px; bottom:max(12px,env(safe-area-inset-bottom)); width:clamp(280px,34vw,420px); animation:golens-pitstop 2000ms var(--golens-ease-out) both; }
        .confetti-field { position:fixed; inset:0; overflow:hidden; }
        .confetti { position:absolute; top:-18px; left:var(--x); width:10px; height:6px; border-radius:2px; opacity:0; background:#f39c3d; animation:golens-confetti var(--fall) cubic-bezier(.2,.65,.35,1) var(--delay) both; }
        .confetti:nth-child(5n+2) { background:#77cce5; }
        .confetti:nth-child(5n+3) { background:#f4d35e; }
        .confetti:nth-child(5n+4) { background:#f47c7c; }
        .confetti:nth-child(5n) { background:#9ae6b4; }
        @keyframes golens-approved {
          0% { opacity:0; transform:translate3d(30px,12px,0) scale(.72); }
          18% { opacity:1; transform:translate3d(0,0,0) scale(1); }
          38% { opacity:1; transform:translate3d(-2px,4px,0) rotate(-3deg) scale(1); }
          58% { opacity:1; transform:translate3d(0,0,0) rotate(0) scale(1); }
          78% { opacity:1; transform:translate3d(0,0,0) scale(1); }
          100% { opacity:0; transform:translate3d(24px,10px,0) scale(.85); }
        }
        @keyframes golens-resolved {
          0% { opacity:0; transform:translate3d(28px,8px,0) scale(.78); }
          20% { opacity:1; transform:translate3d(0,0,0) scale(1); }
          42% { opacity:1; transform:translate3d(0,5px,0) rotate(-2deg) scale(.98); }
          60%,80% { opacity:1; transform:translate3d(0,0,0) rotate(0) scale(1); }
          100% { opacity:0; transform:translate3d(20px,8px,0) scale(.86); }
        }
        @keyframes golens-lap {
          0% { opacity:0; transform:translate3d(-110%,0,0) scale(.92); }
          12% { opacity:1; }
          82% { opacity:1; }
          100% { opacity:0; transform:translate3d(calc(100vw + 10%),0,0) scale(1); }
        }
        @keyframes golens-friday-lap {
          0% { opacity:0; transform:translate3d(-110%,0,0) rotate(0) scale(.92); }
          10% { opacity:1; transform:translate3d(10vw,0,0) rotate(-1deg) scale(1); }
          30% { opacity:1; transform:translate3d(34vw,-6px,0) rotate(1deg) scale(1); }
          58% { opacity:1; transform:translate3d(48vw,0,0) rotate(-1deg) scale(1.02); }
          72% { opacity:1; transform:translate3d(61vw,-4px,0) rotate(1deg) scale(1); }
          88% { opacity:1; }
          100% { opacity:0; transform:translate3d(calc(100vw + 10%),0,0) rotate(0) scale(1); }
        }
        @keyframes golens-confetti {
          0% { opacity:0; transform:translate3d(0,-24px,0) rotate(0); }
          10%,86% { opacity:1; }
          100% { opacity:0; transform:translate3d(var(--drift),calc(100vh + 42px),0) rotate(var(--turn)); }
        }
        @keyframes golens-pitstop {
          0% { opacity:0; transform:translate3d(110%,0,0) scale(.94); }
          24% { opacity:1; transform:translate3d(-8px,0,0) scale(1); }
          38%,78% { opacity:1; transform:translate3d(0,0,0) scale(1); }
          100% { opacity:0; transform:translate3d(0,10px,0) scale(.96); }
        }
        @media (max-width:640px) { .approved { width:110px; } .resolved { width:124px; } .merged,.friday { width:260px; } .pitstop { width:300px; } }
        @media (prefers-reduced-motion:reduce) {
          .sprite { will-change:auto; }
          .confetti-field { display:none; }
          .approved,.resolved { animation:golens-celebration-still 900ms ease-out both; }
          .merged { right:12px; left:auto; animation:golens-celebration-still 1200ms ease-out both; }
          .friday { right:12px; left:auto; animation:golens-celebration-still 2200ms ease-out both; }
          .pitstop { animation:golens-celebration-still 1200ms ease-out both; }
          @keyframes golens-celebration-still { 0%,100% { opacity:0; } 12%,82% { opacity:1; } }
        }
      </style>
      <div class="status" role="status" aria-live="polite">${moment.message}</div>
      ${confetti}
      <img class="sprite ${kind}" src="${chrome.runtime.getURL(`assets/celebrations/${moment.asset}`)}" alt="">
    `;
    doc.body.append(host);
    cancelCelebrationRemove = clock.setTimeout(removeCelebrationOverlay, moment.duration);
  }

  function scheduleCelebrationPoll(action, baseline, attempt, runID) {
    const delay = CELEBRATION_POLL_INTERVALS_MS[attempt];
    if (delay == null) return;
    cancelCelebrationPoll = clock.setTimeout(async () => {
      if (runID !== celebrationRunID || !enabled || !isMergeRequestPage) return;
      try {
        const current = normalizeCelebrationStatus(await fetchCelebrationStatus());
        if (runID !== celebrationRunID || !enabled || !isMergeRequestPage) return;
        celebrationStatus = current;
        if (celebrationReached(action, baseline, current)) {
          cancelCelebrationPoll = null;
          requestMascotMoment(isFridayAfterFour() ? 'friday' : action);
          return;
        }
      } catch {
        // GitLab may rerender or briefly reject requests while completing the action.
      }
      scheduleCelebrationPoll(action, baseline, attempt + 1, runID);
    }, delay);
  }

  function armMergeRequestCelebration(action) {
    if (!enabled || !isMergeRequestPage || !celebrationStatus) return;
    cancelCelebrationPoll?.();
    const runID = ++celebrationRunID;
    scheduleCelebrationPoll(action, celebrationStatus, 0, runID);
  }

  function scheduleDiscussionPoll(baseline, attempt, runID) {
    const delay = CELEBRATION_POLL_INTERVALS_MS[attempt];
    if (delay == null) return;
    cancelDiscussionPoll = clock.setTimeout(async () => {
      if (runID !== discussionRunID || !enabled || !isMergeRequestPage) return;
      try {
        const current = normalizeDiscussionStatus(await fetchDiscussionStatus());
        if (runID !== discussionRunID || !enabled || !isMergeRequestPage) return;
        discussionStatus = current;
        if (baseline.unresolved > 0 && current.unresolved === 0) {
          cancelDiscussionPoll = null;
          requestMascotMoment('resolved');
          return;
        }
      } catch {
        // GitLab may briefly rerender a thread while its resolved state is saved.
      }
      scheduleDiscussionPoll(baseline, attempt + 1, runID);
    }, delay);
  }

  function armDiscussionCelebration() {
    if (!enabled || !isMergeRequestPage || !discussionStatus?.unresolved) return;
    cancelDiscussionPoll?.();
    const runID = ++discussionRunID;
    scheduleDiscussionPoll(discussionStatus, 0, runID);
  }

  function rememberFridayMergeRequestCreation() {
    if (!enabled || !detectGitLabPage(doc, win) || !isFridayAfterFour()) return;
    try {
      win.sessionStorage.setItem(FRIDAY_MR_CREATE_STORAGE_KEY, JSON.stringify({
        at: Date.now(),
        projectPath: loc.pathname.split('/-/')[0],
      }));
    } catch {
      // A disabled session store only skips this optional Easter egg.
    }
  }

  function consumeFridayMergeRequestCreation() {
    if (!enabled || !isFridayAfterFour() || !isMergeRequestPage) return false;
    try {
      const raw = win.sessionStorage.getItem(FRIDAY_MR_CREATE_STORAGE_KEY);
      if (!raw) return false;
      win.sessionStorage.removeItem(FRIDAY_MR_CREATE_STORAGE_KEY);
      const pending = JSON.parse(raw);
      const recent = Number.isFinite(pending?.at) && Date.now() - pending.at >= 0 && Date.now() - pending.at < 120000;
      const sameProject = pending?.projectPath && loc.pathname.startsWith(`${pending.projectPath}/-/merge_requests/`);
      if (!recent || !sameProject) return false;
      requestMascotMoment('friday');
      return true;
    } catch {
      return false;
    }
  }

  function onNativeMergeRequestActionClick(event) {
    const details = buttonDetailsForTarget(event.target);
    if (!details) return;
    if (matchCreateMergeRequestAction(details)) {
      rememberFridayMergeRequestCreation();
      return;
    }
    if (matchDiscussionResolveAction(details)) armDiscussionCelebration();
    const action = matchMergeRequestAction(details);
    if (action) armMergeRequestCelebration(action);
  }

  doc.addEventListener('click', onNativeMergeRequestActionClick, true);

  // The settings overlay used to flush a queued mascot moment on its own
  // close path; that path moved to page/features/settings-overlay.js (ticket
  // 16), which has no business knowing about this module's celebration
  // state. This module watches the overlay registry's open -> closed
  // transition instead, same as content.js does for onboarding's still-legacy
  // close path.
  const unsubscribeOverlays = overlays.subscribe((open) => {
    if (open || unmounted) return;
    const moment = queuedMoment;
    queuedMoment = '';
    if (moment && enabled && isMergeRequestPage) clock.setTimeout(() => showMascotMoment(moment), 0);
  });

  let unsubscribeEnabled = null;
  if (settings) {
    settings.ready().then(() => {
      if (unmounted) return;
      enabled = Boolean(settings.get('enabled'));
      Promise.all([refreshCelebrationBaseline(), refreshDiscussionBaseline()]).then(() => {
        if (!unmounted) consumeFridayMergeRequestCreation();
      });
      unsubscribeEnabled = settings.subscribe('enabled', (value) => {
        enabled = Boolean(value);
        if (enabled) {
          refreshCelebrationBaseline();
          refreshDiscussionBaseline();
        } else {
          cancelCelebrationActivity({ resetStatus: true });
        }
      });
    });
  }

  active = { requestMascotMoment };

  return {
    unmount() {
      if (unmounted) return;
      unmounted = true;
      if (active && active.requestMascotMoment === requestMascotMoment) active = null;
      doc.removeEventListener('click', onNativeMergeRequestActionClick, true);
      unsubscribeOverlays();
      unsubscribeEnabled?.();
      cancelCelebrationActivity({ resetStatus: true });
    },
  };
}

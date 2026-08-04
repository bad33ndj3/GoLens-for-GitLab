// page/features/settings-overlay.internal.js — pure decision core for
// page/features/settings-overlay.js. No DOM, no chrome.*, no timers. This
// feature is nearly all imperative shell (DOM creation, message listening,
// registry claim/release) — there just isn't much decision logic to pull out,
// so this file stays small.

// isGitLabPage({ hasGitlabGlobal, hasCsrfMeta, hasAppShell }) -> whether the
// current document looks like a real GitLab page, mirroring content.js's own
// isGitLab() heuristic (duplicated per precedent: a one-line, unlikely-to-drift
// predicate, not worth a shared platform module). Total.
export function isGitLabPage({ hasGitlabGlobal, hasCsrfMeta, hasAppShell }) {
  return Boolean(hasGitlabGlobal || (hasCsrfMeta && hasAppShell));
}

// isMergeRequestPath(pathname) -> mirrors content.js's own isMergeRequest().
// Used to gate closing the settings overlay in response to a
// 'golens-show-onboarding' message the same way content.js's own handler
// gates opening onboarding (both must agree, or the two overlays'
// mutual-exclusion behavior would desync). Total.
export function isMergeRequestPath(pathname) {
  return /\/-\/merge_requests\/\d+/.test(pathname || '');
}

// overlayMarkup({ settingsUrl }) -> the settings overlay's shadow-DOM
// innerHTML, byte-identical to content.js's former showSettingsOverlay()
// template. Total.
export function overlayMarkup({ settingsUrl }) {
  return `
    <style>
      :host { all:initial; position:fixed; inset:0; z-index:var(--golens-z-modal); color-scheme:dark; }
      * { box-sizing:border-box; }
      .backdrop { position:absolute; inset:0; display:grid; place-items:center; overflow:auto; padding:32px; background:rgba(7,10,14,.76); backdrop-filter:blur(3px); }
      iframe { display:block; width:min(1080px,calc(100vw - 64px)); height:min(690px,calc(100dvh - 64px)); border:1px solid var(--golens-border-default); border-radius:var(--golens-radius-overlay); background:var(--golens-surface-canvas); box-shadow:var(--golens-shadow-overlay); }
      iframe:focus-visible { outline:2px solid var(--golens-focus-ring); outline-offset:3px; }
      @media (max-width:760px) { .backdrop { padding:12px; } iframe { width:calc(100vw - 24px); height:calc(100dvh - 24px); } }
      @media (prefers-reduced-motion:reduce) { .backdrop { backdrop-filter:none; } }
    </style>
    <div class="backdrop" data-action="close-settings-backdrop" role="dialog" aria-modal="true" aria-label="GoLens settings">
      <iframe src="${settingsUrl}" title="GoLens settings"></iframe>
    </div>
  `;
}

// page/features/onboarding.internal.js — pure decision core for
// page/features/onboarding.js (ticket 15; contract per ticket 04 §1's
// internal-seam convention, mirrored from settings-overlay.internal.js). No
// DOM, no chrome.*, no timers: markup builders return HTML strings from
// already-resolved data (URLs, booleans, precomputed option markup), they
// never read chrome.runtime.getURL or globalThis.GoLensShortcuts themselves.

// isGitLabPage({ hasGitlabGlobal, hasCsrfMeta, hasAppShell }) -> mirrors
// content.js's own isGitLab() heuristic, duplicated per
// settings-overlay.internal.js's precedent (a one-line, unlikely-to-drift
// predicate, not worth a shared platform module for one ticket's sake). Total.
export function isGitLabPage({ hasGitlabGlobal, hasCsrfMeta, hasAppShell }) {
  return Boolean(hasGitlabGlobal || (hasCsrfMeta && hasAppShell));
}

// isMergeRequestPath(pathname) -> mirrors content.js's own isMergeRequest().
// Total.
export function isMergeRequestPath(pathname) {
  return /\/-\/merge_requests\/\d+/.test(pathname || '');
}

// shouldShowFirstRun(storedVersion, currentVersion) -> mirrors content.js's
// showFirstRunOnboarding() guard exactly: `if (stored >= current) return`,
// inverted into a boolean. `undefined >= number` is false, so a missing
// stored version shows onboarding — matches the original. Total.
export function shouldShowFirstRun(storedVersion, currentVersion) {
  return !(storedVersion >= currentVersion);
}

// onboardingFeatureIcon(name, { brandIconUrl }) -> byte-identical to
// content.js's former onboardingFeatureIcon(), except the 'brand' case's
// icon URL is now threaded in rather than read from chrome.runtime.getURL
// directly. Total: returns '' for an unknown name, same as the original.
export function onboardingFeatureIcon(name, { brandIconUrl } = {}) {
  if (name === 'brand') {
    return `<span class="feature-icon feature-icon-brand" data-feature-icon="brand" aria-hidden="true"><img src="${brandIconUrl}" alt=""></span>`;
  }
  const icons = {
    focus: {
      tone: 'info',
      body: '<path d="M8 4H5a1 1 0 0 0-1 1v3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"></path><path d="M8.5 12h7"></path>',
    },
    download: {
      tone: 'brand',
      body: '<path d="M12 3v11m0 0 4-4m-4 4-4-4"></path><path d="M5 17v3h14v-3"></path>',
    },
    hover: {
      tone: 'info',
      body: '<path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"></path><circle cx="12" cy="12" r="2.5"></circle>',
    },
    navigate: {
      tone: 'info',
      body: '<rect x="6" y="3" width="12" height="18" rx="6"></rect><path d="M12 3v7M6 10h12"></path>',
    },
    inDiff: {
      tone: 'brand',
      viewBox: '0 0 16 16',
      filled: true,
      body: '<path d="M2 2h2v6a3 3 0 0 0 3 3h4.2L9 8.8 10.4 7 15 11.5 10.4 16 9 14.2l2.2-2.2H7a4 4 0 0 1-4-4V2z"></path>',
    },
    copy: {
      tone: 'info',
      viewBox: '0 0 16 16',
      body: '<rect x="5.25" y="5.25" width="8" height="8" rx="1.25"></rect><path d="M10.75 5.25V3.5c0-.7-.55-1.25-1.25-1.25h-6c-.7 0-1.25.55-1.25 1.25v6c0 .7.55 1.25 1.25 1.25h1.75"></path>',
    },
    testDouble: {
      tone: 'success',
      body: '<path d="M9 3h6M10 3v5l-5 8.5A3 3 0 0 0 7.6 21h8.8a3 3 0 0 0 2.6-4.5L14 8V3M8.5 14h7"></path>',
    },
    rapid: {
      tone: 'brand',
      body: '<path d="M13 2 4 14h7v8l9-12h-7z"></path>',
    },
    fullFile: {
      tone: 'neutral',
      viewBox: '0 0 16 16',
      body: '<path d="M3 1.75h10M3 14.25h10M8 3.25v3.5m0-3.5L6.25 5M8 3.25 9.75 5M8 12.75v-3.5m0 3.5L6.25 11M8 12.75 9.75 11"></path>',
    },
    search: {
      tone: 'info',
      body: '<circle cx="11" cy="11" r="6.5"></circle><path d="m16 16 4.5 4.5"></path>',
    },
    testFile: {
      tone: 'success',
      body: '<path d="M6 3h7l5 5v13H6zM13 3v5h5"></path><path d="m10 13-2 2 2 2m4-4 2 2-2 2"></path>',
    },
    generated: {
      tone: 'muted',
      body: '<path d="M3 3l18 18"></path><path d="M10.6 10.7a2 2 0 0 0 2.7 2.7M9.9 5.3A10.8 10.8 0 0 1 12 5c6 0 9.5 7 9.5 7a15.4 15.4 0 0 1-2.4 3.2M6.6 6.6A16 16 0 0 0 2.5 12s3.5 7 9.5 7a9.7 9.7 0 0 0 3.4-.6"></path>',
    },
    discussion: {
      tone: 'brand',
      body: '<path d="M5 18l-2 3V7a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3z"></path><path d="M9 11h7m-3-3 3 3-3 3"></path>',
    },
    bookmark: {
      tone: 'brand',
      body: '<path d="M6 3.5h12v17l-6-4-6 4z"></path>',
    },
    settings: {
      tone: 'neutral',
      body: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"></path><circle cx="16" cy="7" r="2"></circle><circle cx="8" cy="17" r="2"></circle>',
    },
    database: {
      tone: 'info',
      body: '<ellipse cx="12" cy="5" rx="7" ry="3"></ellipse><path d="M5 5v7c0 1.7 3.1 3 7 3s7-1.3 7-3V5M5 12v7c0 1.7 3.1 3 7 3s7-1.3 7-3v-7"></path>',
    },
    replay: {
      tone: 'neutral',
      viewBox: '0 0 16 16',
      body: '<path d="M3 8h9m-3.5-3.5L12 8l-3.5 3.5"></path>',
    },
    lock: {
      tone: 'success',
      body: '<rect x="5" y="10" width="14" height="11" rx="2"></rect><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"></path>',
    },
  };
  const icon = icons[name];
  if (!icon) return '';
  const classes = ['feature-icon', `feature-icon-${icon.tone}`];
  if (icon.filled) classes.push('feature-icon-filled');
  return `<span class="${classes.join(' ')}" data-feature-icon="${name}" aria-hidden="true"><svg viewBox="${icon.viewBox || '0 0 24 24'}">${icon.body}</svg></span>`;
}

// setupDialogMarkup({ mascotUrl, brandIconUrl, customOptionHtml,
// presetOptionsHtml, hideGeneratedFiles }) -> the first-run "quick setup"
// wizard's shadow-DOM innerHTML, byte-identical to content.js's former
// showSetupOnboarding() template. Total.
export function setupDialogMarkup({ mascotUrl, brandIconUrl, customOptionHtml, presetOptionsHtml, hideGeneratedFiles }) {
  return `
    <style>
      :host { all:initial; position:fixed; inset:0; z-index:var(--golens-z-modal); color:var(--golens-text-primary); font:14px/1.45 var(--golens-font-sans); color-scheme:dark; }
      * { box-sizing:border-box; }
      .backdrop { position:absolute; inset:0; display:grid; place-items:center; overflow:auto; padding:var(--golens-space-6); background:rgba(9,10,12,.82); backdrop-filter:blur(4px); }
      .dialog { position:relative; display:grid; grid-template-rows:auto minmax(0,1fr) auto; width:min(680px,calc(100vw - 32px)); max-height:min(680px,calc(100dvh - 32px)); overflow:hidden; border:1px solid var(--golens-border-default); border-radius:var(--golens-radius-xl); background:var(--golens-surface-panel); box-shadow:var(--golens-shadow-lg); }
      .hero { display:grid; grid-template-columns:56px minmax(0,1fr); gap:var(--golens-space-4); align-items:center; padding:var(--golens-space-5) var(--golens-space-6); border-bottom:1px solid var(--golens-border-subtle); background:var(--golens-surface-raised); }
      .mascot { width:56px; height:56px; object-fit:contain; }
      .eyebrow { margin:0 0 var(--golens-space-1); color:var(--golens-primary-hover); font-size:10px; font-weight:800; letter-spacing:.1em; text-transform:uppercase; }
      h1 { margin:0; color:var(--golens-text-primary); font-size:23px; line-height:1.15; letter-spacing:-.025em; }
      .intro { margin:var(--golens-space-2) 0 0; color:var(--golens-text-secondary); font-size:12px; }
      .close { position:absolute; top:var(--golens-space-3); right:var(--golens-space-3); display:grid; place-items:center; width:32px; height:32px; padding:0; border:1px solid transparent; border-radius:var(--golens-radius-sm); background:transparent; color:var(--golens-text-muted); cursor:pointer; font:22px/1 var(--golens-font-sans); }
      .close:hover { border-color:var(--golens-border-default); background:var(--golens-surface-hover); color:var(--golens-text-primary); }
      .setup-panel { min-height:0; overflow:auto; padding:var(--golens-space-6); }
      .setup-panel[hidden] { display:none; }
      .step-label { margin:0 0 var(--golens-space-1); color:var(--golens-primary-hover); font:800 10px/1.3 var(--golens-font-mono); letter-spacing:.08em; text-transform:uppercase; }
      h2 { margin:0; color:var(--golens-text-primary); font-size:20px; line-height:1.2; letter-spacing:-.015em; }
      .step-intro { max-width:58ch; margin:var(--golens-space-2) 0 var(--golens-space-5); color:var(--golens-text-secondary); font-size:12px; }
      .choice-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:var(--golens-space-3); }
      .choice-card { position:relative; display:grid; grid-template-columns:auto minmax(0,1fr); gap:var(--golens-space-3); align-items:start; min-height:78px; padding:var(--golens-space-4); border:1px solid var(--golens-border-default); border-radius:var(--golens-radius-panel); background:var(--golens-surface-raised); cursor:pointer; }
      .choice-card:hover { border-color:var(--golens-border-strong); background:var(--golens-surface-hover); }
      .choice-card:has(input:checked) { border-color:var(--golens-primary); background:var(--golens-primary-soft); box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--golens-primary) 30%,transparent); }
      .choice-card input { width:16px; height:16px; margin:2px 0 0; accent-color:var(--golens-primary); }
      .choice-card strong { display:block; color:var(--golens-text-primary); font-size:12px; }
      .choice-card small { display:block; margin-top:4px; color:var(--golens-text-muted); font-size:10.5px; line-height:1.45; }
      .essentials { display:grid; gap:var(--golens-space-3); margin:0; padding:0; list-style:none; }
      .essential { display:grid; grid-template-columns:40px minmax(0,1fr); gap:var(--golens-space-3); align-items:center; padding:var(--golens-space-3); border:1px solid var(--golens-border-subtle); border-radius:var(--golens-radius-panel); background:var(--golens-surface-raised); }
      .feature-icon { display:grid; place-items:center; width:40px; height:40px; border:1px solid var(--golens-border-default); border-radius:var(--golens-radius-sm); background:var(--golens-surface-inset); color:var(--golens-info-hover); }
      .feature-icon svg { width:24px; height:24px; fill:none; stroke:currentColor; stroke-linecap:round; stroke-linejoin:round; stroke-width:1.75; }
      .feature-icon-filled svg { fill:currentColor; stroke:none; }
      .feature-icon img { width:30px; height:30px; border-radius:var(--golens-radius-xs); object-fit:contain; }
      .essential strong { display:block; color:var(--golens-text-primary); font-size:12px; }
      .essential p { margin:2px 0 0; color:var(--golens-text-secondary); font-size:11px; line-height:1.45; }
      kbd { min-width:24px; padding:2px 6px; border:1px solid var(--golens-border-strong); border-bottom-width:2px; border-radius:var(--golens-radius-xs); background:var(--golens-surface-inset); color:var(--golens-text-primary); font:700 10px/1.4 var(--golens-font-mono); text-align:center; }
      .footer { display:grid; grid-template-columns:auto minmax(0,1fr) auto; gap:var(--golens-space-3); align-items:center; padding:var(--golens-space-3) var(--golens-space-5); border-top:1px solid var(--golens-border-subtle); background:var(--golens-surface-raised); }
      .progress { margin:0; color:var(--golens-text-muted); font:650 10px/1.4 var(--golens-font-mono); text-align:center; }
      .status { min-height:16px; margin:var(--golens-space-3) 0 0; color:var(--golens-error); font-size:11px; }
      .secondary,.primary { min-height:36px; padding:0 var(--golens-space-4); border-radius:var(--golens-radius-sm); cursor:pointer; font:750 12px/1 var(--golens-font-sans); white-space:nowrap; }
      .secondary { border:1px solid var(--golens-border-default); background:transparent; color:var(--golens-text-secondary); }
      .secondary:hover { border-color:var(--golens-border-strong); background:var(--golens-surface-hover); color:var(--golens-text-primary); }
      .secondary[hidden] { visibility:hidden; display:block; }
      .primary { border:1px solid var(--golens-primary); background:var(--golens-primary); color:var(--golens-text-inverse); font-weight:800; }
      .primary:hover { border-color:var(--golens-primary-hover); background:var(--golens-primary-hover); }
      button:focus-visible,input:focus-visible { outline:2px solid var(--golens-focus-ring); outline-offset:2px; }
      @media (max-width:640px) { .backdrop { padding:var(--golens-space-3); } .dialog { max-height:calc(100dvh - 24px); } .hero { grid-template-columns:44px 1fr; padding:var(--golens-space-4) var(--golens-space-5); } .mascot { width:44px; height:44px; } h1 { padding-right:var(--golens-space-5); font-size:20px; } .setup-panel { padding:var(--golens-space-5); } .choice-grid { grid-template-columns:1fr; } }
      @media (prefers-reduced-motion:reduce) { .backdrop { backdrop-filter:none; } }
    </style>
    <div class="backdrop" data-action="backdrop">
      <section class="dialog" data-onboarding-dialog data-onboarding-mode="setup" role="dialog" aria-modal="true" aria-labelledby="golens-setup-title" aria-describedby="golens-setup-description">
        <button class="close" type="button" data-action="close-onboarding" aria-label="Close setup">×</button>
        <header class="hero">
          <img class="mascot" src="${mascotUrl}" alt="">
          <div><p class="eyebrow">Quick setup</p><h1 id="golens-setup-title">Make GoLens feel familiar</h1><p class="intro" id="golens-setup-description">Two choices, then the essentials.</p></div>
        </header>
        <section class="setup-panel" data-setup-panel>
          <p class="step-label">Keyboard</p>
          <h2>Which shortcuts should GoLens use?</h2>
          <p class="step-intro">Choose a familiar keymap. You can customize every action later.</p>
          <div class="choice-grid">${customOptionHtml}${presetOptionsHtml}</div>
        </section>
        <section class="setup-panel" data-setup-panel hidden>
          <p class="step-label">Diff display</p>
          <h2>Hide generated files?</h2>
          <p class="step-intro">GoLens follows GitLab’s <code>.gitattributes</code> generated marker. Large collapsed files remain visible.</p>
          <div class="choice-grid">
            <label class="choice-card"><input type="radio" name="generated-files" value="show" ${hideGeneratedFiles ? '' : 'checked'}><span><strong>Show generated files</strong><small>Keep GitLab’s complete changed-file list visible.</small></span></label>
            <label class="choice-card"><input type="radio" name="generated-files" value="hide" ${hideGeneratedFiles ? 'checked' : ''}><span><strong>Hide generated files</strong><small>Hide marked files and dim generated-only folders.</small></span></label>
          </div>
        </section>
        <section class="setup-panel" data-setup-panel hidden>
          <p class="step-label">Ready</p>
          <h2>Four things to remember</h2>
          <p class="step-intro">The complete feature guide stays available in Settings under Help.</p>
          <ul class="essentials">
            <li class="essential">${onboardingFeatureIcon('brand', { brandIconUrl })}<div><strong>Use the review controls</strong><p>Toggle GoLens, enter review focus, or cache related packages.</p></div></li>
            <li class="essential">${onboardingFeatureIcon('hover')}<div><strong>Hover for Go insight</strong><p>See signatures, documentation, source locations, and usages.</p></div></li>
            <li class="essential">${onboardingFeatureIcon('search')}<div><strong>Plain-click selects occurrences</strong><p>Move through matching identifiers in the loaded diff.</p></div></li>
            <li class="essential">${onboardingFeatureIcon('navigate')}<div><strong><kbd>Cmd</kbd>/<kbd>Ctrl</kbd>-click follows code</strong><p>Resolve definitions, usages, and interface implementations.</p></div></li>
          </ul>
          <p class="status" data-setup-status role="status" aria-live="polite"></p>
        </section>
        <footer class="footer">
          <button class="secondary" type="button" data-action="previous-onboarding" hidden>Back</button>
          <p class="progress" data-tour-progress aria-live="polite">1 of 3 · Keyboard</p>
          <button class="primary" type="button" data-action="next-onboarding">Continue</button>
        </footer>
      </section>
    </div>
  `;
}

// tourDialogMarkup({ mascotUrl, brandIconUrl }) -> the manually-opened
// "quick tour" reference's shadow-DOM innerHTML, byte-identical to
// content.js's former showOnboarding() template. Total.
export function tourDialogMarkup({ mascotUrl, brandIconUrl }) {
  return `
    <style>
      :host { all:initial; position:fixed; inset:0; z-index:var(--golens-z-modal); color:var(--golens-text-primary); font:14px/1.45 var(--golens-font-sans); color-scheme:dark; }
      * { box-sizing:border-box; }
      .backdrop { position:absolute; inset:0; display:grid; place-items:center; overflow:auto; padding:var(--golens-space-6); background:rgba(9,10,12,.82); backdrop-filter:blur(4px); }
      .dialog { position:relative; display:grid; grid-template-rows:auto minmax(0,1fr) auto; width:min(760px,calc(100vw - 32px)); max-height:min(720px,calc(100dvh - 32px)); overflow:hidden; border:1px solid var(--golens-border-default); border-radius:var(--golens-radius-xl); background:var(--golens-surface-panel); box-shadow:var(--golens-shadow-lg); }
      .hero { display:grid; grid-template-columns:64px 1fr; gap:var(--golens-space-4); align-items:center; padding:var(--golens-space-5) var(--golens-space-6); border-bottom:1px solid var(--golens-border-subtle); background:var(--golens-surface-raised); }
      .mascot { width:64px; height:64px; object-fit:contain; }
      .eyebrow { margin:0 0 var(--golens-space-1); color:var(--golens-primary-hover); font-size:11px; font-weight:800; letter-spacing:.12em; text-transform:uppercase; }
      h1 { margin:0; color:var(--golens-text-primary); font-size:24px; line-height:1.15; letter-spacing:-.025em; }
      .intro { max-width:560px; margin:var(--golens-space-2) 0 0; color:var(--golens-text-secondary); text-wrap:pretty; }
      .close { position:absolute; top:var(--golens-space-3); right:var(--golens-space-3); display:grid; place-items:center; width:32px; height:32px; padding:0; border:1px solid transparent; border-radius:var(--golens-radius-sm); background:transparent; color:var(--golens-text-muted); cursor:pointer; font:22px/1 var(--golens-font-sans); transition:background-color var(--golens-motion-fast),border-color var(--golens-motion-fast),color var(--golens-motion-fast),transform var(--golens-motion-fast); }
      .close:hover { border-color:var(--golens-border-default); background:var(--golens-surface-hover); color:var(--golens-text-primary); }
      .close:active { background:var(--golens-surface-pressed); transform:translateY(1px); }
      .tour { display:grid; grid-template-columns:180px minmax(0,1fr); min-height:0; }
      .tour-nav { display:grid; align-content:start; gap:var(--golens-space-1); padding:var(--golens-space-4); border-right:1px solid var(--golens-border-subtle); background:var(--golens-surface-inset); }
      .tour-tab { display:grid; grid-template-columns:28px minmax(0,1fr); gap:var(--golens-space-2); align-items:center; min-height:42px; padding:var(--golens-space-2); border:1px solid transparent; border-radius:var(--golens-radius-sm); background:transparent; color:var(--golens-text-secondary); cursor:pointer; font:650 12px/1.3 var(--golens-font-sans); text-align:left; transition:background-color var(--golens-motion-fast),border-color var(--golens-motion-fast),color var(--golens-motion-fast),transform var(--golens-motion-fast); }
      .tour-tab:hover { border-color:var(--golens-border-default); background:var(--golens-surface-hover); color:var(--golens-text-primary); }
      .tour-tab:active { background:var(--golens-surface-pressed); transform:translateY(1px); }
      .tour-tab[aria-selected="true"] { border-color:color-mix(in srgb,var(--golens-primary) 55%,var(--golens-border-default)); background:var(--golens-primary-soft); color:var(--golens-text-primary); }
      .tab-icon { display:grid; place-items:center; width:28px; height:28px; color:var(--golens-text-muted); }
      .tab-icon svg { width:20px; height:20px; fill:none; stroke:currentColor; stroke-linecap:round; stroke-linejoin:round; stroke-width:1.75; }
      .tab-icon img { width:24px; height:24px; border-radius:var(--golens-radius-xs); object-fit:contain; filter:grayscale(.5); opacity:.78; }
      .tab-symbol { display:inline-flex; width:auto; min-width:24px; height:20px; align-items:center; justify-content:center; padding:0 3px; border:1px solid currentColor; border-radius:var(--golens-radius-xs); color:var(--golens-info-hover); font:700 9px/1 var(--golens-font-mono); }
      .tour-tab[aria-selected="true"] .tab-icon { color:var(--golens-primary-hover); }
      .tour-tab[aria-selected="true"] .tab-icon img { filter:none; opacity:1; }
      .tour-panels { min-width:0; min-height:0; overflow:hidden; }
      .tour-panel { height:100%; overflow:auto; padding:var(--golens-space-5) var(--golens-space-6) var(--golens-space-6); }
      .tour-panel[hidden] { display:none; }
      .chapter-label { margin:0 0 var(--golens-space-1); color:var(--golens-primary-hover); font-size:10px; font-weight:800; letter-spacing:.1em; text-transform:uppercase; }
      h2 { margin:0; color:var(--golens-text-primary); font-size:19px; line-height:1.2; letter-spacing:-.015em; text-wrap:balance; }
      .chapter-intro { max-width:58ch; margin:var(--golens-space-2) 0 var(--golens-space-4); color:var(--golens-text-secondary); font-size:12px; line-height:1.55; text-wrap:pretty; }
      .feature-list { display:grid; gap:0; margin:0; padding:0; list-style:none; }
      .feature { display:grid; grid-template-columns:40px minmax(0,1fr); gap:var(--golens-space-3); align-items:start; padding:var(--golens-space-3) 0; border-top:1px solid var(--golens-border-subtle); }
      .feature-icon { display:grid; place-items:center; width:40px; height:40px; border:1px solid var(--golens-border-default); border-radius:var(--golens-radius-sm); background:var(--golens-surface-raised); color:var(--golens-text-secondary); box-shadow:inset 0 1px 0 color-mix(in srgb,var(--golens-text-primary) 5%,transparent); }
      .feature-icon svg { width:24px; height:24px; fill:none; stroke:currentColor; stroke-linecap:round; stroke-linejoin:round; stroke-width:1.75; }
      .feature-icon-filled svg { fill:currentColor; stroke:none; }
      .feature-icon img { width:30px; height:30px; border-radius:var(--golens-radius-xs); object-fit:contain; }
      .feature-icon-brand { border-color:color-mix(in srgb,var(--golens-primary) 45%,var(--golens-border-default)); background:var(--golens-primary-soft); }
      .feature-icon-info { border-color:color-mix(in srgb,var(--golens-info) 35%,var(--golens-border-default)); background:var(--golens-info-soft); color:var(--golens-info-hover); }
      .feature-icon-success { border-color:color-mix(in srgb,var(--golens-success) 35%,var(--golens-border-default)); background:var(--golens-success-soft); color:var(--golens-success); }
      .feature-icon-muted { color:var(--golens-text-muted); }
      .feature strong { display:block; margin:0 0 2px; color:var(--golens-text-primary); font-size:12px; line-height:1.35; }
      .feature p { max-width:62ch; margin:0; color:var(--golens-text-secondary); font-size:11px; line-height:1.5; text-wrap:pretty; }
      .feature-note { color:var(--golens-text-muted); }
      kbd { min-width:24px; padding:2px 6px; border:1px solid var(--golens-border-strong); border-bottom-width:2px; border-radius:var(--golens-radius-xs); background:var(--golens-surface-inset); color:var(--golens-text-primary); font:700 10px/1.4 var(--golens-font-mono); text-align:center; }
      .footer { display:grid; grid-template-columns:auto minmax(0,1fr) auto; gap:var(--golens-space-3); align-items:center; padding:var(--golens-space-3) var(--golens-space-5); border-top:1px solid var(--golens-border-subtle); background:var(--golens-surface-raised); }
      .tour-progress { margin:0; color:var(--golens-text-muted); font:650 10px/1.4 var(--golens-font-mono); text-align:center; }
      .secondary,.primary { min-height:36px; padding:0 var(--golens-space-4); border-radius:var(--golens-radius-sm); cursor:pointer; font:750 12px/1 var(--golens-font-sans); white-space:nowrap; transition:background-color var(--golens-motion-fast),border-color var(--golens-motion-fast),color var(--golens-motion-fast),transform var(--golens-motion-fast); }
      .secondary { border:1px solid var(--golens-border-default); background:transparent; color:var(--golens-text-secondary); }
      .secondary:hover { border-color:var(--golens-border-strong); background:var(--golens-surface-hover); color:var(--golens-text-primary); }
      .secondary[hidden] { visibility:hidden; display:block; }
      .primary { flex:0 0 auto; min-height:38px; padding:0 var(--golens-space-5); border:1px solid var(--golens-primary); border-radius:var(--golens-radius-sm); background:var(--golens-primary); color:var(--golens-text-inverse); cursor:pointer; font:800 13px/1 var(--golens-font-sans); transition:background-color var(--golens-motion-fast),border-color var(--golens-motion-fast),transform var(--golens-motion-fast); }
      .primary:hover { border-color:var(--golens-primary-hover); background:var(--golens-primary-hover); }
      .secondary:active,.primary:active { transform:translateY(1px); }
      .primary:active { border-color:var(--golens-primary-pressed); background:var(--golens-primary-pressed); }
      button:focus-visible { outline:2px solid var(--golens-focus-ring); outline-offset:2px; }
      @media (max-width:640px) { .backdrop { padding:var(--golens-space-3); } .dialog { max-height:calc(100dvh - 24px); } .hero { grid-template-columns:48px 1fr; padding:var(--golens-space-4) var(--golens-space-5); } .mascot { width:48px; height:48px; } h1 { padding-right:var(--golens-space-5); font-size:20px; } .tour { grid-template-columns:1fr; grid-template-rows:auto minmax(0,1fr); } .tour-nav { grid-template-columns:repeat(4,minmax(112px,1fr)); overflow-x:auto; padding:var(--golens-space-2) var(--golens-space-3); border-right:0; border-bottom:1px solid var(--golens-border-subtle); } .tour-tab { grid-template-columns:24px minmax(0,1fr); min-height:36px; padding:var(--golens-space-1) var(--golens-space-2); font-size:10px; } .tab-icon { width:24px; height:24px; } .tab-icon svg { width:18px; height:18px; } .tab-icon img { width:22px; height:22px; } .tour-panel { padding:var(--golens-space-4) var(--golens-space-5) var(--golens-space-5); } }
      @media (max-width:420px) { .hero { grid-template-columns:1fr; } .mascot { display:none; } .footer { grid-template-columns:auto 1fr auto; padding-inline:var(--golens-space-3); } .secondary,.primary { padding-inline:var(--golens-space-3); } }
      @media (prefers-reduced-motion:reduce) { .close,.tour-tab,.secondary,.primary { transition:none; } .close:active,.tour-tab:active,.secondary:active,.primary:active { transform:none; } }
    </style>
    <div class="backdrop" data-action="backdrop">
      <section class="dialog" data-onboarding-dialog role="dialog" aria-modal="true" aria-labelledby="golens-onboarding-title" aria-describedby="golens-onboarding-description">
        <button class="close" type="button" data-action="close-onboarding" aria-label="Close quick tour">×</button>
        <header class="hero">
          <img class="mascot" src="${mascotUrl}" alt="">
          <div>
            <p class="eyebrow">Quick tour</p>
            <h1 id="golens-onboarding-title">Welcome to GoLens for GitLab</h1>
            <p class="intro" id="golens-onboarding-description">A concise reference for every GoLens review tool.</p>
          </div>
        </header>
        <div class="tour">
          <nav class="tour-nav" role="tablist" aria-label="Quick tour chapters">
            <button class="tour-tab" id="golens-tour-tab-controls" type="button" role="tab" aria-selected="true" aria-controls="golens-tour-controls"><span class="tab-icon" aria-hidden="true"><img src="${brandIconUrl}" alt=""></span><span>Page controls</span></button>
            <button class="tour-tab" id="golens-tour-tab-go" type="button" role="tab" aria-selected="false" aria-controls="golens-tour-go" tabindex="-1"><span class="tab-icon" aria-hidden="true"><span class="tab-symbol">Go</span></span><span>Go intelligence</span></button>
            <button class="tour-tab" id="golens-tour-tab-diff" type="button" role="tab" aria-selected="false" aria-controls="golens-tour-diff" tabindex="-1"><span class="tab-icon" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M3 1.75h10M3 14.25h10M8 3.25v3.5m0-3.5L6.25 5M8 3.25 9.75 5M8 12.75v-3.5m0 3.5L6.25 11M8 12.75 9.75 11"></path></svg></span><span>Diff helpers</span></button>
            <button class="tour-tab" id="golens-tour-tab-popup" type="button" role="tab" aria-selected="false" aria-controls="golens-tour-popup" tabindex="-1"><span class="tab-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"></path><circle cx="16" cy="7" r="2"></circle><circle cx="8" cy="17" r="2"></circle></svg></span><span>Settings</span></button>
          </nav>
          <div class="tour-panels">
            <section class="tour-panel" id="golens-tour-controls" role="tabpanel" aria-labelledby="golens-tour-tab-controls" tabindex="0">
              <p class="chapter-label">Always beside GitLab’s AI panel</p>
              <h2>Review controls and celebrations</h2>
              <p class="chapter-intro">The compact strip stays beside GitLab’s AI panel throughout the review.</p>
              <ul class="feature-list">
                <li class="feature">${onboardingFeatureIcon('brand', { brandIconUrl })}<div><strong>Turn GoLens on or off</strong><p>The logo controls GoLens globally and syncs across open GitLab tabs.</p></div></li>
                  <li class="feature">${onboardingFeatureIcon('focus')}<div><strong>Enter fullscreen review focus</strong><p>Hide GitLab chrome, widen the diff, and leave with <kbd>Esc</kbd> or the focus button.</p></div></li>
                  <li class="feature">${onboardingFeatureIcon('download')}<div><strong>Cache related MR packages</strong><p>Fetch changed and related Go packages at the MR head, with progress and completion states.</p></div></li>
                  <li class="feature">${onboardingFeatureIcon('bookmark')}<div><strong>Keep local MR bookmarks</strong><p>Open the fourth control to revisit marked lines and ranges, clear current or stale entries, and recover only uniquely matched destinations after a head change.</p></div></li>
                  <li class="feature">${onboardingFeatureIcon('brand', { brandIconUrl })}<div><strong>Mark review milestones</strong><p>The mascot marks completed caches, resolved discussions, approvals, merges, and the Friday beer-kart celebration. Reduced motion stays static.</p></div></li>
              </ul>
            </section>
            <section class="tour-panel" id="golens-tour-go" role="tabpanel" aria-labelledby="golens-tour-tab-go" tabindex="0" hidden>
              <p class="chapter-label">Browser-native Go navigation</p>
              <h2>Inspect and follow symbols</h2>
              <p class="chapter-intro">Commit-pinned browser indexing provides safe navigation without speculative results.</p>
              <ul class="feature-list">
                <li class="feature">${onboardingFeatureIcon('hover')}<div><strong>Hover for Go insight</strong><p>See kind, signature, documentation, location, and usages for definitions. Type references show their complete struct or interface body, with a progressive reveal for long declarations.</p></div></li>
                <li class="feature">${onboardingFeatureIcon('navigate')}<div><strong>Navigate by click or shortcut</strong><p><kbd>Cmd</kbd>/<kbd>Ctrl</kbd>-click or <kbd>Cmd/Ctrl F12</kbd> resolves definitions, usages, and implementations.</p></div></li>
                <li class="feature">${onboardingFeatureIcon('search')}<div><strong>Select and revisit occurrences</strong><p>Plain-click highlights loaded-diff occurrences; configured shortcuts move between them.</p></div></li>
                <li class="feature">${onboardingFeatureIcon('inDiff')}<div><strong>Stay in the diff when possible</strong><p>Loaded targets scroll into view; other sources open at their exact destination.</p></div></li>
                <li class="feature">${onboardingFeatureIcon('navigate')}<div><strong>Retrace semantic jumps</strong><p>Move through in-diff semantic history without changing browser history.</p></div></li>
                <li class="feature">${onboardingFeatureIcon('copy')}<div><strong>Use the small popover tools</strong><p>Pin results, copy <span class="feature-note">file:line:column</span>, expand signatures, choose matches, or close with <kbd>Esc</kbd>.</p></div></li>
                <li class="feature">${onboardingFeatureIcon('search')}<div><strong>Check the search scope</strong><p>Results identify package, indexed-package, or complete-project coverage.</p></div></li>
                <li class="feature">${onboardingFeatureIcon('download')}<div><strong>Search the complete project explicitly</strong><p>Run cancellable commit-pinned search when current coverage is incomplete.</p></div></li>
                <li class="feature">${onboardingFeatureIcon('testDouble')}<div><strong>Separate test doubles</strong><p>Production implementations stay ahead of an expandable test-double group.</p></div></li>
              </ul>
            </section>
            <section class="tour-panel" id="golens-tour-diff" role="tabpanel" aria-labelledby="golens-tour-tab-diff" tabindex="0" hidden>
              <p class="chapter-label">Small helpers across the merge request</p>
              <h2>Move through large diffs faster</h2>
              <p class="chapter-intro">Small GitLab-native helpers keep large reviews moving.</p>
              <ul class="feature-list">
                <li class="feature">${onboardingFeatureIcon('rapid')}<div><strong>Use Rapid Diffs automatically</strong><p>GoLens enables GitLab’s Rapid Diffs opt-in when it is offered.</p></div></li>
                <li class="feature">${onboardingFeatureIcon('fullFile')}<div><strong>Show a full file</strong><p>Expand a file beyond changed lines, then return to changes-only.</p></div></li>
                <li class="feature">${onboardingFeatureIcon('search')}<div><strong>Reach file search from the keyboard</strong><p><kbd>Cmd/Ctrl P</kbd> focuses file search; <kbd>Shift F</kbd> clears it and returns.</p></div></li>
                <li class="feature">${onboardingFeatureIcon('inDiff')}<div><strong>Move by hunk or file</strong><p>Configured shortcuts move between hunks and files with a brief destination highlight.</p></div></li>
                <li class="feature">${onboardingFeatureIcon('bookmark')}<div><strong>Bookmark lines and ranges</strong><p>Use a gutter marker, select contiguous lines on one diff side, or configure toggle/previous/next bookmark shortcuts. Old and new sides stay distinct.</p></div></li>
                <li class="feature">${onboardingFeatureIcon('testFile')}<div><strong>Spot Go test files</strong><p><span class="feature-note">_test.go</span> files receive a subtle green file-tree label.</p></div></li>
                <li class="feature">${onboardingFeatureIcon('generated')}<div><strong>Optionally hide generated files</strong><p>Hide <span class="feature-note">.gitattributes</span>-marked files while keeping large collapsed files visible.</p></div></li>
                <li class="feature">${onboardingFeatureIcon('discussion')}<div><strong>Jump from overview discussions to code</strong><p><span class="feature-note">View in changes</span> opens the exact commented line.</p></div></li>
              </ul>
            </section>
            <section class="tour-panel" id="golens-tour-popup" role="tabpanel" aria-labelledby="golens-tour-tab-popup" tabindex="0" hidden>
              <p class="chapter-label">Open from the compact browser menu</p>
              <h2>Tabbed settings and cache control</h2>
              <p class="chapter-intro">Manage synchronized preferences, access, caching, and help.</p>
              <ul class="feature-list">
                <li class="feature">${onboardingFeatureIcon('settings')}<div><strong>Open the settings overlay</strong><p>The browser-menu gear opens settings over the active GitLab page; close with <kbd>Esc</kbd>, the button, or backdrop.</p></div></li>
                <li class="feature">${onboardingFeatureIcon('settings')}<div><strong>Set global review preferences</strong><p>Control global enablement, generated files, and contextual shortcut tips.</p></div></li>
                <li class="feature">${onboardingFeatureIcon('navigate')}<div><strong>Choose a familiar keymap</strong><p>Apply GoLens, VS Code, IntelliJ IDEA, or non-modal Vim-style bindings, then customize them. Contextual tips retire after successful use.</p></div></li>
                <li class="feature">${onboardingFeatureIcon('lock')}<div><strong>Approve self-hosted GitLab origins</strong><p>Add or remove each trusted HTTP(S) origin explicitly; GitLab.com works automatically.</p></div></li>
                <li class="feature">${onboardingFeatureIcon('download')}<div><strong>Cache the full project</strong><p>Broaden navigation beyond related MR packages with visible progress.</p></div></li>
                <li class="feature">${onboardingFeatureIcon('database')}<div><strong>Inspect or clear the source cache</strong><p>Review cache size and record counts, or remove all snapshots.</p></div></li>
                <li class="feature">${onboardingFeatureIcon('bookmark')}<div><strong>Keep bookmarks private</strong><p>Only minimal location metadata and context fingerprints are stored locally. Source excerpts are not stored with bookmarks or synchronized.</p></div></li>
                <li class="feature">${onboardingFeatureIcon('replay')}<div><strong>Replay this complete tour</strong><p>Open this feature guide again from Settings under Help.</p></div></li>
                <li class="feature">${onboardingFeatureIcon('lock')}<div><strong>Keep repository source local</strong><p>Source stays in your browser and signed-in GitLab origin, with commit-pinned same-origin requests.</p></div></li>
              </ul>
            </section>
          </div>
        </div>
        <footer class="footer">
          <button class="secondary" type="button" data-action="previous-onboarding" hidden>Back</button>
          <p class="tour-progress" data-tour-progress aria-live="polite">1 of 4 · Page controls</p>
          <button class="primary" type="button" data-action="next-onboarding">Next</button>
        </footer>
      </section>
    </div>
  `;
}

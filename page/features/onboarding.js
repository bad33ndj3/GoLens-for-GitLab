// page/features/onboarding.js — hides: first-run detection
// (golensOnboardingVersion), the setup wizard and quick-tour DOM, staged
// choices written through the settings-store, and the onboarding
// overlay-registry claim (ticket 15; boundary from ticket 03 §2, interface
// from ticket 04 §3 with the same close()-and-kind-discriminated-outcomes
// deviation ticket 16 documented for settings-overlay.js). Carved out of
// content.js following settings-overlay.js's pattern: mount(ctx) -> {
// unmount, show(), close() }, pure decision core in
// onboarding.internal.js, DOM/messaging in this shell.
//
// First-run and manually-triggered opening share one open(mode) path below
// (host creation, markup, registry claim, wiring) so the two can't drift
// out of sync on claim/release or on which settings keys a save writes to
// (ticket 15's acceptance criterion) — `overlays.claim('onboarding')` and
// `release?.()` each appear exactly once in this file. The two dialogs
// themselves stay distinct, matching content.js's former
// showSetupOnboarding()/showOnboarding(): first-run shows the 3-step setup
// wizard (keymap, generated files, essentials recap) and saves choices;
// show() (routed from 'golens-show-onboarding') shows the 4-chapter quick
// tour reference and saves nothing. Both use `#golens-onboarding-root` as
// their host id, so at most one can be open at a time.
//
// Routed via page/lifecycle (page/lifecycle/internal.js's FEATURE_ROUTES):
// 'golens-show-onboarding' -> show(). content.js keeps a thin ack-only
// ... no: bootstrap.js is now the sole responder for that message (see its
// own comments), since page/lifecycle's routed listener never calls
// sendResponse and content.js no longer owns onboarding.
//
// Mutual exclusion with settings (the reverse of settings-overlay.js's own
// 'golens-show-onboarding' listener, ticket 16): this module listens for
// 'golens-show-settings' and closes itself, applying the same bare
// isGitLab() guard content.js's own handler applied (not MR-specific,
// unlike this module's own show() guard) — a direct feature -> feature call
// would violate ticket 03 §3.
import { createOverlayRegistry } from '../platform/overlay-registry.js';
import {
  isGitLabPage,
  isMergeRequestPath,
  shouldShowFirstRun,
  setupDialogMarkup,
  tourDialogMarkup,
} from './onboarding.internal.js';

const ONBOARDING_VERSION = 11;
const ONBOARDING_STORAGE_KEY = 'golensOnboardingVersion';

export function mount(ctx = {}) {
  const doc = document;
  const win = window;
  const runtime = ctx.runtime !== undefined ? ctx.runtime : globalThis.chrome?.runtime;
  const overlays = ctx.overlays || createOverlayRegistry();
  const settings = ctx.settings;

  let unmounted = false;
  let host = null;
  let release = null;
  let returnFocus = null;

  function detectGitLab() {
    return isGitLabPage({
      hasGitlabGlobal: Boolean(win.gon?.gitlab_url),
      hasCsrfMeta: Boolean(doc.querySelector('meta[name="csrf-token"]')),
      hasAppShell: Boolean(doc.querySelector('.super-sidebar, [data-testid="super-sidebar"], #js-top-bar, .layout-page, .ai-panels')),
    });
  }

  function detectReviewPage() {
    return detectGitLab() && isMergeRequestPath(win.location.pathname);
  }

  function mascotUrl() {
    return runtime?.getURL ? runtime.getURL('assets/icons/golens-128.png') : 'assets/icons/golens-128.png';
  }

  function brandIconUrl() {
    return runtime?.getURL ? runtime.getURL('assets/icons/golens-32.png') : 'assets/icons/golens-32.png';
  }

  function shortcutPresetOptions() {
    const shortcuts = globalThis.GoLensShortcuts;
    const currentBindings = shortcuts?.mergeBindings(settings?.get('shortcutBindings')) || settings?.get('shortcutBindings');
    const currentPreset = shortcuts?.presetForBindings(currentBindings) || 'custom';
    const presetOptionsHtml = (shortcuts?.presets || []).map((preset) => `
      <label class="choice-card">
        <input type="radio" name="keymap" value="${preset.id}" ${currentPreset === preset.id ? 'checked' : ''}>
        <span><strong>${preset.label}</strong><small>${preset.description}${preset.id === 'vim' ? '. Shortcuts only, without modes or command sequences.' : ''}</small></span>
      </label>
    `).join('');
    const customOptionHtml = currentPreset === 'custom' ? `
      <label class="choice-card">
        <input type="radio" name="keymap" value="custom" checked>
        <span><strong>Keep current shortcuts</strong><small>Your customized bindings will not be replaced.</small></span>
      </label>
    ` : '';
    return { currentPreset, presetOptionsHtml, customOptionHtml, shortcuts };
  }

  // close(opts) -> { kind: 'closed' | 'not-open' } — the sole close path for
  // every route: Esc, backdrop click, close button, unmount, and the
  // 'golens-show-settings' mutual-exclusion listener.
  function close({ restoreFocus = true } = {}) {
    if (!host) return { kind: 'not-open' };
    host.remove();
    host = null;
    release?.();
    release = null;
    if (restoreFocus) returnFocus?.focus?.();
    returnFocus = null;
    return { kind: 'closed' };
  }

  function wireSetupPanel(shadow, { shortcuts, currentPreset }) {
    const panels = [...shadow.querySelectorAll('[data-setup-panel]')];
    const previousButton = shadow.querySelector('[data-action="previous-onboarding"]');
    const primaryButton = shadow.querySelector('[data-action="next-onboarding"]');
    const progress = shadow.querySelector('[data-tour-progress]');
    const labels = ['Keyboard', 'Diff display', 'Ready'];
    let activePage = 0;
    const showPage = (index) => {
      activePage = Math.max(0, Math.min(panels.length - 1, index));
      panels.forEach((panel, panelIndex) => { panel.hidden = panelIndex !== activePage; });
      previousButton.hidden = activePage === 0;
      primaryButton.textContent = activePage === panels.length - 1 ? 'Save and start reviewing' : 'Continue';
      progress.textContent = `${activePage + 1} of ${panels.length} · ${labels[activePage]}`;
      panels[activePage].querySelector('input:checked, input, button')?.focus();
    };
    const save = async () => {
      const presetID = shadow.querySelector('input[name="keymap"]:checked')?.value || currentPreset;
      const hideGeneratedFiles = shadow.querySelector('input[name="generated-files"]:checked')?.value === 'hide';
      const nextSettings = { hideGeneratedFiles };
      if (presetID !== 'custom') nextSettings.shortcutBindings = shortcuts.presetBindings(presetID);
      primaryButton.disabled = true;
      try {
        await Promise.all(Object.entries(nextSettings).map(([key, value]) => settings.set(key, value)));
        close();
      } catch (error) {
        shadow.querySelector('[data-setup-status]').textContent = error.message || 'Unable to save these choices.';
        primaryButton.disabled = false;
      }
    };
    shadow.querySelector('[data-action="close-onboarding"]').addEventListener('click', () => close());
    shadow.querySelector('[data-action="backdrop"]').addEventListener('click', (event) => { if (event.target === event.currentTarget) close(); });
    previousButton.addEventListener('click', () => showPage(activePage - 1));
    primaryButton.addEventListener('click', () => { if (activePage === panels.length - 1) void save(); else showPage(activePage + 1); });
    shadow.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); return; }
      if (event.key !== 'Tab') return;
      const focusable = [...shadow.querySelectorAll('button,input')].filter((element) => !element.disabled && !element.hidden && !element.closest('[hidden]'));
      const index = focusable.indexOf(shadow.activeElement);
      const next = event.shiftKey ? (index <= 0 ? focusable.length - 1 : index - 1) : (index === focusable.length - 1 ? 0 : index + 1);
      event.preventDefault();
      focusable[next].focus();
    });
    showPage(0);
  }

  function wireTourPanel(shadow) {
    const closeButton = shadow.querySelector('[data-action="close-onboarding"]');
    const tabs = [...shadow.querySelectorAll('[role="tab"]')];
    const panels = [...shadow.querySelectorAll('[role="tabpanel"]')];
    const previousButton = shadow.querySelector('[data-action="previous-onboarding"]');
    const primaryButton = shadow.querySelector('[data-action="next-onboarding"]');
    const progress = shadow.querySelector('[data-tour-progress]');
    let activePage = 0;
    const showPage = (index, { focusTab = false } = {}) => {
      activePage = Math.max(0, Math.min(tabs.length - 1, index));
      tabs.forEach((tab, tabIndex) => {
        const active = tabIndex === activePage;
        tab.setAttribute('aria-selected', String(active));
        tab.tabIndex = active ? 0 : -1;
      });
      panels.forEach((panel, panelIndex) => { panel.hidden = panelIndex !== activePage; });
      previousButton.hidden = activePage === 0;
      primaryButton.textContent = activePage === tabs.length - 1 ? 'Start reviewing' : 'Next';
      progress.textContent = `${activePage + 1} of ${tabs.length} · ${tabs[activePage].lastElementChild.textContent.trim()}`;
      if (focusTab) tabs[activePage].focus();
    };
    closeButton.addEventListener('click', () => close());
    tabs.forEach((tab, index) => tab.addEventListener('click', () => showPage(index)));
    previousButton.addEventListener('click', () => showPage(activePage - 1));
    primaryButton.addEventListener('click', () => {
      if (activePage === tabs.length - 1) close();
      else showPage(activePage + 1);
    });
    shadow.querySelector('[data-action="backdrop"]').addEventListener('click', (event) => {
      if (event.target === event.currentTarget) close();
    });
    shadow.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      if (event.target.getAttribute?.('role') === 'tab' && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const nextPage = event.key === 'Home'
          ? 0
          : event.key === 'End'
          ? tabs.length - 1
          : activePage + (event.key === 'ArrowRight' ? 1 : -1);
        showPage((nextPage + tabs.length) % tabs.length, { focusTab: true });
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [closeButton, ...tabs, previousButton, ...panels, primaryButton]
        .filter((element) => !element.disabled && !element.hidden && !element.closest('[hidden]') && element.tabIndex >= 0);
      const index = focusable.indexOf(shadow.activeElement);
      const next = event.shiftKey
        ? (index <= 0 ? focusable.length - 1 : index - 1)
        : (index === focusable.length - 1 ? 0 : index + 1);
      event.preventDefault();
      focusable[next].focus();
    });
    showPage(0);
    primaryButton.focus();
  }

  // open(mode) — the one host-creation, markup, claim and wiring path for
  // mode in {'setup', 'tour'}. Callers are responsible for checking `host`
  // first: this function always creates a fresh host and claims the
  // registry once, unconditionally.
  function open(mode) {
    returnFocus = doc.activeElement;
    host = doc.createElement('div');
    host.id = 'golens-onboarding-root';
    const shadow = host.attachShadow({ mode: 'open' });
    const preset = mode === 'setup' ? shortcutPresetOptions() : null;
    shadow.innerHTML = mode === 'setup'
      ? setupDialogMarkup({
          mascotUrl: mascotUrl(),
          brandIconUrl: brandIconUrl(),
          customOptionHtml: preset.customOptionHtml,
          presetOptionsHtml: preset.presetOptionsHtml,
          hideGeneratedFiles: Boolean(settings?.get('hideGeneratedFiles')),
        })
      : tourDialogMarkup({ mascotUrl: mascotUrl(), brandIconUrl: brandIconUrl() });
    doc.body.append(host);
    release = overlays.claim('onboarding');
    if (mode === 'setup') wireSetupPanel(shadow, preset);
    else wireTourPanel(shadow);
  }

  // show() -> { kind: 'shown' | 'already-open' | 'not-gitlab' } — opens the
  // quick-tour reference. Routed from 'golens-show-onboarding'; bootstrap.js
  // answers popup.js's/settings.js's request with this outcome (ticket 16
  // precedent: a silent early return is indistinguishable from success at
  // that seam, which is why every outcome is a value, never a bare return).
  function show() {
    if (host) {
      host.shadowRoot?.querySelector('[role="tab"][aria-selected="true"]')?.focus();
      return { kind: 'already-open' };
    }
    if (!detectReviewPage()) return { kind: 'not-gitlab' };
    open('tour');
    return { kind: 'shown' };
  }

  function onRuntimeMessage(message) {
    if (message?.type !== 'golens-show-settings') return;
    if (!detectGitLab()) return;
    close();
  }
  runtime?.onMessage?.addListener(onRuntimeMessage);

  // First-run: content.js's showFirstRunOnboarding() ran inside
  // reconcilePage(), past an isGitLab()/isMergeRequest() guard and after
  // settingsStore.ready() had already resolved. mount() here runs
  // synchronously on every page/main.js mount (i.e. on every SPA
  // navigation bootstrap.js observes, including non-MR ones), so the same
  // guard is applied here, after settings.ready() resolves. `host` is
  // re-checked in case show() already opened the tour while this was
  // pending — first-run must not clobber it.
  if (settings) {
    settings.ready().then(() => {
      if (unmounted || host) return;
      if (!detectReviewPage()) return;
      if (!shouldShowFirstRun(settings.get(ONBOARDING_STORAGE_KEY), ONBOARDING_VERSION)) return;
      open('setup');
      settings.set(ONBOARDING_STORAGE_KEY, ONBOARDING_VERSION);
    });
  }

  return {
    unmount() {
      if (unmounted) return;
      unmounted = true;
      runtime?.onMessage?.removeListener(onRuntimeMessage);
      close({ restoreFocus: false });
    },
    show,
    close,
  };
}

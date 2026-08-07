// page/features/code-intel.js — hides: hover/click resolution and its
// debouncing, the popover DOM and its render functions, occurrence
// highlighting in the diff view, and reference/implementation navigation.
// Carved out of go-navigation.js's hover/click handlers, `showResult` and
// its rendering helpers, `resolveAt`/`findReferencesAt`/
// `findImplementationsAt`, and the occurrence-highlighting functions. Pure
// classification/presentation core in code-intel.internal.js; DOM,
// debouncing, and resolution orchestration in this shell.
//
// mount(ctx) -> { unmount, setEnabled(bool), navigationAction(name) ->
// boolean, ...six self-bridge-only extras — see the return statement below }.
//
// This module needs a `legacy` capability bag — diff-DOM primitives
// (fileContextFor/lineContextFor/codeCellFor/diffFileRoots), package/project
// loading and worker RPC (loadPackage/preloadMergeRequest/
// mergeRequestRefsForFile/mergeRequestIID/sourceRefFor/dirname/workerRPC),
// URL builders (projectContext/documentationURL/projectPackageURL), the
// shared "reveal a location in the diff" primitives also used by bookmarks.js
// (visibleDiffRootForDefinition/navigateToLocation), the shared toast
// surface (toast), the shortcut-coach bridge (offerShortcutCoach), the
// frame-throttle clock (requestFrame), and project-search's orchestration
// entry points (searchCompleteProject/cancelSearch). `page/main.js` builds
// this bag directly from `page/platform/diff-dom.js`/`gitlab-api.js`,
// `page/lifecycle/mr-session.js`'s shared instances, and late-bound accessors
// onto the mr-preload/project-search handles — this is the only mounted
// instance. This module in turn now EXPOSES `showSearchProgress(message,
// pointer)` on its own handle, so project-search.js can drive the popover's
// dismiss-proof inline loading state ('searching' mode) while a
// complete-project search is in flight.
//
// Toast-surface decision: the shared instance page/lifecycle/mr-session.js
// now owns, reached through `legacy.toast`. The toast host is a shared
// surface across features precisely because giving each feature its own toast
// element risks two toasts showing at once; moving it into code-intel.js would
// additionally make keyboard-nav.js, bookmarks.js, and project-search.js —
// three sibling features, none of them code-intel — depend on this module's
// private DOM, which the module architecture forbids (feature -> feature calls
// are not allowed). go-navigation.js itself no longer calls it directly
// (code-intel.js now owns every call site that used to live there), but
// multiple other consumers still reach it through go-navigation.js. The
// surface will stay in place until go-navigation.js itself becomes an ES
// module.
//
// Popover DOM (`#golens-go-intelligence-root`) is now fully private to this
// module — physically split out of go-navigation.js's former single shared
// shadow host, which also held the `.toast` markup. go-navigation.js's own
// `ensureUI()` shrank to a toast-only host (a different id) so the toast
// surface above keeps working without this module's popover DOM as a
// dependency. `tests/browser-smoke.mjs` already reads the popover through
// `#golens-go-intelligence-root` by id (unaffected: the id itself didn't
// move) — see this module's own render functions below for the markup,
// trimmed of the `.toast` section and its CSS.
import {
  identifierAtCharacter,
  caretElementMatchesIdentifier,
  isWholeIdentifier,
  identifierBoundary,
  referenceNavigationAction,
  isInterfaceDeclaration,
  shouldShowReferencesOnHover,
  classify,
  symbolPresentation,
  implementationGroups,
  resultScopeText,
  absenceText,
  destinationLineForDefinition,
  locationKey,
  sourceLocationText,
  loadingPhaseLabel,
  groupLocationsByFile,
  tokenizeSignature,
} from './code-intel.internal.js';

const POPOVER_DISMISS_DELAY = 450;
const FULL_TYPE_BODY_INITIAL_LINES = 40;
const DIFF_ROOT_SELECTOR = 'diff-file, .diff-file, [data-testid="diff-file"], [data-testid="rd-diff-file"], [data-file-path]';
// The trailing `code.gl-absolute div.line` clause matches blob-dom.js's
// `codeCellFor`'s real, highlighted `div.line#LC{n}` cells — the same
// `HIGHLIGHT_SELECTOR` scoping blob-dom.js's own codeCellFor uses to pick
// real lines over the transparent hit-test overlay above them.
const CODE_CELL_SELECTOR = 'td.line_content, td[class*="line-content"], [data-testid="diff-line-content"], [data-testid="rd-diff-line-content"], .rd-diff-code, .rd-diff-line-code, code.gl-absolute div.line';

const MARKUP = `
  <style>
    :host { all:initial; position:fixed; z-index:var(--golens-z-popover); inset:0; pointer-events:none; font:12.5px/1.5 var(--golens-font-sans); color-scheme:dark; }
    * { box-sizing:border-box; }
    .popover { position:fixed; display:none; width:min(440px,calc(100vw - 24px)); max-height:min(420px,calc(100vh - 24px)); overflow:hidden; border:1px solid var(--golens-border-default); border-radius:8px; background:var(--golens-surface-panel); box-shadow:var(--golens-shadow-lg); color:var(--golens-text-primary); pointer-events:auto; }
    .popover.show { display:grid; grid-template-rows:auto minmax(0,1fr); }
    .popover.popover--list { width:min(560px,calc(100vw - 24px)); height:320px; max-height:min(320px,calc(100vh - 24px)); }
    .popover-header { display:grid; grid-template-columns:auto minmax(0,1fr) auto; gap:var(--golens-space-2); align-items:start; padding:10px var(--golens-space-3) 9px; border-bottom:1px solid var(--golens-border-subtle); background:var(--golens-surface-raised); }
    .popover-heading { min-width:0; padding-top:1px; }
    .popover-title { overflow:hidden; color:var(--golens-text-primary); font:600 12.5px/1.3 var(--golens-font-mono); letter-spacing:-.01em; text-overflow:ellipsis; white-space:nowrap; }
    .location { overflow:hidden; margin-top:3px; color:var(--golens-text-muted); font:10.5px/1.3 var(--golens-font-mono); text-overflow:ellipsis; white-space:nowrap; }
    .popover-body { display:flex; flex-direction:column; gap:var(--golens-space-3); min-height:0; overflow:auto; padding:var(--golens-space-3); }
    /* Flex children with their own overflow!=visible (.signature-block, .choices below)
       get an automatic min-size of 0 in a flex container, so without flex-shrink:0
       they silently shrink/clip below their content on a long struct/choice list
       instead of letting .popover-body's own overflow:auto scroll. */
    .symbol-badge { display:inline-flex; min-width:19px; height:18px; align-items:center; justify-content:center; padding:0 4px; margin-top:1px; border-radius:3px; background:color-mix(in srgb,currentColor 18%,transparent); font:700 9px/1 var(--golens-font-mono); letter-spacing:-.01em; }
    .symbol-interface,.symbol-interface-method { color:#c586c0; } .symbol-struct { color:#59a869; } .symbol-function { color:#dcdcaa; } .symbol-method,.symbol-type { color:#4ec9b0; } .symbol-variable,.symbol-parameter,.symbol-field { color:#9cdcfe; } .symbol-constant { color:#4fc1ff; } .symbol-package { color:#fc9b6b; } .symbol-external { color:#3794ff; }
    .header-actions { display:flex; align-items:center; gap:1px; }
    .header-action { display:inline-flex; width:24px; height:24px; align-items:center; justify-content:center; padding:0; border:1px solid transparent; border-radius:4px; background:transparent; color:var(--golens-text-muted); cursor:pointer; transition:background-color var(--golens-motion-fast),color var(--golens-motion-fast); }
    .header-action:hover { background:var(--golens-surface-hover); color:var(--golens-text-primary); } .header-action:active { background:var(--golens-surface-pressed); } .header-action:disabled { cursor:not-allowed; opacity:.45; } .header-action[hidden] { display:none; } .header-action svg { width:13px; height:13px; fill:none; stroke:currentColor; stroke-linecap:round; stroke-linejoin:round; stroke-width:1.75; }
    .copy-button .check-icon { display:none; } .copy-button[data-state="copied"] { background:var(--golens-success-soft); color:var(--golens-success); } .copy-button .copy-icon { display:block; } .copy-button[data-state="copied"] .copy-icon { display:none; } .copy-button[data-state="copied"] .check-icon { display:block; }
    .signature-block { flex-shrink:0; overflow:hidden; border:1px solid var(--golens-border-subtle); border-radius:4px; background:var(--golens-surface-inset); } .signature-block[hidden] { display:none; }
    .signature { margin:0; padding:var(--golens-space-2) var(--golens-space-3); overflow-wrap:anywhere; color:#a9b7c6; font:500 11px/1.5 var(--golens-font-mono); white-space:pre-wrap; }
    .tok-kw,.tok-type { color:#61afef; } .tok-builtin { color:#d19a66; } .tok-func { color:#ffc66d; } .tok-param { color:#a9b7c6; } .tok-str { color:#6a8759; } .tok-num { color:#6897bb; } .tok-comment { color:#808080; font-style:italic; } .tok-punct { color:#a9b7c6; }
    .signature-toggle { width:100%; padding:6px var(--golens-space-3); border:0; border-top:1px solid var(--golens-border-subtle); background:transparent; color:var(--golens-info-hover); font:600 10px/1.4 var(--golens-font-mono); text-align:left; cursor:pointer; } .signature-toggle:hover { color:var(--golens-text-primary); } .signature-toggle:active { opacity:.8; } .signature-toggle:disabled { cursor:not-allowed; opacity:.45; } .signature-toggle[hidden] { display:none; }
    .docs:empty,.scope[hidden],.shortcut-hint[hidden] { display:none; }
    .docs { margin:0; color:var(--golens-text-secondary); line-height:1.55; white-space:pre-wrap; }
    .scope { margin:0; color:var(--golens-text-muted); font:10.5px/1.4 var(--golens-font-mono); }
    .choices { display:flex; flex-direction:column; flex-shrink:0; overflow:hidden; border:1px solid var(--golens-border-subtle); border-radius:4px; background:var(--golens-surface-inset); }
    .choices:empty { display:none; }
    .choices.choices--flush { overflow:visible; border:0; border-radius:0; background:transparent; }
    .choice { position:relative; display:grid; grid-template-columns:minmax(0,1fr) auto; gap:var(--golens-space-2); width:100%; min-height:36px; align-items:center; padding:6px var(--golens-space-3); border:0; border-bottom:1px solid var(--golens-border-subtle); background:transparent; color:var(--golens-text-primary); text-align:left; cursor:pointer; transition:background-color var(--golens-motion-fast); }
    .choice:last-child { border-bottom:0; }
    .choice:hover { background:var(--golens-info-soft); box-shadow:inset 2px 0 0 var(--golens-info); } .choice:active { background:var(--golens-surface-pressed); } .choice:disabled { cursor:not-allowed; opacity:.45; } .choice:focus-visible,.header-action:focus-visible,.signature-toggle:focus-visible,summary:focus-visible { outline:2px solid var(--golens-focus-ring); outline-offset:-2px; }
    .choice-copy { min-width:0; } .choice-heading { display:flex; min-width:0; align-items:center; gap:7px; }
    .choice-title { overflow:hidden; color:var(--golens-text-primary); font:600 11.5px/1.3 var(--golens-font-mono); text-overflow:ellipsis; white-space:nowrap; }
    .choice-context { display:block; margin-top:2px; overflow:hidden; color:var(--golens-text-muted); font:10px/1.35 var(--golens-font-mono); text-overflow:ellipsis; white-space:nowrap; }
    .choice-doc { display:block; margin-top:3px; overflow:hidden; color:var(--golens-text-secondary); font-size:10px; text-overflow:ellipsis; white-space:nowrap; }
    .destination-icon { position:relative; display:inline-flex; width:20px; height:20px; flex:0 0 auto; align-items:center; justify-content:center; border-radius:3px; }
    .destination-icon svg { width:14px; height:14px; } .destination-in-diff { color:var(--golens-primary); } .destination-new-tab { color:var(--golens-info); }
    .choice:hover .destination-icon::after,.choice:focus-visible .destination-icon::after { position:absolute; z-index:2; right:-4px; bottom:calc(100% + 7px); width:max-content; max-width:180px; padding:var(--golens-space-1) var(--golens-space-2); border:1px solid var(--golens-border-strong); border-radius:3px; background:var(--golens-surface-raised); box-shadow:var(--golens-shadow-sm); color:var(--golens-text-primary); content:attr(data-tooltip); font:10px/1.3 var(--golens-font-sans); pointer-events:none; }
    details { border-top:1px solid var(--golens-border-subtle); } summary { padding:6px var(--golens-space-3); color:var(--golens-text-muted); font:10.5px/1.4 var(--golens-font-mono); cursor:pointer; } summary:hover { color:var(--golens-text-primary); } .test-double-choices { display:flex; flex-direction:column; }
    .shortcut-hint { display:flex; align-items:center; gap:5px; padding-top:var(--golens-space-1); color:var(--golens-text-muted); font-size:10px; } kbd { display:inline-flex; min-width:16px; min-height:16px; align-items:center; justify-content:center; padding:1px 3px; border:1px solid var(--golens-border-strong); border-bottom-width:2px; border-radius:3px; background:var(--golens-surface-inset); color:var(--golens-text-primary); font:700 9px/1 var(--golens-font-mono); }
    .popover-header:has(.usages-count:not([hidden])) { grid-template-columns:auto minmax(0,1fr) auto auto; }
    .usages-count { display:flex; flex:0 0 auto; align-items:center; gap:5px; margin-top:2px; padding:2px 7px; border-radius:99px; background:var(--golens-surface-hover); color:var(--golens-text-muted); font:600 10px/1.4 var(--golens-font-mono); font-variant-numeric:tabular-nums; white-space:nowrap; } .usages-count[hidden] { display:none; }
    .usages-count.is-loading { color:var(--golens-primary-hover); background:var(--golens-primary-soft); }
    .usages-spinner { width:9px; height:9px; border:1.5px solid color-mix(in srgb,currentColor 35%,transparent); border-top-color:currentColor; border-radius:50%; animation:golens-spin .7s linear infinite; }
    @keyframes golens-spin { to { transform:rotate(360deg); } }
    .usage-group + .usage-group { margin-top:2px; border-top:1px solid var(--golens-border-subtle); }
    .usage-group-file { position:sticky; top:0; z-index:1; display:flex; align-items:baseline; gap:6px; padding:5px var(--golens-space-3) 4px; background:var(--golens-surface-panel); color:var(--golens-text-primary); font:600 10.5px/1.3 var(--golens-font-mono); }
    .usage-group-path { overflow:hidden; flex:1 1 auto; color:var(--golens-text-muted); font-weight:500; text-overflow:ellipsis; white-space:nowrap; }
    .usage-dest { flex:0 0 auto; display:inline-flex; } .usage-dest svg { width:12px; height:12px; } .usage-dest.destination-in-diff { color:var(--golens-primary); } .usage-dest.destination-new-tab { color:var(--golens-info); }
    .usage-row { display:grid; grid-template-columns:28px minmax(0,1fr); gap:8px; width:100%; padding:2px var(--golens-space-3) 2px calc(var(--golens-space-3) + 6px); border:0; background:transparent; color:var(--golens-text-secondary); text-align:left; cursor:pointer; font:11px/1.6 var(--golens-font-mono); }
    .usage-row:hover { background:var(--golens-info-soft); box-shadow:inset 2px 0 0 var(--golens-info); } .usage-row:focus-visible { outline:2px solid var(--golens-focus-ring); outline-offset:-2px; }
    .usage-line { color:var(--golens-text-muted); font-variant-numeric:tabular-nums; text-align:right; }
    .usage-snippet { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .usage-snippet .hl { border-radius:2px; background:color-mix(in srgb,var(--golens-primary) 30%,transparent); color:var(--golens-text-primary); }
    .usage-row-skeleton { display:grid; grid-template-columns:28px minmax(0,1fr); gap:8px; padding:4px var(--golens-space-3) 4px calc(var(--golens-space-3) + 6px); }
    .usage-row-skeleton i { display:block; height:9px; border-radius:3px; background:var(--golens-surface-hover); }
    .usage-row-skeleton i:first-child { width:16px; }
    .usage-row-skeleton:nth-child(1) i:last-child { width:78%; }
    .usage-row-skeleton:nth-child(2) i:last-child { width:52%; }
    .popover-body.usages-body { gap:0; padding:var(--golens-space-1) 0; scrollbar-color:var(--golens-border-strong) transparent; scrollbar-width:thin; }
    .popover-body.usages-body::-webkit-scrollbar { width:9px; }
    .popover-body.usages-body::-webkit-scrollbar-thumb { border:2px solid var(--golens-surface-panel); border-radius:99px; background:var(--golens-border-strong); }
    .choice--compact { display:flex; min-height:0; align-items:center; gap:6px; padding:4px var(--golens-space-3); overflow:hidden; }
    .choice--compact .symbol-badge { flex:0 0 auto; margin-top:0; }
    .choice--compact .choice-title { flex:0 1 auto; font-size:11px; }
    .choice--compact .choice-inline-path { overflow:hidden; flex:1 1 auto; margin-left:2px; color:var(--golens-text-muted); font:10px/1.3 var(--golens-font-mono); text-overflow:ellipsis; white-space:nowrap; }
    .choice--compact .destination-icon { flex:0 0 auto; width:14px; height:14px; } .choice--compact .destination-icon svg { width:12px; height:12px; }
    @media (prefers-reduced-motion:reduce) { .header-action,.choice,.loading-track > i,.usages-spinner { transition:none; animation:none; } .header-action:active,.choice:active { transform:none; } }
  </style>
  <section class="popover" role="tooltip" aria-labelledby="golens-popover-title">
    <header class="popover-header"><span class="symbol-badge symbol-external" role="img" aria-label="Go symbol" title="Go symbol">Go</span><div class="popover-heading"><div id="golens-popover-title" class="popover-title"></div><div class="location"></div></div><div class="usages-count" hidden></div><div class="header-actions"><button class="header-action copy-button" type="button" aria-label="Copy source location" title="Copy source location" hidden><svg class="copy-icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="5.25" y="5.25" width="8" height="8" rx="1.25"/><path d="M10.75 5.25V3.5c0-.7-.55-1.25-1.25-1.25h-6c-.7 0-1.25.55-1.25 1.25v6c0 .7.55 1.25 1.25 1.25h1.75"/></svg><svg class="check-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8.25 3.15 3.15L13 4.6"/></svg></button><button class="header-action close-button" type="button" aria-label="Close Go insight" title="Close" hidden><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3l10 10M13 3 3 13"/></svg></button></div></header>
    <div class="popover-body"><div class="docs"></div><div class="signature-block" hidden><pre id="golens-go-signature" class="signature"></pre><button class="signature-toggle" type="button" aria-controls="golens-go-signature" aria-expanded="false" hidden>Show full signature</button></div><div class="scope" hidden></div><div class="choices"></div><div class="shortcut-hint"><kbd>⌘</kbd><span>or Ctrl + click to go to definition</span></div></div>
  </section>
`;

const ESCAPE_GUARD_SELECTOR = 'input, textarea, select, [contenteditable], dialog, [role="dialog"], [aria-modal="true"]';

export function mount(ctx = {}) {
  const doc = document;
  const win = window;
  const legacy = ctx.legacy || null;

  let unmounted = false;
  let enabled = false;
  let ui = null;
  let hoverTimer = null;
  let popoverDismissTimer = null;
  let popoverMode = 'hidden';
  let popoverTargetKey = '';
  let pinnedPopover = false;
  let pinnedTargetKey = '';
  let activeTarget = null;
  let activeElement = null;
  let lastErrorToast = '';
  let selectedIdentifier = '';
  let occurrences = [];
  let occurrenceIndex = -1;
  let occurrenceRefreshTimer = null;
  let diffObserver = null;
  let diffMutationTimer = null;
  let history = [];
  let historyIndex = -1;

  function noLegacy(fallback) {
    return () => Promise.resolve(fallback);
  }

  // --- popover DOM (private, lazily created) ------------------------------

  function ensureUI() {
    if (ui?.isConnected) return ui.shadowRoot;
    const host = doc.createElement('div');
    host.id = 'golens-go-intelligence-root';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = MARKUP;
    doc.body.append(host);
    ui = host;
    const popover = shadow.querySelector('.popover');
    popover.addEventListener('pointerenter', () => { if (popoverMode !== 'searching') pinPopover(); });
    popover.addEventListener('pointerdown', () => { if (popoverMode !== 'searching') pinPopover(); });
    popover.addEventListener('focusin', () => { if (popoverMode !== 'searching') pinPopover(); });
    popover.addEventListener('keydown', onPopoverKeyDown);
    popover.querySelector('.copy-button').addEventListener('click', (event) => copySourceLocation(event.currentTarget));
    popover.querySelector('.close-button').addEventListener('click', () => {
      if (popoverMode === 'searching') legacy.cancelSearch?.();
      hidePopover();
    });
    return shadow;
  }

  // --- source-location text / copy ----------------------------------------

  function sourceLocationForTarget(target) {
    if (!target?.cell || !Number.isInteger(target.character)) return null;
    const file = legacy.fileContextFor(target.cell);
    const line = legacy.lineContextFor(target.cell);
    if (!file || !line) return null;
    return {
      path: line.side === 'old' ? file.oldPath : file.newPath,
      line: line.line,
      character: target.character + 1,
      side: line.side,
    };
  }

  function configureSourceCopy(button, sourceLocation = null) {
    const text = sourceLocationText(sourceLocation);
    button.hidden = !text;
    button.dataset.copyText = text;
    button.dataset.state = 'idle';
    button.setAttribute('aria-label', text ? `Copy source location ${text}` : 'Copy source location');
    button.title = text ? `Copy ${text}` : 'Copy source location';
  }

  function fallbackCopyText(text) {
    const textarea = doc.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none;';
    doc.body.append(textarea);
    textarea.select();
    const copied = doc.execCommand?.('copy') === true;
    textarea.remove();
    if (!copied) throw new Error('Clipboard access is unavailable.');
  }

  async function writeClipboardText(text) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API is unavailable.');
      await navigator.clipboard.writeText(text);
    } catch {
      fallbackCopyText(text);
    }
  }

  async function copySourceLocation(button) {
    const text = button.dataset.copyText;
    if (!text) return;
    try {
      await writeClipboardText(text);
      button.dataset.state = 'copied';
      button.setAttribute('aria-label', `Copied source location ${text}`);
      button.title = `Copied ${text}`;
      legacy.toast(`Copied ${text}`);
      setTimeout(() => {
        if (button.dataset.copyText !== text) return;
        button.dataset.state = 'idle';
        button.setAttribute('aria-label', `Copy source location ${text}`);
        button.title = `Copy ${text}`;
      }, 1800);
    } catch {
      legacy.toast('Could not copy the source location.');
    }
  }

  // --- popover positioning / mode ------------------------------------------

  function positionPopover(popover, x, y) {
    const margin = 12;
    const gap = 12;
    const bounds = popover.getBoundingClientRect();
    const width = bounds.width || Math.min(460, innerWidth - margin * 2);
    const height = bounds.height || Math.min(420, innerHeight - margin * 2);
    const left = Math.max(margin, Math.min(x + gap, innerWidth - width - margin));
    const below = y + 18;
    const top = below + height <= innerHeight - margin
      ? below
      : Math.max(margin, y - height - gap);
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
  }

  function targetKey(target) {
    if (!target) return '';
    return `${target.cell ? legacy.fileContextFor(target.cell)?.path : ''}:${target.cell ? legacy.lineContextFor(target.cell)?.line : ''}:${target.character ?? ''}`;
  }

  function cancelPopoverDismissal() {
    clearTimeout(popoverDismissTimer);
    popoverDismissTimer = null;
  }

  function setPopoverMode(mode, target = null) {
    cancelPopoverDismissal();
    const popover = ui?.shadowRoot.querySelector('.popover');
    const key = targetKey(target);
    if (key) popoverTargetKey = key;
    popoverMode = mode;
    pinnedPopover = mode === 'pinned' || mode === 'searching';
    if (pinnedPopover) pinnedTargetKey = key || popoverTargetKey;
    else pinnedTargetKey = '';
    if (!popover) return;
    popover.dataset.mode = mode;
    popover.setAttribute('role', pinnedPopover ? 'dialog' : 'tooltip');
    if (pinnedPopover) popover.setAttribute('aria-modal', 'false');
    else popover.removeAttribute('aria-modal');
    popover.querySelector('.close-button').hidden = !pinnedPopover;
  }

  function clearPinnedPopover() {
    if (popoverMode === 'hidden') {
      cancelPopoverDismissal();
      pinnedPopover = false;
      pinnedTargetKey = '';
      return;
    }
    setPopoverMode('passive');
  }

  function pinPopover(target = null) {
    const popover = ui?.shadowRoot.querySelector('.popover');
    if (!popover?.classList.contains('show')) return;
    setPopoverMode('pinned', target);
  }

  function schedulePassivePopoverDismissal() {
    if (popoverMode !== 'passive' || popoverDismissTimer) return false;
    popoverDismissTimer = setTimeout(hidePopover, POPOVER_DISMISS_DELAY);
    return true;
  }

  function hidePopover() {
    cancelPopoverDismissal();
    popoverMode = 'hidden';
    popoverTargetKey = '';
    pinnedPopover = false;
    pinnedTargetKey = '';
    const popover = ui?.shadowRoot.querySelector('.popover');
    popover?.classList.remove('show');
    if (popover) {
      popover.dataset.mode = 'hidden';
      popover.setAttribute('role', 'tooltip');
      popover.removeAttribute('aria-modal');
      popover.querySelector('.close-button').hidden = true;
    }
  }

  function eventIsInsideUI(event) {
    return Boolean(ui && event.composedPath().includes(ui));
  }

  function dismissPinnedPopoverFromOutside(event) {
    if (popoverMode === 'searching') return false;
    if (!pinnedPopover || eventIsInsideUI(event)) return false;
    hidePopover();
    return true;
  }

  // --- symbol badges / signature / destination -----------------------------

  function applySymbolBadge(element, kind) {
    const presentation = symbolPresentation(kind);
    element.className = `symbol-badge symbol-${presentation.className}`;
    element.textContent = presentation.badge;
    element.setAttribute('aria-label', presentation.label);
    element.title = presentation.label;
    return element;
  }

  function createSymbolBadge(kind) {
    const badge = doc.createElement('span');
    badge.setAttribute('role', 'img');
    return applySymbolBadge(badge, kind);
  }

  // paintSignatureText(element, text) -> replaces `element`'s children with
  // syntax-colored spans from tokenizeSignature(text) (code-intel.internal.js),
  // instead of the former plain textContent assignment.
  function paintSignatureText(element, text) {
    element.replaceChildren();
    for (const { text: chunk, cls } of tokenizeSignature(text)) {
      if (!cls) { element.append(doc.createTextNode(chunk)); continue; }
      const span = doc.createElement('span');
      span.className = cls;
      span.textContent = chunk;
      element.append(span);
    }
  }

  // paintUsageSnippet(element, location) -> like paintSignatureText, but also
  // marks whichever token overlaps [location.highlightStart,
  // +highlightLength) with an extra `hl` class, the matched identifier
  // occurrence on that usage row (demo's `.usage-snippet .hl` highlight).
  function paintUsageSnippet(element, location) {
    element.replaceChildren();
    const { snippet = '', highlightStart = -1, highlightLength = 0 } = location;
    let offset = 0;
    for (const { text: chunk, cls } of tokenizeSignature(snippet)) {
      const overlaps = highlightLength > 0
        && offset < highlightStart + highlightLength
        && offset + chunk.length > highlightStart;
      offset += chunk.length;
      if (!cls && !overlaps) { element.append(doc.createTextNode(chunk)); continue; }
      const span = doc.createElement('span');
      span.className = [cls, overlaps ? 'hl' : null].filter(Boolean).join(' ');
      span.textContent = chunk;
      element.append(span);
    }
  }

  function renderSignature(popover, definition = null, { showFullTypeBody = false } = {}) {
    const block = popover.querySelector('.signature-block');
    const signature = block.querySelector('.signature');
    const toggle = block.querySelector('.signature-toggle');
    const typeBody = showFullTypeBody ? definition?.fullTypeBody || '' : '';
    if (typeBody) {
      const lines = typeBody.split('\n');
      const compact = lines.slice(0, FULL_TYPE_BODY_INITIAL_LINES).join('\n');
      const remaining = lines.length - FULL_TYPE_BODY_INITIAL_LINES;
      block.hidden = false;
      paintSignatureText(signature, compact);
      signature.title = '';
      toggle.hidden = remaining <= 0;
      toggle.textContent = `Show remaining ${remaining} line${remaining === 1 ? '' : 's'}`;
      toggle.setAttribute('aria-expanded', 'false');
      toggle.onclick = remaining > 0 ? () => {
        const expanded = toggle.getAttribute('aria-expanded') === 'true';
        paintSignatureText(signature, expanded ? compact : typeBody);
        toggle.textContent = expanded ? `Show remaining ${remaining} line${remaining === 1 ? '' : 's'}` : 'Collapse type body';
        toggle.setAttribute('aria-expanded', String(!expanded));
      } : null;
      return;
    }
    const full = definition?.signature || '';
    const compact = definition?.compactSignature || '';
    block.hidden = !full;
    paintSignatureText(signature, compact || full);
    signature.title = compact ? full : '';
    toggle.hidden = !compact;
    toggle.textContent = 'Show full signature';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.onclick = compact ? () => {
      const expanded = toggle.getAttribute('aria-expanded') === 'true';
      paintSignatureText(signature, expanded ? compact : full);
      signature.title = expanded ? full : '';
      toggle.textContent = expanded ? 'Show full signature' : 'Collapse signature';
      toggle.setAttribute('aria-expanded', String(!expanded));
    } : null;
  }

  function destinationIcon(destination, baseClass = 'destination-icon') {
    const icon = doc.createElement('span');
    icon.className = `${baseClass} destination-${destination.kind === 'inDiff' ? 'in-diff' : 'new-tab'}`;
    icon.dataset.tooltip = destination.label;
    icon.setAttribute('role', 'img');
    icon.setAttribute('aria-label', destination.label);
    icon.title = destination.label;
    icon.innerHTML = destination.kind === 'inDiff'
      ? '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M2 2h2v6a3 3 0 0 0 3 3h4.2L9 8.8 10.4 7 15 11.5 10.4 16 9 14.2l2.2-2.2H7a4 4 0 0 1-4-4V2z"/></svg>'
      : '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M9 2h5v5h-2V5.4L7.7 9.7 6.3 8.3 10.6 4H9V2z"/><path fill="currentColor" d="M3 3h4v2H4v7h7V9h2v5H2V3h1z"/></svg>';
    return icon;
  }

  // flashDestination(target) -> brief `data-golens-navigation-destination`
  // highlight flash. Byte-identical to go-navigation.js's former
  // flashDestination() and to keyboard-nav.js's own duplicate (ticket 17) —
  // same "small, unlikely-to-drift helper" duplication precedent, not a
  // shared platform module.
  function flashDestination(target) {
    if (!target) return;
    target.removeAttribute('data-golens-navigation-destination');
    void target.offsetWidth;
    target.setAttribute('data-golens-navigation-destination', '');
    setTimeout(() => target.removeAttribute('data-golens-navigation-destination'), 1300);
  }

  // visibleDiffRootForDefinition/navigateToLocation are shared with
  // bookmarks.js (ticket 18's `reveal()`) — go-navigation.js owns them, not
  // this module; see that file's own comment on why they stayed there
  // instead of moving here with the rest of hover/click resolution.
  function definitionDestination(definition) {
    return legacy.visibleDiffRootForDefinition(definition)
      ? { kind: 'inDiff', label: 'Jump in this MR diff' }
      : { kind: 'newTab', label: 'Open in a new tab' };
  }

  function recordSemanticJump(source, destination) {
    if (!source || !destination || locationKey(source) === locationKey(destination)) return;
    const retained = history.slice(0, historyIndex + 1);
    if (locationKey(retained.at(-1)) !== locationKey(source)) retained.push(source);
    retained.push(destination);
    history = retained.slice(-100);
    historyIndex = history.length - 1;
    if (history.length >= 3) void legacy.offerShortcutCoach('historyBack');
  }

  async function navigateHistoryImpl(direction) {
    const nextIndex = historyIndex + direction;
    if (nextIndex < 0 || nextIndex >= history.length) {
      legacy.toast(direction < 0 ? 'No earlier semantic location.' : 'No later semantic location.');
      return false;
    }
    if (!await legacy.navigateToLocation(history[nextIndex])) {
      legacy.toast('That semantic location is no longer loaded in this diff.');
      return false;
    }
    historyIndex = nextIndex;
    return true;
  }

  async function openDefinition(definition, sourceLocation = null) {
    const destinationLine = destinationLineForDefinition(definition);
    const root = legacy.visibleDiffRootForDefinition(definition);
    if (root) {
      const destination = { path: definition.path, line: destinationLine, side: 'new' };
      if (await legacy.navigateToLocation(destination)) recordSemanticJump(sourceLocation, destination);
      return;
    }
    const context = legacy.projectContext();
    const url = `${context.projectBase}/-/blob/${encodeURIComponent(definition.ref)}/${definition.path.split('/').map(encodeURIComponent).join('/')}#L${destinationLine}`;
    win.open(url, '_blank', 'noopener');
  }

  // --- choice / result rendering --------------------------------------------

  function choiceButton({ title, fullTitle = title, context = '', documentation = '', kind = '', definition = null, externalURL = '' }) {
    const sourceLocation = sourceLocationForTarget(activeTarget);
    const destination = definition ? definitionDestination(definition) : { kind: 'newTab', label: 'Open in a new tab' };
    const button = doc.createElement('button');
    const copy = doc.createElement('span');
    const heading = doc.createElement('span');
    const titleElement = doc.createElement('span');
    button.type = 'button';
    button.className = 'choice';
    button.setAttribute('aria-label', `${fullTitle}. ${destination.label}`);
    copy.className = 'choice-copy';
    heading.className = 'choice-heading';
    titleElement.className = 'choice-title';
    titleElement.textContent = title;
    if (fullTitle !== title) titleElement.title = fullTitle;
    if (kind) heading.append(createSymbolBadge(kind));
    heading.append(titleElement);
    copy.append(heading);
    if (context) {
      const contextElement = doc.createElement('span');
      contextElement.className = 'choice-context';
      contextElement.textContent = context;
      contextElement.title = context;
      copy.append(contextElement);
    }
    if (documentation) {
      const docs = doc.createElement('span');
      docs.className = 'choice-doc';
      docs.textContent = documentation;
      docs.title = documentation;
      copy.append(docs);
    }
    button.append(copy, destinationIcon(destination));
    button.addEventListener('click', () => {
      hidePopover();
      if (definition) openDefinition(definition, sourceLocation);
      else if (externalURL) win.open(externalURL, '_blank', 'noopener');
    });
    return button;
  }

  function implementationButton(candidate) {
    const confidence = candidate.confidence === 'asserted' ? 'Explicit assertion' : 'Structural match';
    return choiceButton({
      title: candidate.displayName,
      context: `${candidate.path}:${candidate.documentationLine || candidate.line} · ${confidence}`,
      documentation: candidate.documentation?.split('\n')[0] || '',
      kind: candidate.kind || 'type',
      definition: candidate,
    });
  }

  // resultAction(label, listener, { flush }) -> a trailing action appended
  // after a result's choices ("Show more", "Search complete project").
  // `flush: true` reuses `.signature-toggle`'s full-width borderless row
  // styling (same as the "Show full signature" toggle) so the flush usages
  // list only carries one visual language for this kind of action; otherwise
  // it's a bordered `.choice` row matching the default choices box.
  function resultAction(label, listener, { flush = false } = {}) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = flush ? 'signature-toggle' : 'choice';
    button.textContent = label;
    button.addEventListener('click', listener);
    return button;
  }

  // usageGroupElement(group) -> one file-header row plus its compact
  // single-line usage rows, IntelliJ "Find Usages"-style grouping (ticket
  // 29's groupLocationsByFile()). Destination (in-diff vs. new-tab) is
  // computed once per file from its first location: every location in a
  // group already shares the same file, so it shares the same destination.
  function usageGroupElement(group) {
    const destination = definitionDestination(group.locations[0]);
    const wrap = doc.createElement('div');
    wrap.className = 'usage-group';
    const fileHeader = doc.createElement('div');
    fileHeader.className = 'usage-group-file';
    fileHeader.append(doc.createTextNode(group.fileName));
    if (group.dirPath) {
      const pathElement = doc.createElement('span');
      pathElement.className = 'usage-group-path';
      pathElement.textContent = group.dirPath;
      fileHeader.append(pathElement);
    }
    fileHeader.append(destinationIcon(destination, 'usage-dest'));
    wrap.append(fileHeader, ...group.locations.map((location) => usageRowElement(location)));
    return wrap;
  }

  function usageRowElement(location) {
    const destination = definitionDestination(location);
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'usage-row';
    const lineElement = doc.createElement('span');
    lineElement.className = 'usage-line';
    lineElement.textContent = String(location.line);
    const snippetElement = doc.createElement('span');
    snippetElement.className = 'usage-snippet';
    paintUsageSnippet(snippetElement, location);
    button.append(lineElement, snippetElement);
    button.title = `${location.path}:${location.line}`;
    button.setAttribute('aria-label', `${location.path}:${location.line}. ${destination.label}`);
    button.addEventListener('click', () => {
      hidePopover();
      openDefinition(location, sourceLocationForTarget(activeTarget));
    });
    return button;
  }

  // usageRowSkeleton() -> one placeholder row shown in place of a usage row
  // while findReferences() is still in flight (never a static count with no
  // sign the search is still working).
  function usageRowSkeleton() {
    const row = doc.createElement('div');
    row.className = 'usage-row-skeleton';
    row.append(doc.createElement('i'), doc.createElement('i'));
    return row;
  }

  async function loadMoreResults(result, pointer, button) {
    button.disabled = true;
    button.textContent = 'Loading more…';
    try {
      const page = result.request.kind === 'references'
        ? await findReferences(result.request.target, result.request.definition, result.nextCursor, result.request.scope)
        : await findImplementations(result.request.target, result.request.definition, undefined, result.nextCursor, result.request.scope);
      const key = result.request.kind === 'references' ? 'locations' : 'candidates';
      showResult({ ...page, [key]: [...result[key], ...page[key]], request: result.request }, pointer);
      pinPopover(pointer);
    } catch (error) {
      button.disabled = false;
      button.textContent = 'Show more';
      legacy.toast(error.message || 'Unable to load more semantic results.');
    }
  }

  // showResult(result, pointer) -> boolean (renders and returns true, or
  // returns false for an `unrecognized` result — the closed `kind` set from
  // code-intel.internal.js's classify(), replacing the former 11-way
  // `if/else if` chain on the worker's own wire-level `result.status`
  // (ticket 04 §5/§2: those wire statuses are unchanged and un-renamed;
  // `kind` is the new UI-outcome discriminator this dispatch switches on).
  function showResult(result, pointer, { compact = false } = {}) {
    const shadow = ensureUI();
    const popover = shadow.querySelector('.popover');
    const popoverBody = popover.querySelector('.popover-body');
    const wasPinned = pinnedPopover;
    const badge = popover.querySelector('.popover-header .symbol-badge');
    const title = popover.querySelector('.popover-title');
    const docs = popover.querySelector('.docs');
    const scope = popover.querySelector('.scope');
    const choices = popover.querySelector('.choices');
    const location = popover.querySelector('.location');
    const copyButton = popover.querySelector('.copy-button');
    const shortcut = popover.querySelector('.shortcut-hint');
    const shortcutHint = shortcut.querySelector('span');
    const usagesCount = popover.querySelector('.usages-count');
    popover.removeAttribute('aria-busy');
    popover.classList.remove('popover--list');
    popoverBody.classList.remove('usages-body');
    renderSignature(popover);
    docs.textContent = '';
    scope.textContent = resultScopeText(result.scope);
    scope.hidden = !scope.textContent;
    location.textContent = '';
    configureSourceCopy(copyButton, sourceLocationForTarget(pointer));
    choices.replaceChildren();
    choices.classList.remove('choices--flush');
    shortcut.hidden = true;
    usagesCount.hidden = true;
    usagesCount.classList.remove('is-loading');
    usagesCount.replaceChildren();
    let shouldPin = false;
    const setHeader = (kind, heading, sourceLocation = '') => {
      applySymbolBadge(badge, kind);
      title.textContent = heading;
      location.textContent = sourceLocation;
      location.title = sourceLocation;
    };
    const setShortcut = (text) => {
      shortcutHint.textContent = text;
      shortcut.hidden = !text;
    };
    const { kind } = classify(result);
    if (kind === 'resolved') {
      setHeader(result.definition.kind, result.definition.name, `${result.definition.path}:${result.definition.line}`);
      if (!compact) {
        renderSignature(popover, result.definition, { showFullTypeBody: !result.isDefinition });
        docs.textContent = result.definition.documentation || '';
      }
      if (!result.isDefinition) {
        choices.append(choiceButton({
          title: 'Go to definition',
          context: `${result.definition.path}:${destinationLineForDefinition(result.definition)}`,
          definition: result.definition,
        }));
      }
      setShortcut(result.isDefinition && result.definition.kind === 'interface'
        ? 'or Ctrl + click to find implementations'
        : result.isDefinition ? 'or Ctrl + click to find usages' : 'or Ctrl + click to go to definition');
    } else if (kind === 'externalDoc') {
      const url = legacy.documentationURL(result);
      setHeader('external', result.symbol, result.importPath);
      renderSignature(popover, { signature: `${result.importPath}.${result.symbol}` });
      docs.textContent = 'Documentation is available on pkg.go.dev.';
      choices.append(choiceButton({ title: 'Open on pkg.go.dev', context: url, externalURL: url }));
      setShortcut('or Ctrl + click to open package documentation');
    } else if (kind === 'projectPackage') {
      const url = legacy.projectPackageURL(result);
      setHeader('package', result.symbol, result.importPath);
      renderSignature(popover, { signature: `package ${result.symbol}` });
      docs.textContent = url
        ? 'Open this package directory at the merge request commit.'
        : 'The package directory is unavailable because the merge request commit could not be verified.';
      if (url) choices.append(choiceButton({
        title: 'Open package directory',
        context: `${result.packagePath || '.'} · ${result.ref.slice(0, 12)}`,
        externalURL: url,
      }));
      setShortcut(url ? 'or Ctrl + click to choose this package directory' : '');
    } else if (kind === 'builtin') {
      const url = legacy.documentationURL(result);
      setHeader('builtin', result.symbol, 'Go builtin');
      renderSignature(popover, { signature: `builtin ${result.symbol}` });
      docs.textContent = 'Documentation is available on pkg.go.dev.';
      choices.append(choiceButton({ title: 'Open on pkg.go.dev', context: url, externalURL: url }));
      setShortcut('or Ctrl + click to open builtin documentation');
    } else if (kind === 'ambiguous') {
      setHeader('external', result.symbol, `${result.definitions.length} definitions`);
      docs.textContent = result.reason === 'receiverOrSelector'
        ? 'Ambiguous receiver or selector. Choose only when the intended definition is clear.'
        : 'Multiple definitions match. Choose the definition you want to open.';
      result.definitions.forEach((definition) => {
        choices.append(choiceButton({
          title: definition.compactSignature || definition.signature,
          fullTitle: definition.signature,
          context: `${definition.receiver ? `${definition.receiver} · ` : ''}${definition.path}:${definition.line}`,
          kind: definition.kind,
          definition,
        }));
      });
      shouldPin = result.definitions.length > 0;
    } else if (kind === 'references') {
      popover.classList.add('popover--list');
      popoverBody.classList.add('usages-body');
      choices.classList.add('choices--flush');
      const count = `${result.locations.length}${result.hasMore ? '+' : ''}`;
      setHeader(result.definition.kind, `Usages of ${result.definition.name}`, `${result.definition.path}:${result.definition.line}`);
      scope.hidden = true;
      if (result.locations.length) {
        usagesCount.hidden = false;
        usagesCount.append(doc.createTextNode(`${count} usage${result.locations.length === 1 && !result.hasMore ? '' : 's'}`));
      } else {
        docs.textContent = absenceText(result.scope);
      }
      groupLocationsByFile(result.locations).forEach((group) => choices.append(usageGroupElement(group)));
      if (result.hasMore) choices.append(resultAction('Show more', (event) => loadMoreResults(result, pointer, event.currentTarget), { flush: true }));
      shouldPin = result.locations.length > 1;
    } else if (kind === 'implementations') {
      const groups = implementationGroups(result);
      setHeader('interface', `Implementations of ${result.interfaceDefinition.name}`, `${result.methodCount} required method${result.methodCount === 1 ? '' : 's'}`);
      renderSignature(popover, result.interfaceDefinition);
      docs.textContent = result.candidates.length
        ? `${groups.production.length} production implementation${groups.production.length === 1 ? '' : 's'}${groups.testDoubles.length ? ` and ${groups.testDoubles.length} test double${groups.testDoubles.length === 1 ? '' : 's'}` : ''}.`
        : absenceText(result.scope);
      groups.production.forEach((candidate) => choices.append(implementationButton(candidate)));
      if (groups.testDoubles.length) {
        const details = doc.createElement('details');
        const summary = doc.createElement('summary');
        const group = doc.createElement('div');
        group.className = 'test-double-choices';
        summary.textContent = `Test doubles (${groups.testDoubles.length})`;
        groups.testDoubles.forEach((candidate) => group.append(implementationButton(candidate)));
        details.append(summary, group);
        choices.append(details);
      }
      if (result.hasMore) choices.append(resultAction('Show more', (event) => loadMoreResults(result, pointer, event.currentTarget)));
      shouldPin = result.candidates.length > 0;
    } else if (kind === 'unsupportedImplementations') {
      setHeader('interface', `Implementations of ${result.interfaceDefinition.name}`);
      renderSignature(popover, result.interfaceDefinition);
      docs.textContent = result.reason === 'buildConstraint'
        ? 'Unsupported build constraint: GoLens cannot safely choose a platform-specific implementation set.'
        : result.reason === 'typeSetConstraint'
        ? 'This interface contains a type-set constraint, which the structural finder cannot evaluate safely.'
        : 'This interface embeds a type that cannot be resolved inside the project.';
    } else if (kind === 'notFound') {
      setHeader('external', result.symbol || 'Not found');
      docs.textContent = absenceText(result.scope);
    } else if (kind === 'unsupported') {
      setHeader('external', result.symbol || 'Unsupported');
      docs.textContent = result.reason === 'buildConstraint'
        ? 'Unsupported build constraint: GoLens cannot safely select the active declaration.'
        : 'This semantic relationship is unsupported.';
    } else return false;
    const hasCompleteSearchTerms = result.request?.kind === 'references' || result.searchTerms?.length;
    if (result.request && hasCompleteSearchTerms && result.scope?.kind !== 'fullProject' && !result.scope?.complete
      && !['buildConstraint', 'typeSetConstraint'].includes(result.reason)) {
      choices.append(resultAction('Search complete project', () => legacy.searchCompleteProject(result, pointer), { flush: kind === 'references' }));
      shouldPin = true;
    }
    popover.classList.add('show');
    positionPopover(popover, pointer.x, pointer.y);
    if (shouldPin || wasPinned) pinPopover(pointer);
    else setPopoverMode('passive', pointer);
    return true;
  }

  // loadingPillText(progress) -> the header pill's spinner label while a
  // package is still loading (replaces the former full-width `.loading-progress`
  // bar — all loading states now surface through the same small header pill
  // the usages-count badge already uses, per the demo never showing that bar).
  function loadingPillText(progress) {
    return progress.phase === 'discovering'
      ? loadingPhaseLabel(progress.phase)
      : `${loadingPhaseLabel(progress.phase)} · ${progress.percentage}%`;
  }

  function showLoading(message, pointer, progress, { usages = false } = {}) {
    const shadow = ensureUI();
    const popover = shadow.querySelector('.popover');
    const popoverBody = popover.querySelector('.popover-body');
    const wasPinned = pinnedPopover;
    const badge = popover.querySelector('.popover-header .symbol-badge');
    const title = popover.querySelector('.popover-title');
    const docs = popover.querySelector('.docs');
    const choices = popover.querySelector('.choices');
    const location = popover.querySelector('.location');
    const copyButton = popover.querySelector('.copy-button');
    const shortcutHint = popover.querySelector('.shortcut-hint');
    const usagesCount = popover.querySelector('.usages-count');
    popover.classList.toggle('popover--list', usages);
    popoverBody.classList.toggle('usages-body', usages);
    applySymbolBadge(badge, 'external');
    title.textContent = message;
    renderSignature(popover);
    docs.textContent = '';
    location.textContent = '';
    configureSourceCopy(copyButton, sourceLocationForTarget(pointer));
    shortcutHint.hidden = true;
    if (usages) {
      usagesCount.hidden = false;
      usagesCount.classList.add('is-loading');
      const spinner = doc.createElement('span');
      spinner.className = 'usages-spinner';
      usagesCount.replaceChildren(spinner, doc.createTextNode('Finding usages…'));
      choices.classList.add('choices--flush');
      choices.replaceChildren(usageRowSkeleton(), usageRowSkeleton());
    } else if (progress) {
      usagesCount.hidden = false;
      usagesCount.classList.add('is-loading');
      const spinner = doc.createElement('span');
      spinner.className = 'usages-spinner';
      usagesCount.replaceChildren(spinner, doc.createTextNode(loadingPillText(progress)));
      choices.classList.remove('choices--flush');
      choices.replaceChildren();
    } else {
      usagesCount.hidden = true;
      usagesCount.classList.remove('is-loading');
      usagesCount.replaceChildren();
      choices.classList.remove('choices--flush');
      choices.replaceChildren();
    }
    popover.setAttribute('aria-busy', 'true');
    popover.classList.add('show');
    positionPopover(popover, pointer.x, pointer.y);
    if (wasPinned) pinPopover(pointer);
    else setPopoverMode('passive', pointer);
  }

  // showSearchProgress(message, pointer) -> shows the same inline
  // spinner-pill + skeleton-row loading UI as showLoading's usages branch,
  // then pins the popover into the dismiss-proof 'searching' mode (must run
  // after showLoading, since showLoading itself ends by calling
  // pinPopover/setPopoverMode). Exposed for project-search.js to drive while
  // a complete-project search is in flight.
  function showSearchProgress(message, pointer) {
    showLoading(message, pointer, null, { usages: true });
    setPopoverMode('searching', pointer);
  }

  // --- resolution orchestration (fetch, debounce, sequencing) --------------

  async function resolveAt(target, method, onProgress) {
    const file = legacy.fileContextFor(target.cell);
    const line = legacy.lineContextFor(target.cell);
    const context = legacy.projectContext();
    if (!file || !line || !context) return { status: 'unsupported', reason: 'diffContextUnavailable' };
    const refs = await legacy.mergeRequestRefsForFile(file);
    const sourcePath = line.side === 'old' ? file.oldPath : file.newPath;
    const packagePath = legacy.dirname(sourcePath);
    const ref = legacy.sourceRefFor(file, line, refs);
    await legacy.loadPackage(packagePath, ref, onProgress);
    const params = {
      origin: location.origin,
      project: context.project,
      ref,
      packagePath,
      path: sourcePath,
      line: line.line,
      character: target.character,
      identifier: target.identifier,
      occurrence: target.occurrence,
    };
    let result = await legacy.workerRPC(method, params);
    if (result.status === 'needsPackage') {
      await legacy.loadPackage(result.packagePath, ref, onProgress);
      result = await legacy.workerRPC(method, params);
    }
    return result;
  }

  function relatedResultScope(restored, packagePath) {
    if (restored?.coverage === 'related') {
      return {
        kind: 'indexedPackages',
        packageCount: restored.packages || 0,
        complete: false,
        searchStatus: restored.searchStatus || 'limited',
      };
    }
    return null;
  }

  async function findReferences(target, definition, cursor = '', scopeOverride = null) {
    const file = legacy.fileContextFor(target.cell);
    const line = legacy.lineContextFor(target.cell);
    const context = legacy.projectContext();
    if (!file || !line || !context) return { status: 'notFound' };
    const refs = await legacy.mergeRequestRefsForFile(file);
    const sourcePath = line.side === 'old' ? file.oldPath : file.newPath;
    const packagePath = legacy.dirname(sourcePath);
    const ref = legacy.sourceRefFor(file, line, refs);
    await legacy.loadPackage(packagePath, ref);
    let restored = null;
    if (ref === refs.headSha) {
      restored = await legacy.workerRPC('restoreMergeRequest', {
        origin: location.origin,
        project: context.project,
        mergeRequest: legacy.mergeRequestIID(),
        ref,
      });
    }
    const result = await legacy.workerRPC('findReferences', {
      origin: location.origin,
      project: context.project,
      ref,
      packagePath,
      definition,
      pageSize: 25,
      cursor,
      ...((scopeOverride || relatedResultScope(restored, packagePath)) ? { scope: scopeOverride || relatedResultScope(restored, packagePath) } : {}),
    });
    return { ...result, request: { kind: 'references', target, definition, ref, scope: scopeOverride } };
  }

  async function findImplementations(target, definition, progress = () => {}, cursor = '', scopeOverride = null) {
    const file = legacy.fileContextFor(target.cell);
    const line = legacy.lineContextFor(target.cell);
    const context = legacy.projectContext();
    if (!file || !line || !context) return { status: 'notFound' };
    const refs = await legacy.mergeRequestRefsForFile(file);
    const ref = legacy.sourceRefFor(file, line, refs);
    let restored = null;
    if (ref === refs.headSha) {
      await legacy.preloadMergeRequest(progress);
      restored = await legacy.workerRPC('restoreMergeRequest', {
        origin: location.origin,
        project: context.project,
        mergeRequest: legacy.mergeRequestIID(),
        ref,
      });
    } else {
      await legacy.loadPackage(legacy.dirname(line.side === 'old' ? file.oldPath : file.newPath), ref, progress);
    }
    const packagePath = legacy.dirname(line.side === 'old' ? file.oldPath : file.newPath);
    const result = await legacy.workerRPC('findImplementations', {
      origin: location.origin,
      project: context.project,
      ref,
      interfaceDefinition: definition,
      pageSize: 25,
      cursor,
      ...((scopeOverride || relatedResultScope(restored, packagePath)) ? { scope: scopeOverride || relatedResultScope(restored, packagePath) } : {}),
    });
    return { ...result, request: { kind: 'implementations', target, definition, ref, scope: scopeOverride } };
  }

  async function navigateSemanticTarget(target) {
    hidePopover();
    activeTarget = { key: targetKey(target), ...target };
    markTarget(target.element);
    try {
      showLoading(`Looking up ${target.identifier}…`, target);
      const result = await resolveAt(target, 'resolveDefinition', (message, progress) => showLoading(message, target, progress));
      if (isInterfaceDeclaration(result)) {
        const implementations = await findImplementations(
          target,
          result.definition,
          (message) => showLoading(message, target),
        );
        showResult(implementations, target);
      }
      else if (result.status === 'resolved' && result.isDefinition) {
        showLoading(`Finding usages of ${target.identifier}…`, target, null, { usages: true });
        const references = await findReferences(target, result.definition);
        if (referenceNavigationAction(references) === 'open') openDefinition(references.locations[0], sourceLocationForTarget(target));
        else showResult(references, target);
      }
      else if (result.status === 'resolved') openDefinition(result.definition, sourceLocationForTarget(target));
      else if (result.status === 'projectPackage') {
        showResult(result, target);
        pinPopover(target);
      }
      else if (result.status === 'standardLibrary' || result.status === 'packageDocumentation' || result.status === 'builtin') win.open(legacy.documentationURL(result), '_blank', 'noopener');
      else if (['ambiguous', 'notFound', 'unsupported'].includes(result.status)) {
        showResult(result, target);
        pinPopover(target);
      }
      else legacy.toast('GoLens could not resolve this symbol safely.');
    } catch (error) {
      hidePopover();
      legacy.toast(error.message || 'Go intelligence is unavailable.');
    }
  }

  // --- hit-test / hover / click ---------------------------------------------

  function markTarget(element) {
    if (activeElement === element) return;
    activeElement?.removeAttribute('data-golens-go-target');
    activeElement = element || null;
    activeElement?.setAttribute('data-golens-go-target', '');
  }

  // narrowIdentifierElement(cell, element, character, identifier) -> the
  // element that should receive the hover/marker attribute for `identifier`.
  // When `element`'s own text is exactly the identifier (the normal case),
  // returns it unchanged. Otherwise `element` is a compound syntax-highlight
  // span containing the identifier alongside other tokens (e.g. GitLab
  // grouping `mr.log().WithField("phase", "boot-verify")` into one span) —
  // marking that whole span would underline far more than the hovered
  // symbol, so this splits out just the identifier's own text node and
  // wraps it in a new span scoped to the match. Falls back to `element` if
  // the identifier's characters don't fall within a single text node.
  function narrowIdentifierElement(cell, element, character, identifier) {
    const text = (element.textContent || '').trim();
    if (text === identifier) return element;
    const walker = doc.createTreeWalker(cell, globalThis.NodeFilter?.SHOW_TEXT || 4);
    let node;
    let offset = 0;
    while ((node = walker.nextNode())) {
      const len = (node.nodeValue || '').length;
      if (character >= offset && character + identifier.length <= offset + len) {
        const startOffset = character - offset;
        try {
          const middle = node.splitText(startOffset);
          middle.splitText(identifier.length);
          const span = doc.createElement('span');
          middle.replaceWith(span);
          span.appendChild(middle);
          return span;
        } catch {
          return element;
        }
      }
      offset += len;
    }
    return element;
  }

  function caretAtPoint(cell, x, y) {
    let node;
    let offset;
    if (doc.caretPositionFromPoint) {
      const position = doc.caretPositionFromPoint(x, y);
      node = position?.offsetNode;
      offset = position?.offset;
    } else if (doc.caretRangeFromPoint) {
      const range = doc.caretRangeFromPoint(x, y);
      node = range?.startContainer;
      offset = range?.startOffset;
    }
    if (!node) return null;
    if (!cell.contains(node)) {
      // Blob pages: the caret-hit node lands in the transparent overlay
      // layer (a sibling DOM subtree from `cell`, the highlighted
      // `div.line`), so the normal containment check above always fails
      // there. legacy.caretCellFor?.(node, offset, cell) (blob-dom.js's
      // caretCellFor, wired only for blob pages) remaps the hit into the
      // equivalent (node, offset) inside `cell`; if it isn't provided
      // (diff-dom/MR case) or can't remap this hit, behavior is identical
      // to before — bail out.
      const remapped = legacy.caretCellFor?.(node, offset, cell);
      if (!remapped) return null;
      ({ node, offset } = remapped);
    }
    const range = doc.createRange();
    range.selectNodeContents(cell);
    try { range.setEnd(node, offset); } catch { return null; }
    const character = range.toString().length;
    const source = cell.textContent || '';
    const identifier = identifierAtCharacter(source, character);
    if (!identifier) return null;
    const element = node.nodeType === 1 ? node : node.parentElement;
    if (!caretElementMatchesIdentifier(element, cell, identifier.identifier)) return null;
    const marked = element === cell ? null : narrowIdentifierElement(cell, element, identifier.character, identifier.identifier);
    return { ...identifier, element: marked };
  }

  function identifierFromElement(target, cell) {
    let element = target?.nodeType === 1 ? target : target?.parentElement;
    while (element && element !== cell) {
      const identifier = (element.textContent || '').trim();
      if (isWholeIdentifier(identifier)) {
        const range = doc.createRange();
        range.selectNodeContents(cell);
        try { range.setEndBefore(element); } catch { return null; }
        const character = range.toString().length;
        const hit = identifierAtCharacter(cell.textContent || '', character);
        if (!hit || hit.identifier !== identifier) return null;
        return { ...hit, element };
      }
      element = element.parentElement;
    }
    return null;
  }

  function targetAtEvent(event) {
    const cell = legacy.codeCellFor(event.target, event.clientX, event.clientY);
    if (!cell || !legacy.fileContextFor(cell)) return null;
    const caret = caretAtPoint(cell, event.clientX, event.clientY) || identifierFromElement(event.target, cell);
    return caret ? { ...caret, cell, x: event.clientX, y: event.clientY } : null;
  }

  function throttleToFrame(fn) {
    let scheduled = false;
    let latestArgs = null;
    const throttled = (...args) => {
      latestArgs = args;
      if (scheduled) return;
      scheduled = true;
      legacy.requestFrame(() => {
        scheduled = false;
        fn(...latestArgs);
      });
    };
    throttled.reset = () => { scheduled = false; latestArgs = null; };
    return throttled;
  }

  const handleMouseMovePoint = throttleToFrame((point) => {
    if (!enabled) return;
    const target = targetAtEvent(point);
    const key = targetKey(target);
    if (key === activeTarget?.key) {
      cancelPopoverDismissal();
      return;
    }
    clearTimeout(hoverTimer);
    if (!target) {
      activeTarget = null;
      markTarget(null);
      schedulePassivePopoverDismissal();
      return;
    }
    cancelPopoverDismissal();
    hidePopover();
    activeTarget = { key, ...target };
    markTarget(target.element);
    hoverTimer = setTimeout(async () => {
      try {
        if (activeTarget?.key !== key) return;
        showLoading(`Looking up ${target.identifier}…`, target);
        const result = await resolveAt(target, 'resolveHover', (message, progress) => {
          if (activeTarget?.key === key) showLoading(message, target, progress);
        });
        let displayResult = result;
        if (shouldShowReferencesOnHover(result)) {
          showLoading(`Finding usages of ${target.identifier}…`, target, null, { usages: true });
          displayResult = await findReferences(target, result.definition);
        }
        if (activeTarget?.key === key) showResult(displayResult, target);
      } catch (error) {
        if (activeTarget?.key === key) hidePopover();
        const message = error.message || 'Go intelligence is unavailable.';
        if (lastErrorToast !== message) {
          lastErrorToast = message;
          legacy.toast(message);
        }
      }
    }, 350);
  });

  function onMouseMove(event) {
    if (!enabled) return;
    if (ui && event.composedPath().includes(ui)) {
      if (popoverMode !== 'searching') pinPopover();
      return;
    }
    if (pinnedPopover) return;
    handleMouseMovePoint({ target: event.target, clientX: event.clientX, clientY: event.clientY });
  }

  async function onClick(event) {
    if (!enabled || event.button !== 0) return;
    if (eventIsInsideUI(event)) return;
    if (!(event.metaKey || event.ctrlKey)) {
      dismissPinnedPopoverFromOutside(event);
      const selection = globalThis.getSelection?.();
      const target = (!selection || selection.isCollapsed) ? targetAtEvent(event) : null;
      if (target) selectSymbol(target);
      else if (!legacy.codeCellFor(event.target, event.clientX, event.clientY)) clearSelectedSymbol();
      return;
    }
    const target = targetAtEvent(event);
    if (!target) {
      if (legacy.codeCellFor(event.target, event.clientX, event.clientY)) legacy.toast('GoLens could not identify a Go symbol on this diff line.');
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    void legacy.offerShortcutCoach('semanticJump');
    await navigateSemanticTarget(target);
  }

  // Escape while the popover holds focus: same guard string as
  // go-navigation.js's document-level listener (duplicated per the
  // isBookmarkOnlyMutation precedent from ticket 18 — a small, unlikely-to-
  // drift check isn't worth a shared platform module) since this listener is
  // independent of that one, not preceded by it.
  function escapeGuardBlocks(event) {
    return [...event.composedPath(), doc.activeElement].some((target) => target?.closest?.(ESCAPE_GUARD_SELECTOR));
  }

  function onPopoverKeyDown(event) {
    if (event.key !== 'Escape') return;
    if (escapeGuardBlocks(event)) return;
    handleEscape(event);
  }

  // handleEscape(event) -> mutates `event` (preventDefault/stopPropagation)
  // exactly as go-navigation.js's former unified onKeyDown did for its
  // popover branch; self-bridge-only, called by go-navigation.js's own
  // document-level Escape handler *after* its project-search-minimize check
  // (and after that same guard already ran once there — not re-checked
  // here).
  function handleEscape(event) {
    if (popoverMode === 'hidden') {
      if (selectedIdentifier) { event.preventDefault(); clearSelectedSymbol(); }
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (popoverMode === 'searching') return;
    hidePopover();
  }

  // --- occurrence highlighting -----------------------------------------------

  function occurrenceRanges(identifier) {
    const found = [];
    if (!identifier) return found;
    for (const root of legacy.diffFileRoots()) {
      const firstCell = root.querySelector(CODE_CELL_SELECTOR);
      if (!firstCell || !legacy.fileContextFor(firstCell)) continue;
      for (const cell of root.querySelectorAll(CODE_CELL_SELECTOR)) {
        const cellSource = cell.textContent || '';
        if (!cellSource.includes(identifier)) continue;
        const walker = doc.createTreeWalker(cell, globalThis.NodeFilter?.SHOW_TEXT || 4);
        let node;
        let nodeOffset = 0;
        while ((node = walker.nextNode())) {
          const text = node.nodeValue || '';
          let from = 0;
          while (from <= text.length - identifier.length) {
            const index = text.indexOf(identifier, from);
            if (index < 0) break;
            const end = index + identifier.length;
            const hit = identifierAtCharacter(cellSource, nodeOffset + index);
            if (identifierBoundary(text[index - 1]) && identifierBoundary(text[end]) && hit?.identifier === identifier && hit.character === nodeOffset + index) {
              const range = doc.createRange();
              range.setStart(node, index);
              range.setEnd(node, end);
              found.push({ range, cell, row: cell.closest('tr, [role="row"]') || cell, character: hit.character, occurrence: hit.occurrence });
            }
            from = index + identifier.length;
          }
          nodeOffset += text.length;
        }
      }
    }
    return found;
  }

  function paintOccurrences() {
    const highlights = globalThis.CSS?.highlights;
    if (!highlights || typeof globalThis.Highlight !== 'function') return;
    highlights.delete('golens-symbol-occurrence');
    highlights.delete('golens-symbol-current');
    if (!occurrences.length) return;
    highlights.set('golens-symbol-occurrence', new globalThis.Highlight(...occurrences.map(({ range }) => range)));
    if (occurrenceIndex >= 0) highlights.set('golens-symbol-current', new globalThis.Highlight(occurrences[occurrenceIndex].range));
  }

  function refreshOccurrences() {
    clearTimeout(occurrenceRefreshTimer);
    occurrenceRefreshTimer = null;
    const previousCell = occurrences[occurrenceIndex]?.cell;
    occurrences = occurrenceRanges(selectedIdentifier);
    occurrenceIndex = previousCell ? occurrences.findIndex(({ cell }) => cell === previousCell) : (occurrences.length ? 0 : -1);
    if (occurrenceIndex < 0 && occurrences.length) occurrenceIndex = 0;
    paintOccurrences();
  }

  function scheduleOccurrenceRefresh() {
    if (!selectedIdentifier || occurrenceRefreshTimer) return;
    occurrenceRefreshTimer = setTimeout(refreshOccurrences, 30);
  }

  function clearSelectedSymbol() {
    selectedIdentifier = '';
    occurrences = [];
    occurrenceIndex = -1;
    clearTimeout(occurrenceRefreshTimer);
    occurrenceRefreshTimer = null;
    globalThis.CSS?.highlights?.delete('golens-symbol-occurrence');
    globalThis.CSS?.highlights?.delete('golens-symbol-current');
  }

  function selectSymbol(target) {
    selectedIdentifier = target.identifier;
    refreshOccurrences();
    const index = occurrences.findIndex(({ cell, character }) => cell === target.cell && character === target.character);
    if (index >= 0) occurrenceIndex = index;
    paintOccurrences();
    if (occurrences.length > 1) void legacy.offerShortcutCoach('nextOccurrence');
  }

  function navigateOccurrenceImpl(direction) {
    if (!occurrences.length) {
      legacy.toast(selectedIdentifier ? `No loaded occurrences of ${selectedIdentifier}.` : 'Click a Go symbol to select it first.');
      return false;
    }
    occurrenceIndex = (occurrenceIndex + direction + occurrences.length) % occurrences.length;
    const occurrence = occurrences[occurrenceIndex];
    paintOccurrences();
    occurrence.row.scrollIntoView({ behavior: globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
    flashDestination(occurrence.row);
    legacy.toast(`${selectedIdentifier} · ${occurrenceIndex + 1} of ${occurrences.length}`);
    return true;
  }

  function targetForOccurrence(occurrence, identifier) {
    if (!occurrence) return null;
    const bounds = occurrence.row.getBoundingClientRect();
    const parent = occurrence.range.startContainer.parentElement;
    const element = parent && parent !== occurrence.cell && (parent.textContent || '').trim() === identifier ? parent : null;
    return {
      identifier,
      character: occurrence.character,
      occurrence: occurrence.occurrence,
      cell: occurrence.cell,
      element,
      x: bounds.left + Math.min(bounds.width / 2, 240),
      y: bounds.top + Math.min(bounds.height / 2, 20),
    };
  }

  function targetForSelectedOccurrence() {
    return targetForOccurrence(occurrences[occurrenceIndex], selectedIdentifier);
  }

  // Own MutationObserver on the diff DOM (ticket 18's bookmarks.js
  // precedent: "the module owns marker/highlight placement", not a
  // registration API on go-navigation.js). No self-mutation guard is needed
  // for the loop-prevention reason ticket 18 needed one: painting occurrences
  // uses the CSS Custom Highlight API (`CSS.highlights.set(...)`), which
  // never mutates the DOM, so this observer cannot retrigger itself. It does
  // duplicate go-navigation.js's own `isBookmarkOnlyMutation` filter (see
  // that file's comment) so bookmark marker placement doesn't cause
  // unnecessary occurrence recomputation — before this ticket, occurrence
  // refresh and bookmark markers shared one observer with one guard;
  // splitting them must not silently start reacting to the other module's
  // DOM where the old code didn't.
  function isBookmarkOnlyMutation(mutation) {
    const nodes = [...mutation.addedNodes, ...mutation.removedNodes];
    return nodes.length > 0 && nodes.every((node) => node.nodeType === 1 && (
      node.matches?.('[data-golens-bookmark-marker], #golens-bookmark-selection-root')
      || node.querySelector?.('[data-golens-bookmark-marker], #golens-bookmark-selection-root')
    ));
  }

  // Plain setTimeout debounce, not go-navigation.js's former
  // legacyDebounceIdleFactory bridge (ticket 08's async page/platform/clock.js
  // import) — same choice ticket 18 made for bookmarks.js's own observer, "om
  // precies dezelfde getallen te garanderen" without depending on that
  // module's async-ready races. Preserves the same 50ms + 30ms timing
  // composition (mutation -> 50ms -> scheduleOccurrenceRefresh's own 30ms ->
  // refreshOccurrences) the original single shared observer had.
  function scheduleOccurrenceRefreshFromMutation() {
    clearTimeout(diffMutationTimer);
    diffMutationTimer = setTimeout(scheduleOccurrenceRefresh, 50);
  }

  // --- navigationAction(name) -> boolean ------------------------------------

  // navigationAction(name) -> boolean (handled?). The five actions
  // go-navigation.js's former runNavigationAction() used to own that belong
  // to code-intel: semanticJump, previousOccurrence, nextOccurrence,
  // historyBack, historyForward. The other three (toggleBookmark/
  // previousBookmark/nextBookmark) stayed in go-navigation.js's own
  // (shrunk) runNavigationAction, which forwards to bookmarks.js — not this
  // module's concern (see this file's header comment and keyboard-nav.js's
  // updated header comment for the split).
  function navigationAction(action) {
    if (!enabled) return false;
    if (action === 'semanticJump') {
      const target = targetForSelectedOccurrence();
      if (!target) legacy.toast('Click a Go symbol to select it first.');
      else navigateSemanticTarget(target);
      return true;
    }
    if (action === 'previousOccurrence') return navigateOccurrenceImpl(-1);
    if (action === 'nextOccurrence') return navigateOccurrenceImpl(1);
    if (action === 'historyBack') { navigateHistoryImpl(-1); return true; }
    if (action === 'historyForward') { navigateHistoryImpl(1); return true; }
    return false;
  }

  // --- enable / disable ------------------------------------------------------

  function setEnabled(next) {
    const value = Boolean(next);
    if (value === enabled) return;
    enabled = value;
    if (!legacy) return;
    if (enabled) {
      doc.addEventListener('mousemove', onMouseMove, true);
      doc.addEventListener('click', onClick, true);
      diffObserver = new MutationObserver((mutations) => {
        if (mutations.length && mutations.every(isBookmarkOnlyMutation)) return;
        scheduleOccurrenceRefreshFromMutation();
      });
      const diffObserverRoot = doc.getElementById('diffs') || doc.body;
      diffObserver.observe(diffObserverRoot, { childList: true, subtree: true, characterData: true });
    } else {
      clearTimeout(hoverTimer);
      handleMouseMovePoint.reset();
      clearTimeout(diffMutationTimer);
      diffMutationTimer = null;
      diffObserver?.disconnect();
      diffObserver = null;
      clearSelectedSymbol();
      history = [];
      historyIndex = -1;
      clearPinnedPopover();
      markTarget(null);
      doc.removeEventListener('mousemove', onMouseMove, true);
      doc.removeEventListener('click', onClick, true);
      hidePopover();
      ui?.remove();
      ui = null;
    }
  }

  return {
    unmount() {
      if (unmounted) return;
      unmounted = true;
      setEnabled(false);
    },
    setEnabled,
    navigationAction: legacy ? navigationAction : () => false,
    // --- self-bridge-only extras (documented deviation, ticket 04 §1's
    // "~5" budget — same allowance bookmarks.js/project-search.js already
    // used for their own self-bridge-only methods). None of these are ever
    // called by page/main.js's inert instance; go-navigation.js's own thin
    // forwarding functions (findReferencesAt/findImplementationsAt/
    // showResult/pinPopover/hidePopover, same names as before this ticket)
    // are the only callers, keeping project-search.js's and bookmarks.js's
    // existing `legacy` capability bags unchanged.
    findReferences: legacy ? findReferences : noLegacy({ status: 'notFound' }),
    findImplementations: legacy ? findImplementations : noLegacy({ status: 'notFound' }),
    showResult: legacy ? showResult : () => false,
    pinPopover: legacy ? pinPopover : () => {},
    hidePopover: legacy ? hidePopover : () => {},
    // showSearchProgress(message, pointer) -> see its own doc comment above.
    // Called by project-search.js's open() to drive the inline loading state
    // for a complete-project search, in the same popover.
    showSearchProgress: legacy ? showSearchProgress : () => {},
    // selectedSymbolLocation() -> the currently *hovered* target's source
    // location, or null. Used by bookmarks.js's `legacy.selectedSymbolLocation`
    // capability (ticket 18).
    selectedSymbolLocation: () => (legacy ? (() => {
      const loc = sourceLocationForTarget(activeTarget);
      return loc ? { identifier: activeTarget?.identifier || '', path: loc.path, side: loc.side, line: loc.line } : null;
    })() : null),
    // selectedOccurrenceSourceLocation() -> the currently *click-selected*
    // symbol's source location, or null. Used by go-navigation.js's shrunk
    // runNavigationAction() as the toggleBookmark fallback (byte-identical
    // to the former inline `sourceLocationForTarget(targetForSelectedOccurrence())`).
    selectedOccurrenceSourceLocation: () => (legacy ? sourceLocationForTarget(targetForSelectedOccurrence()) : null),
    // handleEscape(event) -> see its own doc comment above.
    handleEscape: legacy ? handleEscape : () => {},
    // __test: bends ticket 04 §1's "test surface = handle + internal.js pure
    // functions" on purpose, for exactly one reason — ticket 24's `npm run
    // bench` baseline benchmarks caretAtPoint/occurrenceRanges by name
    // (tests/benchmarks/diff-dom.bench.mjs), and 13-21's perf-regression
    // criterion is only checkable if those two rows stay comparable against
    // that baseline. Not for use outside tests/benchmarks/.
    __test: { caretAtPoint, occurrenceRanges },
  };
}

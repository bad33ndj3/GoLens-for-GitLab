import { css, html, LitElement, render } from 'lit';

import type { ActiveSurfaceProjection, ControlProjection, FullFileControlProjection } from './index.ts';

export type SurfaceIntent =
  | Readonly<{ command: ControlProjection['command'] }>
  | Readonly<{ command: 'dismiss-surface' }>
  | Readonly<{ command: 'surface-action'; actionId: string }>
  | Readonly<{ command: 'toggle-full-file'; path: FullFileControlProjection['path'] }>;

type SurfaceView = Readonly<{
  mode: 'controls' | 'surface' | 'full-file' | 'upgrade' | 'setup' | 'guide';
  controls: readonly ControlProjection[];
  surfaceProjection: ActiveSurfaceProjection | null;
  fullFile: FullFileControlProjection | null;
  setupFeatures: readonly Readonly<{ title: string; summary: string; chapter?: string }>[];
  setupHideGenerated: boolean;
  setupPreset: string;
}>;

function surfaceTemplate(state: SurfaceView, emit: (detail: SurfaceIntent) => void, dispatch: (event: Event) => void, update: (key: 'setupPreset' | 'setupHideGenerated', value: string | boolean) => void) {
  if (state.mode === 'controls') return html`<nav class="controls" aria-label="GoLens review controls">${state.controls.map((control) => {
    const cls = control.command === 'toggle-enabled' ? 'golens-toggle'
      : control.command === 'toggle-focus' ? 'focus-toggle'
      : control.command === 'cache-related' ? 'preload-toggle'
      : 'bookmark-toggle';
    const icon = control.command === 'toggle-enabled'
      ? html`<svg viewBox="0 0 24 24"><path d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z"/><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12z"/></svg>`
      : control.command === 'toggle-focus'
      ? html`<svg viewBox="0 0 24 24"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3m10 0h3a2 2 0 0 0 2-2v-3"/></svg>`
      : control.command === 'cache-related'
      ? html`<svg viewBox="0 0 24 24"><ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></svg>`
      : html`<svg viewBox="0 0 24 24"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>`;
    return html`
    <button type="button" class=${cls} data-command=${control.command}
      aria-label=${control.label} title=${control.label}
      aria-pressed=${control.pressed === undefined ? undefined : String(control.pressed)}
      ?disabled=${control.disabled || control.busy}
      data-state=${control.busy ? 'busy' : (control as any).state || ''}
      @click=${() => emit({ command: control.command })}>${icon}</button>`;
  })}</nav>`;
  if (state.mode === 'full-file') {
    const control = state.fullFile!; const label = control.error ? 'Retry showing full file' : control.full ? 'Show changes only' : 'Show full file';
    return html`<span class="file-control"><button type="button" ?disabled=${control.busy} aria-busy=${control.busy ? 'true' : undefined}
      aria-label="${control.busy ? 'Loading full file' : label} ${control.path}" title=${control.error || label} @click=${() => emit({ command: 'toggle-full-file', path: control.path })}>${control.busy
        ? html`<svg class="spinner" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/></svg>`
        : control.full
          ? html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16M4 19h16M12 15V9m0 0-3 3m3-3 3 3"/></svg>`
          : html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16M4 19h16M12 9v6m0 0-3-3m3 3 3-3"/></svg>`}</button></span>`;
  }
  if (state.mode === 'upgrade') return html`<div class="backdrop"><section class="surface" role="dialog" aria-modal="true" aria-labelledby="golens-upgrade-title">
    <header><h2 id="golens-upgrade-title">GoLens was rebuilt</h2><button type="button" data-close @click=${() => dispatch(new CustomEvent('golens-upgrade-dismiss'))}>Close</button></header>
    <p>This update reset your GoLens settings, shortcuts, bookmarks, and cached Go source. Your GitLab repositories and GitLab data were not changed.</p>
    <div class="actions"><button type="button" class="primary" @click=${() => dispatch(new CustomEvent('golens-upgrade-continue'))}>Continue setup</button></div>
  </section></div>`;
  if (state.mode === 'setup') return html`<div class="backdrop"><section class="surface" role="dialog" aria-modal="true" aria-labelledby="golens-setup-title">
    <header><h2 id="golens-setup-title">Set up GoLens</h2><button type="button" @click=${() => dispatch(new CustomEvent('golens-setup-dismiss'))}>Not now</button></header>
    <p>Choose the two review preferences that matter before you start. These save together when setup finishes.</p>
    <div class="setup-fields"><label>Keymap preset<select .value=${state.setupPreset} @change=${(event: Event) => update('setupPreset', (event.target as HTMLSelectElement).value)}>
      ${state.setupPreset === 'custom' ? html`<option value="custom">Keep current shortcuts</option>` : ''}<option value="golens">GoLens</option><option value="vscode">VS Code</option><option value="intellij">IntelliJ IDEA</option><option value="vim">Vim-style</option>
    </select></label><label><span><input type="checkbox" .checked=${state.setupHideGenerated} @change=${(event: Event) => update('setupHideGenerated', (event.target as HTMLInputElement).checked)}> Hide GitLab-marked generated files</span></label></div>
    <strong>Essential interactions</strong><ul>${state.setupFeatures.map((feature) => html`<li><strong>${feature.title}</strong> — ${feature.summary}</li>`)}</ul>
    <div class="actions"><button type="button" class="primary" @click=${() => dispatch(new CustomEvent('golens-setup-complete', { detail: { preset: state.setupPreset, hideGeneratedFiles: state.setupHideGenerated } }))}>Finish setup</button></div>
  </section></div>`;
  if (state.mode === 'guide') {
    const chapters = new Map<string, typeof state.setupFeatures>();
    for (const feature of state.setupFeatures) chapters.set(feature.chapter || 'Features', [...(chapters.get(feature.chapter || 'Features') || []), feature]);
    return html`<div class="backdrop"><section class="surface" role="dialog" aria-modal="true" aria-labelledby="golens-guide-title">
      <header><h2 id="golens-guide-title">GoLens feature guide</h2><button type="button" @click=${() => dispatch(new CustomEvent('golens-guide-dismiss'))}>Close</button></header>
      <p>The complete reference for the features available during GitLab review.</p>${[...chapters].map(([chapter, features]) => html`<section><h3>${chapter}</h3><ul>${features.map((feature) => html`<li><strong>${feature.title}</strong> — ${feature.summary}</li>`)}</ul></section>`)}
    </section></div>`;
  }
  const projection = state.surfaceProjection!;
  if (projection.kind === 'status') return html`<div class="status" role="status" aria-live="polite">${projection.body || projection.title}</div>`;
  const isPopover = projection.kind === 'popover';
  const modal = projection.modal !== false && projection.kind === 'dialog';
  return html`<div class=${modal ? 'backdrop' : ''}><section class=${`surface ${isPopover ? 'popover' : ''}`} role=${modal ? 'dialog' : 'region'} aria-modal=${modal ? 'true' : undefined} aria-labelledby="golens-surface-title">
    <header><h2 id="golens-surface-title">${projection.title}</h2><button type="button" data-close aria-label="Close ${projection.title}" @click=${() => emit({ command: 'dismiss-surface' })}><svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1 1l8 8M9 1L1 9"/></svg></button></header>
    ${projection.body ? html`<div class="surface-body">${projection.body}</div>` : ''}
    ${(projection.actions && projection.actions.length > 0) ? html`<div class="actions">${projection.actions.map((action) => html`<button type="button" class=${action.primary ? 'primary' : ''} @click=${() => emit({ command: 'surface-action', actionId: action.id })}>${action.label}</button>`)}</div>` : ''}
  </section></div>`;
}

function handleSurfaceKeyDown(event: KeyboardEvent, state: SurfaceView, root: ParentNode, activeElement: Element | null, emit: (detail: SurfaceIntent) => void, dispatch: (event: Event) => void): void {
  if (state.mode !== 'surface' && state.mode !== 'upgrade' && state.mode !== 'setup' && state.mode !== 'guide') return;
  if (event.key === 'Escape') {
    event.preventDefault();
    if (state.mode === 'upgrade') dispatch(new CustomEvent('golens-upgrade-dismiss'));
    else if (state.mode === 'setup') dispatch(new CustomEvent('golens-setup-dismiss'));
    else if (state.mode === 'guide') dispatch(new CustomEvent('golens-guide-dismiss'));
    else emit({ command: 'dismiss-surface' });
    return;
  }
  if (event.key !== 'Tab' || state.mode === 'surface' && (state.surfaceProjection?.modal === false || state.surfaceProjection?.kind !== 'dialog')) return;
  const focusable = [...root.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled])')];
  const first = focusable[0]; const last = focusable[focusable.length - 1];
  if (event.shiftKey && activeElement === first) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && activeElement === last) { event.preventDefault(); first?.focus(); }
}

class GoLensHostSurface extends LitElement {
  static properties = {
    mode: { type: String },
    controls: { attribute: false },
    surfaceProjection: { attribute: false },
    fullFile: { attribute: false },
    setupFeatures: { attribute: false },
    setupHideGenerated: { type: Boolean },
    setupPreset: { type: String },
  };

  static styles = css`
    :host { all:initial; position:relative; display:inline-block; color-scheme:dark; font:13px/1.4 var(--golens-font-ui); color:var(--golens-text-primary); }
    * { box-sizing:border-box; }
    .controls { display:grid; gap:var(--golens-space-1, 4px); padding:var(--golens-space-1, 4px); border:1px solid var(--golens-border-subtle); border-radius:var(--golens-radius-md); background:var(--golens-surface-panel); box-shadow:var(--golens-shadow-sm); }
    button { position:relative; display:grid; place-items:center; width:32px; height:32px; overflow:hidden; padding:0; border:1px solid transparent; border-radius:var(--golens-radius-sm); background:transparent; color:var(--golens-text-secondary); cursor:pointer; transition:background-color var(--golens-motion-fast) var(--golens-ease-out),border-color var(--golens-motion-fast) var(--golens-ease-out),color var(--golens-motion-fast) var(--golens-ease-out),transform var(--golens-motion-fast) var(--golens-ease-out),opacity var(--golens-motion-fast) var(--golens-ease-out); }
    button:hover:not(:disabled) { border-color:var(--golens-border-strong); background:var(--golens-surface-hover); color:var(--golens-text-primary); }
    button:active:not(:disabled) { background:var(--golens-surface-pressed); transform:translateY(1px); }
    button:focus-visible { outline:2px solid var(--golens-focus-ring); outline-offset:2px; }
    button:disabled { cursor:not-allowed; opacity:.42; }
    button > svg { width:18px; height:18px; fill:none; stroke:currentColor; stroke-linecap:round; stroke-linejoin:round; stroke-width:1.75; }
    button img { grid-area:1/1; width:24px; height:24px; border-radius:var(--golens-radius-xs); object-fit:contain; transition:opacity var(--golens-motion-base) var(--golens-ease-out),transform var(--golens-motion-base) var(--golens-ease-out); }
    .golens-toggle[aria-pressed="true"] { border-color:var(--golens-primary); background:var(--golens-primary-soft); color:var(--golens-primary-hover); }
    .golens-toggle:not([aria-pressed="true"]) img { filter:grayscale(1); opacity:.58; }
    .golens-toggle .mascot-focus { opacity:0; transform:scale(.72); }
    .golens-toggle[data-review-focus="true"] .mascot-default { opacity:0; transform:scale(.82); }
    .golens-toggle[data-review-focus="true"] .mascot-focus { opacity:1; transform:scale(1); }
    .focus-toggle { color:var(--golens-info); }
    .focus-toggle[aria-pressed="true"] { border-color:var(--golens-info); background:var(--golens-info-soft); color:var(--golens-info-hover); box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--golens-info) 18%,transparent); }
    .focus-toggle:disabled { filter:grayscale(1); }
    .preload-toggle { color:var(--golens-primary-hover); }
    .preload-toggle[data-state="complete"] { border-color:var(--golens-success); background:var(--golens-success-soft); color:var(--golens-success); }
    .preload-toggle[data-state="error"] { border-color:var(--golens-error); background:var(--golens-error-soft); color:var(--golens-error); }
    .preload-toggle[data-state="checking"],.preload-toggle[data-state="busy"] { cursor:progress; opacity:1; }
    .preload-toggle:disabled:not([data-state="checking"]):not([data-state="busy"]) { filter:grayscale(1); }
    .bookmark-toggle { color:var(--golens-info); overflow:visible; }
    .bookmark-toggle[aria-expanded="true"] { border-color:var(--golens-info); background:var(--golens-info-soft); color:var(--golens-info-hover); }
    .bookmark-count { position:absolute; right:-4px; bottom:-4px; min-width:15px; height:15px; padding:0 3px; border:2px solid var(--golens-surface-panel); border-radius:999px; background:var(--golens-primary); color:var(--golens-text-inverse); font:800 8px/11px var(--golens-font-mono); font-variant-numeric:tabular-nums; }
    .bookmark-count[hidden] { display:none; }
    .backdrop { position:fixed; inset:0; z-index:2147483000; display:grid; place-items:center; overflow:auto; padding:var(--golens-space-6, 32px); background:rgba(9,10,12,.82); backdrop-filter:blur(4px); }
    .surface { position:relative; display:grid; grid-template-rows:auto minmax(0,1fr) auto; width:min(680px,calc(100vw - 32px)); max-height:min(680px,calc(100dvh - 32px)); overflow:hidden; border:1px solid var(--golens-border-default); border-radius:var(--golens-radius-xl, 14px); background:var(--golens-surface-panel); box-shadow:var(--golens-shadow-lg); }
.surface.popover { width:min(440px,calc(100vw - 24px)); max-height:min(280px,calc(100vh - 24px)); border-radius:var(--golens-radius-panel, 9px); border:1px solid var(--golens-border-default); background:var(--golens-surface-panel); box-shadow:var(--golens-shadow-lg); }
.surface.popover > header { display:flex; align-items:flex-start; gap:8px; padding:9px 10px 9px 14px; background:var(--golens-surface-raised); border-bottom:1px solid var(--golens-border-subtle); }
.surface.popover > header h2 { flex:1 1 0; min-width:0; font:600 11.5px/1.5 var(--golens-font-mono, monospace); color:#dcdcaa; word-break:break-word; white-space:pre-wrap; overflow:hidden; }
.surface.popover > header [data-close] { position:static; flex-shrink:0; align-self:flex-start; width:24px; height:24px; margin-top:1px; }
.surface.popover > header [data-close] > svg { width:10px; height:10px; stroke-width:2; }
.surface.popover .surface-body { padding:10px 14px; font-size:12px; color:var(--golens-text-secondary); line-height:1.55; white-space:pre-wrap; }
.surface.popover .actions { padding:7px 10px; gap:6px; flex-wrap:wrap; border-top:1px solid var(--golens-border-subtle); background:var(--golens-surface-raised); }
.surface.popover .actions button { width:auto; height:auto; padding:4px 10px; font-size:11px; }
    .surface > header { display:grid; grid-template-columns:56px minmax(0,1fr); gap:var(--golens-space-4, 16px); align-items:center; padding:var(--golens-space-5, 24px) var(--golens-space-6, 32px); border-bottom:1px solid var(--golens-border-subtle); background:var(--golens-surface-raised); }
    .surface > header h2 { margin:0; font-size:20px; line-height:1.2; letter-spacing:-.015em; }
    .surface > header p { margin:4px 0 0; color:var(--golens-text-secondary); font-size:12px; }
    .surface > header [data-close] { position:absolute; top:var(--golens-space-3, 12px); right:var(--golens-space-3, 12px); width:32px; height:32px; place-items:center; border:1px solid transparent; border-radius:var(--golens-radius-sm); background:transparent; color:var(--golens-text-muted); font:22px/1 var(--golens-font-ui); }
    .surface > header [data-close]:hover { border-color:var(--golens-border-default); background:var(--golens-surface-hover); color:var(--golens-text-primary); }
    .surface-body { min-height:0; overflow:auto; padding:var(--golens-space-6, 32px); }
    h2,h3 { margin:0; color:var(--golens-text-primary); }
    p { margin:0 0 12px; color:var(--golens-text-secondary); font-size:13px; }
    .actions { display:flex; align-items:center; justify-content:flex-end; gap:var(--golens-space-3, 12px); padding:var(--golens-space-3, 12px) var(--golens-space-5, 24px); border-top:1px solid var(--golens-border-subtle); background:var(--golens-surface-raised); }
    .secondary,.primary { min-height:36px; padding:0 var(--golens-space-4, 16px); border-radius:var(--golens-radius-sm); cursor:pointer; font:750 12px/1 var(--golens-font-ui); white-space:nowrap; transition:background-color var(--golens-motion-fast),border-color var(--golens-motion-fast),color var(--golens-motion-fast),transform var(--golens-motion-fast); }
    .secondary { border:1px solid var(--golens-border-default); background:transparent; color:var(--golens-text-secondary); }
    .secondary:hover { border-color:var(--golens-border-strong); background:var(--golens-surface-hover); color:var(--golens-text-primary); }
    .primary { border:1px solid var(--golens-primary); background:var(--golens-primary); color:var(--golens-text-inverse); font-weight:800; }
    .primary:hover { border-color:var(--golens-primary-hover); background:var(--golens-primary-hover); }
    .secondary:active,.primary:active { transform:translateY(1px); }
    .status { position:fixed; right:16px; bottom:16px; z-index:2147482999; padding:10px 14px; border:1px solid var(--golens-border-default); border-radius:var(--golens-radius-md); background:var(--golens-surface-panel); box-shadow:var(--golens-shadow-md); color:var(--golens-text-primary); font-size:12px; }
    .file-control { display:inline-flex; align-items:center; }
    .file-control button { width:32px; height:32px; color:inherit; }
    .file-control button:hover:not(:disabled) { background:var(--golens-surface-hover); }
    .file-control .spinner { animation:spin .8s linear infinite; stroke-dasharray:38 14; }
    @keyframes spin { to { transform:rotate(360deg); } }
    .setup-fields { display:grid; gap:12px; margin:16px 0; }
    label { display:grid; gap:5px; font-size:12px; color:var(--golens-text-secondary); }
    select { min-height:34px; border:1px solid var(--golens-border-default); border-radius:var(--golens-radius-sm); background:var(--golens-surface-inset); color:var(--golens-text-primary); padding:0 8px; font:inherit; }
    ul { margin:8px 0 0; padding-left:20px; color:var(--golens-text-secondary); font-size:12px; line-height:1.6; }
    li { margin-bottom:4px; }
    li strong { color:var(--golens-text-primary); }
    @media (prefers-reduced-motion:reduce) { button,button img,.surface,.secondary,.primary { transition:none; } button:active:not(:disabled),.secondary:active,.primary:active { transform:none; } .backdrop { backdrop-filter:none; } }
  `;

  mode: 'controls' | 'surface' | 'full-file' | 'upgrade' | 'setup' | 'guide' = 'controls';
  controls: readonly ControlProjection[] = [];
  surfaceProjection: ActiveSurfaceProjection | null = null;
  fullFile: FullFileControlProjection | null = null;
  setupFeatures: readonly Readonly<{ title: string; summary: string; chapter?: string }>[] = [];
  setupHideGenerated = false;
  setupPreset = 'golens';
  #lifecycle = new AbortController();
  #returnFocus: HTMLElement | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    this.#lifecycle = new AbortController();
    const HTMLElementConstructor = this.ownerDocument.defaultView?.HTMLElement;
    this.#returnFocus = HTMLElementConstructor && this.ownerDocument.activeElement instanceof HTMLElementConstructor
      ? this.ownerDocument.activeElement as HTMLElement : null;
    this.addEventListener('keydown', this.#onKeyDown, { signal: this.#lifecycle.signal });
  }

  protected override updated(): void {
    if ((this.mode === 'surface' || this.mode === 'upgrade' || this.mode === 'setup' || this.mode === 'guide') && !this.shadowRoot?.activeElement) this.renderRoot.querySelector<HTMLElement>('[data-close],button,select')?.focus();
  }

  override disconnectedCallback(): void {
    this.#lifecycle.abort();
    if ((this.mode === 'surface' || this.mode === 'upgrade' || this.mode === 'setup' || this.mode === 'guide') && this.#returnFocus?.isConnected) this.#returnFocus.focus();
    this.#returnFocus = null;
    super.disconnectedCallback();
  }

  #emit(detail: SurfaceIntent): void {
    if (this.#lifecycle.signal.aborted) return;
    this.dispatchEvent(new CustomEvent<SurfaceIntent>('golens-intent', { bubbles: true, composed: true, detail }));
  }

  #onKeyDown = (event: KeyboardEvent): void => {
    handleSurfaceKeyDown(event, this, this.renderRoot, this.shadowRoot?.activeElement || null, (detail) => this.#emit(detail), (value) => { this.dispatchEvent(value); });
  };

  override render() {
    return surfaceTemplate(this, (detail) => this.#emit(detail), (event) => { this.dispatchEvent(event); }, (key, value) => { if (key === 'setupPreset') this.setupPreset = value as string; else this.setupHideGenerated = value as boolean; });
  }
}

function create(hostDocument: Document): GoLensHostSurface {
  const registry = hostDocument.defaultView?.customElements;
  if (!registry) return createUnregistered(hostDocument) as GoLensHostSurface;
  if (!registry.get('golens-host-surface')) registry.define('golens-host-surface', GoLensHostSurface);
  return hostDocument.createElement('golens-host-surface') as GoLensHostSurface;
}

function createUnregistered(hostDocument: Document): HTMLElement {
  const host = hostDocument.createElement('golens-host-surface') as HTMLElement & Record<string, unknown>;
  const shadow = host.attachShadow({ mode: 'open' });
  const style = hostDocument.createElement('style');
  style.textContent = (GoLensHostSurface.styles as typeof GoLensHostSurface.styles & { cssText: string }).cssText;
  const root = hostDocument.createElement('div');
  shadow.append(style, root);
  const state: Record<string, unknown> = {
    mode: 'controls', controls: [], surfaceProjection: null, fullFile: null,
    setupFeatures: [], setupHideGenerated: false, setupPreset: 'golens',
  };
  let updateComplete = Promise.resolve();
  let resolveUpdate = () => {};
  let scheduled = false;
  const emit = (detail: SurfaceIntent) => host.dispatchEvent(new CustomEvent<SurfaceIntent>('golens-intent', { bubbles: true, composed: true, detail }));
  const template = () => surfaceTemplate(state as unknown as SurfaceView, emit, (event) => { host.dispatchEvent(event); }, (key, value) => { state[key] = value; });
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    updateComplete = new Promise<void>((resolve) => { resolveUpdate = resolve; });
    queueMicrotask(() => { scheduled = false; render(template(), root); resolveUpdate(); if (state.mode === 'surface' || state.mode === 'upgrade' || state.mode === 'setup' || state.mode === 'guide') root.querySelector<HTMLElement>('[data-close],button,select')?.focus(); });
  };
  for (const key of Object.keys(state)) Object.defineProperty(host, key, { get: () => state[key], set: (value) => { state[key] = value; schedule(); } });
  Object.defineProperty(host, 'updateComplete', { get: () => updateComplete });
  host.addEventListener('keydown', (event) => handleSurfaceKeyDown(event, state as unknown as SurfaceView, root, shadow.activeElement, emit, (value) => { host.dispatchEvent(value); }));
  schedule();
  return host;
}

export function controlsSurface(hostDocument: Document, controls: readonly ControlProjection[]): HTMLElement {
  const host = create(hostDocument);
  host.mode = 'controls';
  host.controls = controls;
  return host;
}

export function activeSurface(hostDocument: Document, projection: ActiveSurfaceProjection): HTMLElement {
  const host = create(hostDocument);
  host.mode = 'surface';
  host.surfaceProjection = projection;
  return host;
}

export function showStorageResetProgress(hostDocument: Document): () => void {
  const host = activeSurface(hostDocument, { kind: 'status', title: 'Finishing the GoLens update…' });
  host.id = 'golens-storage-reset-root';
  hostDocument.documentElement.append(host);
  return () => host.remove();
}

export function fullFileSurface(hostDocument: Document, projection: FullFileControlProjection): HTMLElement {
  const host = create(hostDocument);
  host.mode = 'full-file';
  host.fullFile = projection;
  return host;
}

export function showExtensionSettings(hostWindow: Window, url: string): () => void {
  const existing = hostWindow.document.querySelector<HTMLElement>('#golens-settings-root');
  if (existing) return () => existing.remove();
  const HTMLElementConstructor = hostWindow.document.defaultView?.HTMLElement;
  const returnFocus = HTMLElementConstructor && hostWindow.document.activeElement instanceof HTMLElementConstructor ? hostWindow.document.activeElement : null;
  const root = hostWindow.document.createElement('div');
  root.id = 'golens-settings-root';
  const shadow = root.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>
    :host{all:initial} .backdrop{position:fixed;inset:0;z-index:2147483646;display:grid;place-items:center;padding:32px;background:rgb(3 7 12/.76)}
    .dialog{display:contents}
    iframe{width:min(1080px,calc(100vw - 64px));height:min(760px,calc(100vh - 64px));border:1px solid #334155;border-radius:12px;background:#07111d;box-shadow:0 24px 70px rgb(0 0 0/.55)}
    @media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
  </style><div class="backdrop"><div class="dialog" role="dialog" aria-modal="true" aria-label="GoLens settings"><iframe title="GoLens settings"></iframe></div></div>`;
  const frame = shadow.querySelector('iframe')!;
  frame.src = url;
  const lifecycle = new AbortController();
  const close = () => { lifecycle.abort(); root.remove(); if (returnFocus?.isConnected) (returnFocus as HTMLElement).focus(); };
  shadow.querySelector('.backdrop')!.addEventListener('click', (event) => { if (event.target === event.currentTarget) close(); });
  hostWindow.addEventListener('message', (event) => { if (event.source === frame.contentWindow && event.data?.type === 'golens:settings:close') close(); }, { signal: lifecycle.signal });
  root.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });
  hostWindow.document.documentElement.append(root);
  frame.focus();
  return close;
}

export function showFirstRunSetup(hostDocument: Document, features: readonly Readonly<{ title: string; summary: string; chapter?: string }>[], hideGeneratedFiles: boolean, preset: string, signal: AbortSignal): Promise<Readonly<{ preset: string; hideGeneratedFiles: boolean }> | null> {
  const host = create(hostDocument);
  host.id = 'golens-onboarding-root';
  host.mode = 'setup';
  host.setupFeatures = features;
  host.setupHideGenerated = hideGeneratedFiles;
  host.setupPreset = preset;
  hostDocument.documentElement.append(host);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: Readonly<{ preset: string; hideGeneratedFiles: boolean }> | null) => {
      if (settled) return;
      settled = true;
      host.remove();
      resolve(value);
    };
    host.addEventListener('golens-setup-complete', (event) => finish((event as CustomEvent).detail), { once: true });
    host.addEventListener('golens-setup-dismiss', () => finish(null), { once: true });
    if (signal.aborted) finish(null); else signal.addEventListener('abort', () => finish(null), { once: true });
  });
}

export function showUpgradeNotice(hostDocument: Document, signal: AbortSignal): Promise<boolean> {
  const host = create(hostDocument);
  host.id = 'golens-onboarding-root';
  host.mode = 'upgrade';
  hostDocument.documentElement.append(host);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (continued: boolean) => {
      if (settled) return;
      settled = true;
      host.remove();
      resolve(continued);
    };
    host.addEventListener('golens-upgrade-continue', () => finish(true), { once: true });
    host.addEventListener('golens-upgrade-dismiss', () => finish(false), { once: true });
    if (signal.aborted) finish(false); else signal.addEventListener('abort', () => finish(false), { once: true });
  });
}

export function showFeatureGuide(hostDocument: Document, features: readonly Readonly<{ title: string; summary: string; chapter: string }>[]): () => void {
  const existing = hostDocument.querySelector<HTMLElement>('#golens-feature-guide-root');
  if (existing) return () => existing.remove();
  const host = create(hostDocument);
  host.id = 'golens-feature-guide-root';
  host.mode = 'guide';
  host.setupFeatures = features;
  const close = () => host.remove();
  host.addEventListener('golens-guide-dismiss', close, { once: true });
  hostDocument.documentElement.append(host);
  return close;
}

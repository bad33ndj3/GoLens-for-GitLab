import { css, html, LitElement } from 'lit';

import type { ActiveSurfaceProjection, ControlProjection, FullFileControlProjection } from './index.ts';

export type SurfaceIntent =
  | Readonly<{ command: ControlProjection['command'] }>
  | Readonly<{ command: 'dismiss-surface' }>
  | Readonly<{ command: 'surface-action'; actionId: string }>
  | Readonly<{ command: 'toggle-full-file'; path: FullFileControlProjection['path'] }>;

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
    :host { all:initial; color-scheme:dark; font:13px/1.4 var(--golens-font-ui); color:var(--golens-text-primary); }
    * { box-sizing:border-box; }
    .controls { display:grid; gap:6px; margin:4px; }
    button { border:1px solid var(--golens-border-default); border-radius:var(--golens-radius-sm); padding:7px 9px; background:var(--golens-surface-panel); color:var(--golens-text-primary); font:inherit; cursor:pointer; }
    button[aria-pressed="true"],button.primary { border-color:var(--golens-primary); color:var(--golens-primary-hover); }
    button:focus-visible { outline:2px solid var(--golens-focus-ring); outline-offset:2px; }
    .backdrop { position:fixed; inset:0; z-index:2147483000; display:grid; place-items:center; padding:24px; background:rgb(3 7 12 / 72%); }
    .surface { width:min(620px,calc(100vw - 48px)); max-height:calc(100vh - 48px); overflow:auto; padding:20px; border:1px solid var(--golens-border-default); border-radius:var(--golens-radius-overlay); background:var(--golens-surface-panel); box-shadow:var(--golens-shadow-overlay); transition:opacity 160ms ease,transform 160ms ease; }
    header,.actions { display:flex; align-items:center; justify-content:space-between; gap:10px; } h2,p { margin:0 0 12px; } .actions { justify-content:flex-end; }
    .status { position:fixed; right:16px; bottom:16px; z-index:2147482999; padding:10px 12px; border:1px solid var(--golens-border-default); border-radius:8px; background:var(--golens-surface-panel); }
    .file-control { display:inline-flex; align-items:center; gap:6px; } .error { color:var(--golens-danger); }
    .setup-fields { display:grid; gap:12px; margin:16px 0; } label { display:grid; gap:5px; } select { min-height:34px; border:1px solid var(--golens-border-default); border-radius:6px; background:var(--golens-surface-inset); color:inherit; padding:0 8px; }
    ul { margin:8px 0 0; padding-left:20px; color:var(--golens-text-secondary); }
    @media (prefers-reduced-motion:reduce) { .surface { transition:none; } }
  `;

  mode: 'controls' | 'surface' | 'full-file' | 'setup' | 'guide' = 'controls';
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
    if ((this.mode === 'surface' || this.mode === 'setup' || this.mode === 'guide') && !this.shadowRoot?.activeElement) this.renderRoot.querySelector<HTMLElement>('[data-close],button,select')?.focus();
  }

  override disconnectedCallback(): void {
    this.#lifecycle.abort();
    if ((this.mode === 'surface' || this.mode === 'setup' || this.mode === 'guide') && this.#returnFocus?.isConnected) this.#returnFocus.focus();
    this.#returnFocus = null;
    super.disconnectedCallback();
  }

  #emit(detail: SurfaceIntent): void {
    if (this.#lifecycle.signal.aborted) return;
    this.dispatchEvent(new CustomEvent<SurfaceIntent>('golens-intent', { bubbles: true, composed: true, detail }));
  }

  #onKeyDown = (event: KeyboardEvent): void => {
    if (this.mode !== 'surface' && this.mode !== 'setup' && this.mode !== 'guide') return;
    if (event.key === 'Escape') { event.preventDefault(); if (this.mode === 'setup') this.dispatchEvent(new CustomEvent('golens-setup-dismiss')); else if (this.mode === 'guide') this.dispatchEvent(new CustomEvent('golens-guide-dismiss')); else this.#emit({ command: 'dismiss-surface' }); return; }
    if (event.key !== 'Tab' || (this.mode === 'surface' && (this.surfaceProjection?.modal === false || this.surfaceProjection?.kind !== 'dialog'))) return;
    const focusable = [...this.renderRoot.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled])')];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && this.shadowRoot?.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && this.shadowRoot?.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  #renderControls() {
    return html`<nav class="controls" aria-label="GoLens review controls">${this.controls.map((control) => html`
      <button type="button" data-command=${control.command} aria-label=${control.label} title=${control.label}
        aria-pressed=${control.pressed === undefined ? undefined : String(control.pressed)} ?disabled=${control.disabled || control.busy}
        @click=${() => this.#emit({ command: control.command })}>${control.busy ? '…' : control.label}</button>
    `)}</nav>`;
  }

  #renderFullFile() {
    const control = this.fullFile!;
    const label = control.full ? 'Show changes only' : 'Show full file';
    return html`<span class="file-control"><button type="button" ?disabled=${control.busy} aria-busy=${control.busy ? 'true' : undefined}
      aria-label="${label} ${control.path}" @click=${() => this.#emit({ command: 'toggle-full-file', path: control.path })}>${control.busy ? 'Loading…' : label}</button>
      ${control.error ? html`<span class="error" role="status">${control.error}</span>` : ''}</span>`;
  }

  #renderSurface() {
    const projection = this.surfaceProjection!;
    const modal = projection.modal !== false && projection.kind === 'dialog';
    if (projection.kind === 'status') return html`<div class="status" role="status" aria-live="polite">${projection.body || projection.title}</div>`;
    return html`<div class=${modal ? 'backdrop' : ''}><section class="surface" role=${modal ? 'dialog' : 'region'} aria-modal=${modal ? 'true' : undefined} aria-labelledby="golens-surface-title">
      <header><h2 id="golens-surface-title">${projection.title}</h2><button type="button" data-close aria-label="Close ${projection.title}" @click=${() => this.#emit({ command: 'dismiss-surface' })}>Close</button></header>
      ${projection.body ? html`<p>${projection.body}</p>` : ''}
      <div class="actions">${(projection.actions || []).map((action) => html`<button type="button" class=${action.primary ? 'primary' : ''} @click=${() => this.#emit({ command: 'surface-action', actionId: action.id })}>${action.label}</button>`)}</div>
    </section></div>`;
  }

  #renderSetup() {
    return html`<div class="backdrop"><section class="surface" role="dialog" aria-modal="true" aria-labelledby="golens-setup-title">
      <header><h2 id="golens-setup-title">Set up GoLens</h2><button type="button" @click=${() => this.dispatchEvent(new CustomEvent('golens-setup-dismiss'))}>Not now</button></header>
      <p>Choose the two review preferences that matter before you start. These save together when setup finishes.</p>
      <div class="setup-fields"><label>Keymap preset<select .value=${this.setupPreset} @change=${(event: Event) => { this.setupPreset = (event.target as HTMLSelectElement).value; }}>
        ${this.setupPreset === 'custom' ? html`<option value="custom">Keep current shortcuts</option>` : ''}<option value="golens">GoLens</option><option value="vscode">VS Code</option><option value="intellij">IntelliJ IDEA</option><option value="vim">Vim-style</option>
      </select></label><label><span><input type="checkbox" .checked=${this.setupHideGenerated} @change=${(event: Event) => { this.setupHideGenerated = (event.target as HTMLInputElement).checked; }}> Hide GitLab-marked generated files</span></label></div>
      <strong>Essential interactions</strong><ul>${this.setupFeatures.map((feature) => html`<li><strong>${feature.title}</strong> — ${feature.summary}</li>`)}</ul>
      <div class="actions"><button type="button" class="primary" @click=${() => this.dispatchEvent(new CustomEvent('golens-setup-complete', { detail: { preset: this.setupPreset, hideGeneratedFiles: this.setupHideGenerated } }))}>Finish setup</button></div>
    </section></div>`;
  }

  #renderGuide() {
    const chapters = new Map<string, typeof this.setupFeatures>();
    for (const feature of this.setupFeatures) chapters.set(feature.chapter || 'Features', [...(chapters.get(feature.chapter || 'Features') || []), feature]);
    return html`<div class="backdrop"><section class="surface" role="dialog" aria-modal="true" aria-labelledby="golens-guide-title">
      <header><h2 id="golens-guide-title">GoLens feature guide</h2><button type="button" @click=${() => this.dispatchEvent(new CustomEvent('golens-guide-dismiss'))}>Close</button></header>
      <p>The complete reference for the features available during GitLab review.</p>${[...chapters].map(([chapter, features]) => html`<section><h3>${chapter}</h3><ul>${features.map((feature) => html`<li><strong>${feature.title}</strong> — ${feature.summary}</li>`)}</ul></section>`)}
    </section></div>`;
  }

  override render() {
    if (this.mode === 'surface' && this.surfaceProjection) return this.#renderSurface();
    if (this.mode === 'setup') return this.#renderSetup();
    if (this.mode === 'guide') return this.#renderGuide();
    if (this.mode === 'full-file' && this.fullFile) return this.#renderFullFile();
    return this.#renderControls();
  }
}

function create(hostDocument: Document): GoLensHostSurface {
  if (!hostDocument.defaultView?.customElements.get('golens-host-surface')) hostDocument.defaultView?.customElements.define('golens-host-surface', GoLensHostSurface);
  return hostDocument.createElement('golens-host-surface') as GoLensHostSurface;
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

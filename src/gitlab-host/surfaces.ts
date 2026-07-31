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
    @media (prefers-reduced-motion:reduce) { .surface { transition:none; } }
  `;

  mode: 'controls' | 'surface' | 'full-file' = 'controls';
  controls: readonly ControlProjection[] = [];
  surfaceProjection: ActiveSurfaceProjection | null = null;
  fullFile: FullFileControlProjection | null = null;
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
    if (this.mode === 'surface' && !this.shadowRoot?.activeElement) this.renderRoot.querySelector<HTMLElement>('[data-close],button')?.focus();
  }

  override disconnectedCallback(): void {
    this.#lifecycle.abort();
    if (this.mode === 'surface' && this.#returnFocus?.isConnected) this.#returnFocus.focus();
    this.#returnFocus = null;
    super.disconnectedCallback();
  }

  #emit(detail: SurfaceIntent): void {
    if (this.#lifecycle.signal.aborted) return;
    this.dispatchEvent(new CustomEvent<SurfaceIntent>('golens-intent', { bubbles: true, composed: true, detail }));
  }

  #onKeyDown = (event: KeyboardEvent): void => {
    if (this.mode !== 'surface') return;
    if (event.key === 'Escape') { event.preventDefault(); this.#emit({ command: 'dismiss-surface' }); return; }
    if (event.key !== 'Tab' || this.surfaceProjection?.modal === false || this.surfaceProjection?.kind !== 'dialog') return;
    const focusable = [...this.renderRoot.querySelectorAll<HTMLButtonElement>('button:not([disabled])')];
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

  override render() {
    if (this.mode === 'surface' && this.surfaceProjection) return this.#renderSurface();
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

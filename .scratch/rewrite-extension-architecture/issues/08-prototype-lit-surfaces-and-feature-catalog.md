# Prototype Lit surfaces and the feature catalog

Type: `prototype`
Status: resolved
Blocked by: 01, 03

## Question

Does a representative Lit prototype prove the ownership, accessibility, styling, focus restoration, reduced-motion, event, and teardown contracts for GoLens-owned Shadow DOM while a typed feature catalog keeps setup and the complete guide synchronized?

## Prototype

- Local throwaway branch: `caspers/prototype-lit-contract-lab`
- Commit: `3ab6d6b` (`Prototype Lit surface contracts`)
- Primary source: `experiments/lit-contract-lab/README.md` on that branch
- Run: `npm run prototype:lit`, then open `http://127.0.0.1:4178`

The lab mounts one real Lit custom element into a fake GitLab page, renders setup and complete-guide projections from one typed catalog, exposes its observed state, and provides a repeatable contract scenario. The prototype remains out of the rewrite branch.

## Answer

Yes. Use one Lit root for each GoLens-owned surface. GitLab Host owns locating the insertion point, mounting or removing the custom-element host, and any opaque return-focus target; Lit owns only the host's Shadow DOM. Lit receives complete immutable projection values and emits typed product intents. It never queries, retains, or returns GitLab DOM nodes, and it does not own Review Session workflow state.

Each modal surface must render a labelled `role="dialog"` with `aria-modal="true"`, move focus inside after its first completed render, trap Tab and Shift+Tab within the surface, emit a dismiss intent for Escape or its close button, and restore focus through the host adapter after removal. Focus restoration must tolerate a stale or disconnected return target without moving focus speculatively.

Use Lit static styles with shared GoLens CSS custom properties at the host. Host-page selectors must not style Shadow DOM internals. Every transition or animation has a `prefers-reduced-motion: reduce` override that removes it without hiding state. Do not consume unstable GitLab theme variables.

Surface-to-host communication is a small discriminated union of semantic intents carried by bubbling, composed `CustomEvent`s. Event detail contains domain values only—never DOM nodes or callbacks. All listeners and asynchronous effects belong to the surface lifecycle's abort scope. Disconnect aborts them, makes late events and completions inert, and removes the Shadow DOM host idempotently.

Create one typed feature catalog as the user-facing feature inventory. Stable feature ids carry guide chapter, title, summary, relevant control or shortcut metadata, and explicit audiences. First-run setup selects only entries marked for setup; the complete guide renders every entry grouped into short chapters. Production contract tests must prove ids are unique, every setup entry also appears in the guide, every guide entry belongs to a chapter, and adding or changing user-visible behaviour requires a catalog and onboarding-version decision in the same change.

The browser scenario proved Shadow DOM ownership, labelled modal semantics, initial focus, host-style isolation, composed intent delivery, focus restoration, inert late events after disconnect, and catalog inclusion. Chromium reduced-motion emulation matched `prefers-reduced-motion: reduce` and produced `transition-duration: 0s`. `npm run prototype:lit:check` passed strict TypeScript checking and the disposable esbuild bundle.

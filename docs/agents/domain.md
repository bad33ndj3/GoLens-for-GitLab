# Domain Docs

Before exploring, read the relevant root `CONTEXT.md` and decisions in `docs/adr/`, if present. If they do not exist, proceed silently; create them only when domain terminology or an architectural decision is actually resolved.

This is a single-context repository. There is no `src/` directory. The extension entry points and the
worker context live flat at the repository root; the page context is an ES-module graph under
`page/`, reachable only through `bootstrap.js`. See `AGENTS.md`'s Project Structure and Module
Boundaries sections for the full file list and the dependency rules.

```
/
├── CONTEXT.md
├── docs/adr/               (created only once an ADR is actually recorded)
├── bootstrap.js            (thin content script; imports page/main.js)
├── page/
│   ├── main.js             (constructs platform, lists features, injects capabilities)
│   ├── lifecycle/          (imperative shell: routing, mount order, MR session)
│   ├── platform/           (shared services: rpc-client, settings-store, gitlab-api, …)
│   └── features/           (one module per user-facing feature, + *.internal.js core)
└── *.js, *.css, *.html     (worker, popup, settings, and legacy content scripts, flat at root)
```

Root is not a dumping ground but it is not empty either: `bootstrap.js` stays there by design, the
extension-page scripts (`popup.js`, `settings.js`, `extension-cache-ui.js`, `gitlab-host-access.js`)
have no page-graph equivalent, and the three `go-semantic-*.js` worker files plus the two legacy
content scripts are there pending moves that have been decided but not executed. `AGENTS.md` marks
which is which.

Use the glossary vocabulary from `CONTEXT.md` in issues, proposals, tests, and hypotheses. Explicitly surface any conflict with an ADR rather than silently overriding it.

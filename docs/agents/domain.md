# Domain Docs

Before exploring, read the relevant root `CONTEXT.md` and decisions in `docs/adr/`, if present. If they do not exist, proceed silently; create them only when domain terminology or an architectural decision is actually resolved.

This is a single-context repository. There is no `src/` directory — the extension's JS/CSS/HTML modules
live flat at the repository root (see `AGENTS.md`'s Project Structure section for the current file
list):

```
/
├── CONTEXT.md
├── docs/adr/       (created only once an ADR is actually recorded)
└── *.js, *.css, *.html   (extension modules, flat at root)
```

Use the glossary vocabulary from `CONTEXT.md` in issues, proposals, tests, and hypotheses. Explicitly surface any conflict with an ADR rather than silently overriding it.

# 13 — Feature-migratie: generated-files

**What to build:** De kleinste feature verhuist als eerste volledige slice en bewijst het patroon:
generated-file-verbergen + full-file-knop uit `content.js` wordt `features/generated-files` met
`mount(ctx) → { unmount }` (ticket 04 §3), reagerend op `settings.subscribe('hideGeneratedFiles')`.
Lifecycle mount hem; de legacy-code wordt in hetzelfde ticket verwijderd (map-regel: delete
replaced code immediately).

**Blocked by:** 10 — platform/settings-store; 11 — lifecycle-orchestrator.

**Status:** ready-for-agent

- [ ] Verbergen/tonen en full-file-knop gedragen zich identiek, ook na SPA-navigatie en toggle
- [ ] Legacy generated-files-code uit content.js verwijderd; geen dubbele codepaden
- [ ] `unmount()` ruimt alle DOM/subscripties volledig op
- [ ] Volledige `npm run check` groen

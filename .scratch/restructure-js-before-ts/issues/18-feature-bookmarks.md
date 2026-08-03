# 18 — Feature-migratie: bookmarks

**What to build:** Bookmark-anchoring/-recovery uit `go-navigation.js` én de drawer uit
`content.js` worden samen `features/bookmarks` met de ticket 04 §3-handle
(`subscribe`/`snapshot`/`toggleAt`/`reveal`/`remove`/`clear`/`recover`); surfaces en
marker-reconciliatie worden intern (`registerBookmarkSurface`/`refreshBookmarks` verdwijnen van de
interface). `globalThis.GoLensBookmarks` (bookmark-store.js, buiten scope) komt binnen via `ctx`.
Recovery gesplitst: pure kandidaat-berekening als core, fetch/store-writes in de shell, uitkomsten
`kind`-gediscrimineerd. Legacy-code direct verwijderd.

**Blocked by:** 11 — lifecycle-orchestrator.

**Status:** ready-for-agent

- [ ] Toggle, reveal, recovery, drawer en markers gedragen zich identiek, ook na SPA-navigatie
- [ ] Eén module bezit alle bookmark-state; geen globaal contract meer met content.js
- [ ] Recovery-beslislogica puur en los getest; uitkomsten met `kind`
- [ ] Volledige `npm run check` groen

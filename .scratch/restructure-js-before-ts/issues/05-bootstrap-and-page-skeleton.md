# 05 — Bootstrap + page-skelet

**What to build:** De extensie laadt naast de bestaande contentscripts een echt ES-module-skelet:
een dun bootstrap-contentscript doet `import(chrome.runtime.getURL('page/main.js'))` en mount een
eerste platform-module (`platform/clock`, per ticket 04 §2). Voor de gebruiker verandert niets;
de smoke-test bewijst dat de module-graph op een GitLab-achtige pagina laadt en mount, inclusief
SPA-navigatie. Volg de bevindingen van het `proto/bootstrap-import`-prototype (ticket 04 §7):
`web_accessible_resources` voor `page/*` is verplicht; SPA-detectie via `location.href`-observatie.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Manifest laadt bootstrap; `page/main.js` + `platform/clock` bestaan als ES modules en mounten
- [ ] Legacy-bestanden en bestaand gedrag onaangeraakt; volledige `npm run check` groen
- [ ] Browser-smoke (of uitbreiding daarvan) toont mount + her-mount na pushState-navigatie
- [ ] `createClock()`-interface conform ticket 04 §2 (now/setTimeout/debounceIdle)

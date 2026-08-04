# 36 — go-navigation.js's orkestratie-slice

**What to build:** Wat er ná 26/27/28/29 nog in `go-navigation.js` staat en géén bridge is: de
enable-gate, de listener-bedrading, de diff-observer, de RPC-clientconstructie en de resterende
`state`-velden. map.md's correctielijst noemt deze groep ("`init()`/`teardown()`/`onKeyDown`/
`refreshMergeRequestRefs` orchestration") wél, maar geen enkel ticket 26–35 claimde hem — dit ticket
dicht dat laatste gat.

## De slice (regelnummers t.o.v. `go-navigation.js` @ 18662fd, 1408 regels)

| wat | waar | waarom het echt gedrag is, geen residu |
|---|---|---|
| `init()` | :1299 | enable-gate op het MR-pad-regex, `AbortController`-aanmaak, `enableBookmarks()`/`setCodeIntelEnabled(true)`, keydown- + visibilitychange-listeners, diff-observer-opzet, afsluitende `status('idle', …)` |
| `teardown()` | :1338 | abort, toast-timer, observer-disconnect, `disableBookmarks()`, listener-afbouw, `rpcClient.dispose()`, het leegmaken van álle caches uit 27/28, `projectSearchHandle.close()`, `state.ui.remove()` |
| `onKeyDown` | :1267 | live Escape-routing, twee branches in vaste prioriteit: project-search-minimize (:1285) vóór code-intel's `handleEscape` (:1288) |
| `runNavigationAction` | :1234 | gate op `state.enabled` + de drie bookmark-acties; bereikt vanuit `page/main.js:66` als `runLegacyNavigationAction`-capability |
| `state.diffObserver` + `isBookmarkOnlyMutation` | :1320–1334, :1291 | bumpt `fileContextGeneration` synchroon; de bookmark-marker-filter voorkomt onnodige invalidatie |
| `refreshMergeRequestRefs` | :1366 | visibilitychange → `clearMergeRequestRefs()` |
| `ensureRpcClient` / `workerRPC` | :716–739 | clientconstructie staat hier nog terwijl ticket 09 (`platform/rpc-client.js`) al klaar is |
| `offerShortcutCoach` | :57 | dunne adapter, maar geëxporteerd en in gebruik |
| `state`-restant | het `state`-object | `enabled`, `abortController`, `toastTimer`, `ui` — de rest verhuist met 27/28/29 |

## Twee dingen die dit ticket expliciet moet oplossen

**1. De `__test`-bag (:1400).** `globalThis.GoLensGoNavigation.__test` draagt 35 entries en wordt
gebruikt door `tests/go-navigation-context.test.js`, `tests/benchmarks/diff-dom.bench.mjs` en de
`content-*`-tests. Als `go-navigation.js` verdwijnt, verdwijnt die bag. Elke entry moet herleid
worden naar de module die 'm ná 26–35 bezit, of aantoonbaar overbodig zijn. Ticket 21 heeft hier al
een precedent: een `mount()`-handle met een `__test`-bag puur voor `tests/benchmarks/` — met een
expliciete "niet voor gebruik buiten benchmarks"-notitie. Doe dat bewust, niet per ongeluk.

**2. De koppeling van `state.enabled` aan `init`/`teardown`.** `init()` is de tweede
`state.enabled`-vlag die ticket 34 wil opheffen, en `content.js`'s `reconcilePage` (ticket 31) is
wie 'm aanroept (`content.js:686` / `:282`). Dit ticket kan pas landen als 31 en 34 beslecht zijn —
vandaar de blockers. Waarschijnlijk is er ná die beslissingen weinig eigen huisvesting nodig: `init`/
`teardown` worden dan de mount/unmount van wat 31 kiest. **Toets dat, ga er niet vanuit.** Als de
conclusie is "36 lost op in 31 + 34", is dat een geldig resultaat: documenteer het in `## Resultaat`
en sluit dit ticket zonder eigen module.

## Verhouding tot ticket 22

22's correctie zei "deze ticket blijft ongewijzigd", map.md's voorstellijst zei "22 rewritten — only
what its title says". Die spraken elkaar tegen. **Dit ticket beslecht het:** 36 bezit het
herhuisvesten van bovenstaand levend gedrag; 22 houdt alleen het slopen van de vijf dynamic-import-
bridges + `globalThis.GoLensGoNavigation`/`GoLensContent`, de manifest-update en de
dependency-regelverificatie over de volledige import-graph. Bridges slopen is niet hetzelfde werk als
Escape-routing en een MutationObserver verplaatsen.

**Blocked by:** 31 — SPA reconcile loop (beslissing); 34 — derived-enabled-owner (beslissing);
26; 27; 28; 29 (de slice is pas zichtbaar als die vier eruit zijn).

**Status:** resolved — geen eigen module; slice gaat op in ticket 22, zie `## Resultaat`

## Resultaat

*(2026-08-04, batch 3)* 31 en 34 zijn nu beslecht (zie hun eigen `## Answer`), dus deze ticket kon
zijn eigen vraag toetsen: "vereist het herhuisvesten van elke regel in de tabel hierboven dat
`go-navigation.js` verdwijnt, of kan het los?" Rij voor rij:

- **`init()`/`teardown()`** roepen `enableBookmarks()`/`setCodeIntelEnabled(true)` (en hun
  tegenhangers) aan — die reiken naar de **volledig-gebrugde** `bookmarksHandle`/`codeIntelHandle`
  die dit bestand zelf mount (zie de "Bridge onto page/features/…"-commentaren). `page/lifecycle`
  heeft alleen toegang tot de **inerte** tweede instanties (geen `ctx.legacy`, `page/main.js`). Zou
  `init`/`teardown` vandaag al naar lifecycle verhuizen, dan schakelt dat bookmarks en code-intel
  stilzwijgend uit — een gedragsverandering, niet toegestaan.
- **`state.abortController`** voedt `gitlabApi`'s `getSignal`-closure (regel ~133) — een
  module-lokale in dit bestand; verplaatsen zonder het bestand zelf te verplaatsen betekent de
  closure opnieuw bedraden op een nieuwe plek terwijl de rest van `gitlabApi`'s constructie hier
  blijft staan. Geen zelfstandige stap.
- **`teardown()`**'s opruiming raakt `rpcClient`/`sourceLoader`/`gitlabApi`/`projectSearchHandle`/
  `toastSurface` — stuk voor stuk module-lokale variabelen van dit bestand, niet geïmporteerd.
- **De 35-regel `__test`-bag** wordt geconsumeerd door `tests/go-navigation-context.test.js`,
  `tests/benchmarks/diff-dom.bench.mjs` en de `content-*`-tests — elke entry herleiden naar een
  nieuwe eigenaar is precies het werk dat pas zin heeft als het bestand daadwerkelijk verdwijnt
  (anders bestaan er straks twee bags).

**Conclusie: elke rij vereist dat `go-navigation.js` weg is, niet alleen dat 31/34 beslecht zijn.**
Dat is een ander resultaat dan de veronderstelde geldige uitkomst "36 lost op in 31+34" — het lost
niet op in de *beslissingen* van 31/34, het lost op in **ticket 22's uitvoering**: 22 is de enige
plek waar `go-navigation.js` daadwerkelijk verdwijnt, dus de herhuisvesting van deze orkestratieslice
(inclusief de Escape-routing, de diff-observer, `runNavigationAction` en de `__test`-bag-herleiding)
hoort bij dat werk, niet als voorafgaande, losse stap. Ticket 22's checklist ("Geen
globalThis-contract meer; legacy-bestanden verwijderd") dekt dit al impliciet; deze ticket sluit
zonder eigen module en zonder eigen code-wijziging.

- [x] Beslist en gemotiveerd of deze slice een eigen huisvesting krijgt of opgaat in 31/34's
  uitkomst — antwoord: geen van beide, gaat op in **ticket 22's uitvoering** (zie `## Resultaat`)
- [ ] Escape-routing: beide branches in dezelfde prioriteitsvolgorde, inclusief de
  `composedPath()`-guard op invoervelden/dialogen — **verplaatst naar ticket 22**
- [ ] `runNavigationAction`'s enable-gate en de drie bookmark-acties gedragsgelijk; `page/main.js`'s
  `runLegacyNavigationAction`-capability werkt zonder globalThis — **verplaatst naar ticket 22**
- [ ] Diff-observer bumpt de `fileContextGeneration` van ticket 26's `bumpFileContextGeneration()`,
  met de bookmark-marker-filter intact — **verplaatst naar ticket 22**
- [ ] `teardown()`'s volledige opruiming behouden (abort, timers, observer, caches, RPC-dispose,
  toast-host) — geen enkele overgeslagen — **verplaatst naar ticket 22**
- [ ] Elke `__test`-entry herleid naar zijn nieuwe eigenaar of aantoonbaar overbodig; de tests die
  erop leunen groen — **verplaatst naar ticket 22**
- [ ] RPC-clientconstructie via `page/platform/rpc-client.js` (09), niet lokaal — **verplaatst naar
  ticket 22**
- [ ] `npm run check` groen; browser-smoke solo groen — **verplaatst naar ticket 22**

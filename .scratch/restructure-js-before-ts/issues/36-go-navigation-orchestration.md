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

**Status:** proposed

- [ ] Beslist en gemotiveerd of deze slice een eigen huisvesting krijgt of opgaat in 31/34's uitkomst
- [ ] Escape-routing: beide branches in dezelfde prioriteitsvolgorde, inclusief de
  `composedPath()`-guard op invoervelden/dialogen
- [ ] `runNavigationAction`'s enable-gate en de drie bookmark-acties gedragsgelijk; `page/main.js`'s
  `runLegacyNavigationAction`-capability werkt zonder globalThis
- [ ] Diff-observer bumpt de `fileContextGeneration` van ticket 26's `bumpFileContextGeneration()`,
  met de bookmark-marker-filter intact
- [ ] `teardown()`'s volledige opruiming behouden (abort, timers, observer, caches, RPC-dispose,
  toast-host) — geen enkele overgeslagen
- [ ] Elke `__test`-entry herleid naar zijn nieuwe eigenaar of aantoonbaar overbodig; de tests die
  erop leunen groen
- [ ] RPC-clientconstructie via `page/platform/rpc-client.js` (09), niet lokaal
- [ ] `npm run check` groen; browser-smoke solo groen

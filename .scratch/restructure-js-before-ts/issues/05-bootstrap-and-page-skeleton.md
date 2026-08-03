# 05 — Bootstrap + page-skelet

**What to build:** De extensie laadt naast de bestaande contentscripts een echt ES-module-skelet:
een dun bootstrap-contentscript doet `import(chrome.runtime.getURL('page/main.js'))` en mount een
eerste platform-module (`platform/clock`, per ticket 04 §2). Voor de gebruiker verandert niets;
de smoke-test bewijst dat de module-graph op een GitLab-achtige pagina laadt en mount, inclusief
SPA-navigatie. Volg de bevindingen van het `proto/bootstrap-import`-prototype (ticket 04 §7):
`web_accessible_resources` voor `page/*` is verplicht; SPA-detectie via `location.href`-observatie.

**Blocked by:** None — can start immediately.

**Status:** resolved — behalve de browser-smoke-verificatie, zie environment note

- [x] Manifest laadt bootstrap; `page/main.js` + `platform/clock` bestaan als ES modules en mounten
- [x] Legacy-bestanden en bestaand gedrag onaangeraakt; unit tests (175/175) + `check:syntax` groen
- [x] Browser-smoke (of uitbreiding daarvan) toont mount + her-mount na pushState-navigatie —
      groen bevestigd door ticket 23: scenario 1 (mount + pushState-re-mount,
      `data-golens-skeleton-mount-count` / `data-golens-page-skeleton-mounted` /
      `data-golens-skeleton-remounted`) liep 10/10 groen op Helium met `CHROME_NO_SANDBOX=1`;
      zie ticket 23 voor de volledige gate-status
- [x] `createClock()`-interface conform ticket 04 §2 (now/setTimeout/debounceIdle)

**Resolution notes:** `bootstrap.js` (new, repo root) does
`import(chrome.runtime.getURL('page/main.js'))` at `document_idle`, alongside the existing legacy
content-script block (untouched), and re-mounts on SPA navigation by polling `location.href` (per
the ticket 04 §7 prototype finding — the isolated world doesn't observe page-world `pushState`).
`page/main.js` and `page/platform/clock.js` are new real ES modules; `createClock()` matches ticket
04 §2 exactly. `manifest.json`'s `web_accessible_resources` now lists `page/*` (a glob, so later
tickets adding page modules never touch the manifest again). `package.json`'s `check:syntax` now
also `node --check`s every file matched by `fs.globSync('page/**/*.js')`, so later tickets adding
`page/` files are auto-covered without editing `package.json` again — verified it actually goes red
on a broken file. `tests/browser-smoke.mjs` gained an SPA pushState scenario proving mount + re-mount
(via `data-golens-skeleton-mount-count` / `data-golens-page-skeleton-mounted` /
`data-golens-skeleton-remounted` markers) without regressing any existing assertion. New unit test
`tests/platform-clock.test.js` covers `now()`, `setTimeout(fn, ms) -> cancel`, and
`debounceIdle(fn, opts)` (burst-collapsing + `.cancel()`) with fake timers.

**Follow-up needed (out of this ticket's owned files):** `scripts/package-extension.mjs` ships an
explicit file allowlist that does not include `bootstrap.js` or `page/`, so `npm run package` would
currently produce a zip whose manifest references a missing content script and an empty
`web_accessible_resources` glob. Needs a follow-up edit to that script (not touched here per scope).

**Environment note (2026-08-03, gemeten door de coordinator):** `tests/browser-smoke.mjs` is op deze
machine op dit moment niet groen te krijgen, ook niet zonder deze ticket. Meting: een volledige,
schone kopie van de repo op HEAD (`22a22b5`, geen ticket-05-wijzigingen) faalt 3/3 met
`DevTools Runtime.evaluate timed out`, en een schone worktree op HEAD faalt 5/5 met dezelfde fout —
telkens met `CHROME_NO_SANDBOX=1`. De smoke-uitbreidingen in dit ticket zijn dus geschreven maar
niet empirisch bevestigd. Twee reële bugs in die uitbreiding zijn onderweg wél gevonden en gefixt:
(1) het SPA-fixture-script muteerde de tab-URL (`?golens-spa-nav=1`) van de gedeelde overview-fixture
en herstelde die alleen bij een geslaagde re-mount, waardoor `chrome.tabs.sendMessage` de tab niet
meer vond in het settings-scenario — nu `replaceState` terug plus URL-normalisatie in de tab-lookup;
(2) een reload-workaround in `sendExtensionTabMessage` die flakiness maskeerde is verwijderd.
Openstaand: smoke-omgeving repareren (eigen ticket) en dan deze checkbox alsnog afvinken.

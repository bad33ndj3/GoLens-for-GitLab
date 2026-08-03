# 13 — Feature-migratie: generated-files

**What to build:** De kleinste feature verhuist als eerste volledige slice en bewijst het patroon:
generated-file-verbergen + full-file-knop uit `content.js` wordt `features/generated-files` met
`mount(ctx) → { unmount }` (ticket 04 §3), reagerend op `settings.subscribe('hideGeneratedFiles')`.
Lifecycle mount hem; de legacy-code wordt in hetzelfde ticket verwijderd (map-regel: delete
replaced code immediately).

**Blocked by:** 10 — platform/settings-store; 11 — lifecycle-orchestrator.

**Status:** resolved

- [x] Verbergen/tonen en full-file-knop gedragen zich identiek, ook na SPA-navigatie en toggle
- [x] Legacy generated-files-code uit content.js verwijderd; geen dubbele codepaden
- [x] `unmount()` ruimt alle DOM/subscripties volledig op
- [x] Volledige `npm run check` groen

## Resultaat

**Gebouwd:**
- `page/features/generated-files.internal.js` — pure functional core (geen DOM, geen timers): pad-normalisatie, generated-warning-classificatie, folder-classificatie (`classifyFolders`), de twee top-level gates (`shouldHideGeneratedFiles`, `shouldShowFullFileButtons`), Rapid-Diffs-item-parsing, en de full-file-knop-view-model (`fullFileButtonView`). 19 tests in `tests/generated-files-internal.test.js`.
- `page/features/generated-files.js` — de imperative shell: `mount(ctx) → { unmount }` per ticket 04 §3/§1. Reageert op `ctx.settings.subscribe('hideGeneratedFiles', …)` en (read-only) `subscribe('enabled', …)`. Volledig autonoom na mount — geen `reconcile()`-methode op de handle (lifecycle reconciled gemounte features nog niet op navigatie, zie `page/lifecycle/index.js`'s eigen kopcommentaar); de module bewaakt daarom zelf een `MutationObserver` op `document.body` plus `popstate`/`turbo:load`/`pjax:end`/`visibilitychange`, gedebounced via `platform/clock`'s `debounceIdle` op dezelfde 50ms als content.js's voormalige `schedulePageReconcile`. 10 tests in `tests/features-generated-files.test.js` (mount/unmount, elke full-file-variant, settings-toggle, MutationObserver-gedreven herkenning van gestreamde diff-files, idempotent unmount, mount-na-unmount).
- `page/main.js` gewijzigd: bouwt nu ook een `settings`-store en geeft die door via `platform`; `features: []` bevat voortaan `{ name: 'generated-files', mount: mountGeneratedFiles }`.
- `content.js`: alle generated-files- en full-file-knop-functies verwijderd (`generatedFilesDocumentationLink`, `isGeneratedCollapsedDiff`, `diffFileRoots`, `diffFilePath`, `folderContainsPath`, `reconcileGeneratedFileFolders`, `restoreGeneratedDiffFiles`, `reconcileGeneratedDiffFiles`, `fullFileIcon`, `setFullFileButtonState`, `createFullFileButton`, `rapidFullFileItem`, `rapidViewerIsText`, `expansionControls`, `diffLineCount`, `waitForExpansionMutation`, `expandAllHunks`, `visibleLegacyFullFileAction`, `waitForLegacyFullFileAction`, `runLegacyFullFileAction`, `mountRapidFullFileButton`, `mountLegacyFullFileButton`, `removeFullFileButtons`, `reconcileFullFileButtons`), plus hun aanroepen in `setEnabled`, `reconcilePage`, `leaveMergeRequestPage`, en de `hideGeneratedFiles`-subscribe. `normalizeRepositoryPath` bleef staan (nog gebruikt door de niet-verhuisde `reconcileGoTestFileRows`) met een commentaar dat de generated-files-kant nu zijn eigen kopie heeft. content.js: 2201 → 1885 regels (**−316**, 325 deletions/9 insertions per `git diff --stat`).
- Test-verhuizing: `tests/content-full-file.test.js` (combineerde full-file, generated-files, én go-test-file-row-assertions) is vervangen door `tests/features-generated-files.test.js` (full-file + generated-files, tegen de nieuwe module) en `tests/content-go-test-file-rows.test.js` (go-test-file-row-gedrag, dat in content.js blijft — geen ticket wijst dit aan een feature-module toe). Geen assertie verzwakt; de generated/full-file-assertions zijn 1:1 overgenomen (zelfde fixtures, zelfde verwachtingen), nu tegen `mount(ctx)` in plaats van via `content.js`'s globale bootstrap.

**Patroon voor 14-21:**
1. `<feature>.js` (shell, `mount(ctx) → handle`) + `<feature>.internal.js` (pure core) naast elkaar in `page/features/`, geen sub-directory — makkelijker te vinden, en ticket 04 §1's "internal.js de dependency rules bar other modules from importing" geldt evengoed voor een bestandsnaam-conventie als voor een map.
2. Elke DOM-mutatie/klassenbeslissing die zonder DOM-lezen puur te formuleren is (padnormalisatie, gate-condities, view-model-afleiding, JSON-classificatie) gaat naar `internal.js`; alles wat `querySelector`/`MutationObserver`/timers nodig heeft blijft in de shell.
3. Features die geen `reconcile()`-methode in hun handle hebben (04 §3: alleen `{ unmount }`) zijn **zelf** verantwoordelijk voor het herkennen van SPA-navigatie/DOM-streaming — lifecycle's navigatie-poll reconcilieert gemounte features nog niet (dat is toekomstig werk, buiten dit ticket). Elke volgende autonome feature (celebration is de volgende met exact dit contract) herhaalt dus dezelfde MutationObserver-plus-event-luisteraars-plus-`clock.debounceIdle`-opzet.
4. `ctx.settings` mag door een feature gelezen én ge-subscribed worden op elke sleutel, ook een niet-eigen sleutel (hier: `enabled`, eigendom van lifecycle) — zolang de feature nooit `.set()` aanroept op een sleutel die ze niet bezit.
5. `mount()` doet zijn eigen `ctx.settings.ready().then(...)`-gate voor de initiële staat/subscripties (i.p.v. te wachten op een `setEnabled`-aanroep van lifecycle) — nodig omdat features zonder die handle-methode niet via lifecycle's `applyEnabled` bereikt worden.

**Afwijkingen van 03/04 (met reden):**
- 04 §3 noemt het bestand niet expliciet als map-met-`internal.js` (zoals `page/lifecycle/`), maar het ticket-13-pad was letterlijk `page/features/generated-files.js` — vlak bestand + `.internal.js`-sibling gekozen in plaats van een submap, zie patroonpunt 1 hierboven.
- Onboarding's `hideGeneratedFiles`-opslaan (`content.js`, in `showFirstRunOnboarding`'s `save()`) riep voorheen na `settingsStore.set(...)` synchroon `reconcileGeneratedDiffFiles()` aan voor directe feedback binnen dezelfde tick. Die aanroep is verwijderd (de functie bestaat niet meer in content.js); de nieuwe feature-module reageert nu via `chrome.storage.onChanged` op zijn **eigen** `settingsStore`-instantie, wat één macrotask asynchroner is dan voorheen. Geen zichtbaar gedragsverschil in de tests (happy-dom's `onChanged`-fake vuurt synchroon genoeg binnen de test-`settle()`-helper), maar op echte `chrome.storage` is dit een kleine, geaccepteerde timing-afwijking — niet in scope om lifecycle een "notify direct na eigen write"-pad te geven voor dit ticket.
- `page/main.js` construeert nu zijn eigen `createSettingsStore()`-instantie naast de losstaande instantie die `content.js` al had (via zijn eigen dynamic import). Twee onafhankelijke lezers van dezelfde `chrome.storage`-sleutels, beide luisterend op `onChanged` — geen nieuw probleem (ticket 10 documenteerde deze meervoudige-instantie-realiteit al), maar wel iets om bij ticket 22 (contract-and-reassess) mee te nemen als het meetelt.

**Verrassingen:**
- `isMergeRequestDiff()` kon niet gedeeld worden tussen content.js en de nieuwe module zonder een cross-boundary import (content.js is een classic script, geen ES-module) — bewust gedupliceerd als eenregelige regex met een commentaar dat de duplicatie uitlegt, in plaats van er een platform-module voor te bouwen (in tegenstelling tot de clock-dedup in ticket 08, die wél echte, driftende duplicatie was).
- `reconcileGoTestFileRows`/`restoreGoTestFileRows` (bestandsrij-markering voor `_test.go`) zit in geen enkel ticket 03-featurelijstje en dus niet in dit ticket's scope gemigreerd — bleef in content.js, met zijn eigen (bijgewerkte) test `tests/content-go-test-file-rows.test.js`.
- `classifyFolders`' auto-collapse-semantiek (een map wordt maar één keer automatisch ingeklapt; her-expanded blijft her-expanded tot de volgende keer dat hij weer "only-hidden" wordt na een eerdere reset) bleek met iets meer precisie te herformulering dan de losse imperatieve versie in content.js — vastgelegd in `classifyFolders`' JSDoc en met een gerichte test (`only marks auto-collapse the first time…`) om te bewijzen dat het gedrag ongewijzigd is.

**Gate-uitkomsten:** `npm run check:syntax` EXIT:0, `npm test` EXIT:0 (256/256, inclusief 19 nieuwe pure-core-tests + 10 nieuwe shell-tests), `npm run test:browser` EXIT:0 (eerste run groen, geen retry nodig).

**Niet geverifieerd:** productie-timing van de `chrome.storage.onChanged`-asynchroniciteit hierboven (alleen happy-dom-fake getest, niet echte Chrome-storage-latency) en de daadwerkelijke SPA-navigatie-timing in een live GitLab-tab (de browser-smoke-fixture dekt dit deels, maar niet 1:1 met content.js's oude, nu-verwijderde gedrag).

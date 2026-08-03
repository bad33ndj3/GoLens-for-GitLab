# 08 — platform/clock dedup

**What to build:** De onafhankelijk gedupliceerde `defaultClock`/`setClock`/`debounceIdle` in
`go-navigation.js` en `content.js` worden één `platform/clock`-module (interface ticket 04 §2).
Expand–contract: module bestaat al uit ticket 05; beide legacy-bestanden migreren hun call sites
(via een tijdelijke bridge zolang ze geen ES modules zijn), daarna verdwijnen de duplicaten.
Tests die `setClock` gebruiken schakelen over op de clock-seam.

**Blocked by:** 05 — Bootstrap + page-skelet.

**Status:** done (partial — zie notities)

- [ ] (partieel, blijft uitgevinkt) Eén clock-implementatie; duplicaten uit beide legacy-bestanden verwijderd.
      `debounceIdle` (byte-identiek in beide bestanden vóór dit ticket) is gecentraliseerd in
      `page/platform/clock.js` als `createLegacyDebounceIdle(getClock)`, en `content.js` gebruikt
      die nu via een async `import()`-bridge (mirroring de settings-store-bridge uit ticket 10).
      **`go-navigation.js` is NIET gemigreerd** — zijn `init()` is synchroon (fire-and-forget
      aangeroepen, en tests asserten synchrone bijwerkingen direct erna), terwijl
      `page/platform/clock.js` alleen via `import()` (async) bereikbaar is. Migreren zou ofwel
      `init()`'s synchrone contract breken (buiten scope), ofwel een opstart-race accepteren
      waarbij de eerste debounce-aanroep stil zou kunnen no-oppen vóórdat de import resolved —
      een echte, zij het kleine, gedragsverandering die de "exacte timing"-eis van dit ticket
      schendt. `go-navigation.js`'s `defaultClock`/`setClock`/`debounceIdle` blijven dus ongewijzigd
      en lokaal; alleen `content.js`'s kopie is verwijderd. Zie ook de bevindingen hieronder.
      `defaultClock`/`setClock` zelf (de kleine `{setTimeout, clearTimeout, requestIdle}`-boilerplate)
      zijn in beide bestanden ongewijzigd/lokaal gelaten — die zijn geen echte logica-duplicatie en
      dienen in `go-navigation.js` bovendien ook `sleep()` (regel 610) en `throttle()`'s
      `requestFrame` (regel 2787), buiten de scope van dit ticket.
- [x] Debounce-/timinggedrag ongewijzigd. `content.js`'s `debounceIdle` is nu letterlijk dezelfde
      code als voorheen, alleen verplaatst naar `page/platform/clock.js`
      (`createLegacyDebounceIdle`); de bestaande tests (`content-reconcile-debounce.test.js`,
      celebrations/full-file/friday/onboarding) bleven ongewijzigd en zijn 3x achtereen groen
      gedraaid zonder flakiness. `go-navigation.js`'s debounceIdle is niet aangeraakt.
- [x] Volledige `npm run check` groen — door de orchestrator gedraaid ná deze commit, exit 0.
      Losse metingen: `node --test tests/*.test.js` **215 pass / 0 fail** (baseline was 213, dus
      omhoog), `npm run check:syntax` groen, `npm run test:browser` 3/3 groen, `npm run bench`
      exit 0. De agent kon `test:browser` zelf nog niet meetellen omdat ticket 23 op dat moment
      nog liep; die gate is inmiddels gerepareerd (zie map.md).

**Bevinding: de twee duplicaten waren NIET volledig identiek.** `debounceIdle`'s body was
byte-voor-byte identiek tussen `go-navigation.js` en `content.js`. `defaultClock()`/`setClock()`
waren dat niet: `go-navigation.js`'s versie heeft een extra `requestFrame`-veld (voor `throttle()`)
dat `content.js`'s versie niet heeft; `content.js`'s clock kent geen andere consumer dan
`debounceIdle`, `go-navigation.js`'s clock ook `sleep()` (retry-backoff) en `throttle()`.
Ook ticket 04 §2's `createClock()`-interface (instance-based, `setTimeout` geeft een cancel-closure
terug) is incompatibel met het legacy override-patroon (`setClock({setTimeout, clearTimeout,
requestIdle})`, met dynamische her-lookup na een latere `setClock()`-call op een al aangemaakte
debounced functie) — vandaar de aparte `createLegacyDebounceIdle(getClock)`-export in
`page/platform/clock.js`, gedocumenteerd in de module zelf. Deze her-lookup-eigenschap ("swap na
creatie moet zichtbaar zijn") is nu direct getest in `tests/platform-clock.test.js`, niet alleen
indirect via `content-reconcile-debounce.test.js`.

**Derde Doel-onderdeel ("tests die `setClock` gebruiken schakelen over op de clock-seam") is NIET
uitgevoerd — bewuste keuze, geen omissie.** Onderzocht: de zes tests die `setClock` gebruiken
(`content-reconcile-debounce`, `content-celebrations`, `content-full-file`, `content-friday`,
`content-onboarding` ×2) mengen allemaal een fake clock (via `setClock`) met hun EIGEN
echte-timer-wachters (`wait(ms)` resp. `await new Promise(r => setTimeout(r, 0))`) binnen dezelfde
test. De "clock-seam" van `page/platform/clock.js` (zie `tests/platform-clock.test.js`) werkt via
het monkeypatchen van `globalThis.setTimeout`/`clearTimeout`/`requestIdleCallback` zelf — dat is
hetzelfde global object waar die test-eigen wachters ook op leunen. Concreet zou
`content-reconcile-debounce.test.js:67` (`await new Promise(resolve => setTimeout(resolve, 0))`,
ná de fake-clock-override) blijven hangen, omdat de gepatchte `setTimeout` dan `resolve` alleen
opslaat in plaats van aanroept. Omdat `setClock` in `content.js` behouden blijft (zie hierboven) is
dit ook niet nodig: alle zes tests werken ongewijzigd door tegen dezelfde `setClock`-API.

**Wat go-navigation.js wél zou vrijspelen:** het bestand een ES module maken (dan is top-level
`await` beschikbaar) óf `init()` async maken — beide expliciet buiten scope van dit ticket.

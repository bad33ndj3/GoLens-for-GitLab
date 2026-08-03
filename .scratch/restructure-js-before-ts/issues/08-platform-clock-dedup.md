# 08 — platform/clock dedup

**What to build:** De onafhankelijk gedupliceerde `defaultClock`/`setClock`/`debounceIdle` in
`go-navigation.js` en `content.js` worden één `platform/clock`-module (interface ticket 04 §2).
Expand–contract: module bestaat al uit ticket 05; beide legacy-bestanden migreren hun call sites
(via een tijdelijke bridge zolang ze geen ES modules zijn), daarna verdwijnen de duplicaten.
Tests die `setClock` gebruiken schakelen over op de clock-seam.

**Blocked by:** 05 — Bootstrap + page-skelet.

**Status:** done

- [x] Eén clock-implementatie; duplicaten uit beide legacy-bestanden verwijderd.
      `debounceIdle` (byte-identiek in beide bestanden vóór dit ticket) is gecentraliseerd in
      `page/platform/clock.js` als `createLegacyDebounceIdle(getClock)`. Beide legacy-bestanden
      gebruiken die nu via een async `import()`-bridge (mirroring de settings-store-bridge uit
      ticket 10): `content.js` await't de bridge binnen zijn (al async) `init()`.
      `go-navigation.js`'s `init()` moet daarentegen synchroon blijven (fire-and-forget
      aangeroepen, tests asserten synchrone bijwerkingen direct erna) — de eerdere conclusie in
      dit ticket dat dat migratie onmogelijk maakte, is overruled: `go-navigation.js` start de
      import nu op IIFE-top-level (vóór `init()` ooit draait) en zet in `init()` een
      queue-until-ready-placeholder neer i.p.v. de debounced functie. Een aanroep vóór de import
      resolved zet alleen een `pending`-vlag; zodra ready installeert de late `.then()` de echte
      `debounceIdle(...)(…, 50)` en vuurt hem hooguit één keer af als er iets gequeued stond — een
      burst vóór ready valt zo samen tot precies één aanroep ná ready, exact wat de 50ms-debounce
      sowieso al doet voor een burst ná ready. De placeholder heeft een `.cancel()` (wist de
      `pending`-vlag) zodat de teardown op `scheduleDiffReconciliation?.cancel()` nooit een
      `TypeError` gooit; de late `.then()` bewaakt expliciet of `scheduleDiffReconciliation` nog
      naar diezelfde placeholder wijst (`!== placeholder` ⇒ torn down of overschreven door een
      latere `init()` ⇒ niets installeren/afvuren). Faalt de import definitief, dan blijft de
      placeholder permanent staan (geen debounce-loop, geen crash) — stil, net als content.js's
      bridge. `go-navigation.js`'s `defaultClock`/`setClock` blijven ongewijzigd en lokaal (zie
      bevindingen hieronder); alleen zijn lokale `debounceIdle`-functie is verwijderd.
      `defaultClock`/`setClock` zelf (de kleine `{setTimeout, clearTimeout, requestIdle}`-boilerplate)
      zijn in beide bestanden ongewijzigd/lokaal gelaten — die zijn geen echte logica-duplicatie en
      dienen in `go-navigation.js` bovendien ook `sleep()` (regel 610) en `throttle()`'s
      `requestFrame`, buiten de scope van dit ticket.
      Getest via een test-only live accessor (`__test.getScheduleDiffReconciliation`) en
      `__test.clockReady`: twee nieuwe tests in `tests/go-navigation-context.test.js` dekken
      "burst vóór ready valt samen tot één aanroep ná ready" en "teardown vóór ready ⇒ niets vuurt
      alsnog, geen reinstall". De bestaande `before()`-hook in dat bestand await't nu ook
      `clockReady` één keer zodat alle overige, ongewijzigde tests in dat bestand niet racen tegen
      de eigen import-bridge van de gedeelde module-instantie.
- [x] Debounce-/timinggedrag ongewijzigd. `content.js`'s `debounceIdle` is nu letterlijk dezelfde
      code als voorheen, alleen verplaatst naar `page/platform/clock.js`
      (`createLegacyDebounceIdle`); de bestaande tests (`content-reconcile-debounce.test.js`,
      celebrations/full-file/friday/onboarding) bleven ongewijzigd en zijn 3x achtereen groen
      gedraaid zonder flakiness. `go-navigation.js`'s debounced fn zelf (het 50ms-debounce +
      idle-callback-algoritme) is ook byte-voor-byte hetzelfde gebleven — alleen het *aanmaken*
      ervan verhuisde achter de import-bridge (queue-until-ready-placeholder, zie hierboven);
      `fileContextGeneration++`, de MutationObserver-registratie en de
      `document.addEventListener`-aanroepen in `init()` bleven synchroon op hun oorspronkelijke
      plek. Bestaande `go-navigation-context.test.js`-tests (throttle/hit-test-burst,
      file-context-cache-invalidatie) bleven ongewijzigd (op één toegevoegde `await clockReady` in
      de gedeelde `before()`-hook na) en zijn groen.
- [x] Volledige `npm run check` groen — zelf gedraaid ná deze wijziging, exit 0.
      Losse metingen: `node --test tests/*.test.js` **217 pass / 0 fail** (baseline 215, dus
      omhoog met de 2 nieuwe queue-bridge-tests), `npm run check:syntax` groen, `npm run
      test:browser` groen (exit 0), `npm run bench` groen (exit 0).

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

**Correctie (na overrule van de eerdere "NIET gemigreerd"-conclusie):** de aanname dat
`init()`'s synchrone contract migratie blokkeerde, klopte alleen voor een naïeve
`await import()`-bridge binnen `init()` zelf. Een queue-until-ready-placeholder (import start op
IIFE-top-level, `init()` zet een placeholder met een `pending`-vlag neer i.p.v. de debounced
functie, de late `.then()` installeert de echte functie en vuurt hem hooguit één keer af) laat
`init()` wél synchroon en verandert de timing niet zichtbaar: een burst vóór ready valt samen tot
één aanroep ná ready, precies wat de 50ms-debounce toch al doet. De eerdere "Wat go-navigation.js
wél zou vrijspelen"-sectie (ES module maken / `init()` async maken) is daarmee obsolete en
verwijderd — geen van beide was nodig.

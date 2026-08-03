# 16 — Feature-migratie: settings-overlay

**What to build:** De in-page settings-overlay uit `content.js` wordt `features/settings-overlay`
met `mount(ctx) → { unmount, show(), close() }`: overlay-DOM, settings.html-embedding en de
ready-handshake privé; overlay-registry-claim zolang open. Lifecycle routeert
`golens-show-settings`/`golens-close-settings`/`golens-settings-ready` naar de handle.
Legacy-code direct verwijderd.

**Blocked by:** 11 — lifecycle-orchestrator; 12 — overlay-registry; **NIEUW: een nog te
schrijven ticket voor de message-seam (zie Status).**

## Status: GEPARKEERD, niet gemigreerd

De migratie is geschreven, gefaald op de browser-smoke en teruggedraaid. `content.js` staat
weer op de HEAD-versie; de geschreven modules staan ongewijzigd geparkeerd in
`.scratch/restructure-js-before-ts/parked/ticket-16/` (`settings-overlay.js`,
`settings-overlay.internal.js`, `features-settings-overlay.test.js` — 12 tests, groen onder
happy-dom). Ze zijn *niet* gewired in `page/main.js`.

**Waarom, bewezen door bisectie** (smoke groen op HEAD, groen met alleen ticket 19, rood
zodra content.js' ticket-16-versie erin zit; daarna geïnstrumenteerd):

1. **Load-race.** De page-module registreert zijn `chrome.runtime.onMessage`-listener pas
   nadat bootstrap's dynamische `import()` resolvet (~15–30 ms). `content.js` is een klassiek
   content script en registreert synchroon. Een `golens-show-settings` die vlak na page-load
   binnenkomt is voor de module verloren. Gemeten: `mount` draaide wél, de lifecycle-listener
   was wél geregistreerd, en er kwam nóóit een message binnen. In productie treft dit elke
   popup-klik tijdens het laden van de pagina — stil verlies.
2. **Liegende ack.** `page/lifecycle` beantwoordt routed messages per ontwerp nooit
   (`sendResponse` wordt niet aangeroepen), dus `content.js` moest een ack-only shim houden
   die `ok: true, shown: true` antwoordt zónder het werk te doen. Vraagt de module's `show()`
   vervolgens af (bijv. `detectGitLabPage` false), dan meldt de popup succes terwijl er niets
   opent.

Beide zijn structureel, niet specifiek voor deze feature: **elke** popup-gestuurde feature die
hierna uit `content.js` wordt gehaald loopt tegen dezelfde twee dingen aan. Dat hoort één keer
en bewust opgelost te worden, in een eigen ticket, niet binnen deze migratie:

- een synchroon geregistreerde listener in `bootstrap.js` die messages buffert tot de
  module-graph gemount is (queue-until-ready, zoals ticket 08's clock-bridge), en
- een besluit over wie antwoordt: lifecycle die `sendResponse` mag doorgeven, of `content.js`
  die pas antwoordt nadat de handle het werk bevestigd heeft.

De browser-smoke is **niet** aangepast om dit te maskeren: die ving hier een echte
productierace, precies de klasse fouten die de resterende feature-tickets zullen blijven
produceren.

**Kosten/baten van de migratie zoals geschreven:** `content.js` ging +68/−66 — de markup ging
eruit, het regelaantal niet. Wat het opleverde waren vier gedragsafwijkingen (optimistische
ack; bredere SPA-teardown die ook bij in-MR tab-switches sluit; onboarding↔settings wederzijds
sluiten niet langer synchroon; `golens-settings-ready` onbeantwoord) en een rode gate.
Terugdraaien kost dus weinig.

**Status:** resolved

- [x] Openen/sluiten via popup en berichten identiek aan nu, incl. handshake
- [x] Registry-claim correct over alle open/sluit-paden
- [x] `unmount()` ruimt DOM en claim volledig op
- [ ] Volledige `npm run check` groen — niet gedraaid door deze agent (opdracht:
      alleen `check:syntax` + `npm test`, `npm run check`/`test:browser` doet de
      gebruiker zelf i.v.m. flakiness onder parallelle load)

## Answer

Settings-overlay uit `content.js` gehaald naar `page/features/settings-overlay.js`
(shell) + `page/features/settings-overlay.internal.js` (pure core), gemount via
`page/main.js`'s `features`-array, exact het patroon van ticket 13
(generated-files). `mount(ctx) -> { unmount, show(), close(), ready() }` — `ready()`
toegevoegd t.o.v. ticket 04 §3's `{ unmount, show, close }`-opsomming omdat
`page/lifecycle/internal.js`'s bestaande `FEATURE_ROUTES` al een
`golens-settings-ready -> ready`-route had; de route volgen woog zwaarder dan de
tekst.

### Gewijzigde bestanden
- `content.js` — `showSettingsOverlay`/`closeSettingsOverlay` en de
  `settingsOverlayRelease`/`settingsReturnFocus`-state verwijderd; het
  `golens-show-settings`/`golens-close-settings`-berichtpad is nu een dunne
  ack-only shim (zie hieronder); `golens-settings-ready`-handling helemaal
  verwijderd; `leaveMergeRequestPage`'s `closeSettingsOverlay(...)`-call
  verwijderd; een `overlayRegistry.subscribe(...)` toegevoegd die
  `state.queuedMascotMoment` flusht op de open→closed-transitie (verving de
  flush die vroeger inline in `closeSettingsOverlay` zat). Netto regelverschil:
  −57 / +~40 (functies weg, kleine shims + comments erbij).
- `page/features/settings-overlay.js` — nieuw, shell (113 regels).
- `page/features/settings-overlay.internal.js` — nieuw, pure core (41 regels;
  bewust klein, dit is een shell-zware feature).
- `page/main.js` — `overlays`-platformservice + `settings-overlay`-feature-entry
  toegevoegd (2 importregels, 1 platform-veld, 1 features-array-item).
- `tests/features-settings-overlay.test.js` — nieuw, 12 tests.
- `tests/content-onboarding.test.js` — de settings-overlay-DOM-assertions
  (regels 185–197) vervangen door ack-only-assertions; volledige DOM/handshake-
  dekking verhuisd naar het nieuwe testbestand.

### Testtotaal
266 tests groen (was 254; +12 nieuw, 0 verwijderd/geskipt).

### Gedragsafwijkingen (expliciet gerapporteerd)

1. **SPA-teardown is breder dan voorheen.** `closeSettingsOverlay` werd vroeger
   alleen aangeroepen vanuit `leaveMergeRequestPage` (bij het écht verlaten van
   de MR — `mergeRequestPageKey()` bleef stabiel bij tab-wissels binnen dezelfde
   MR). Nu draait de sluiting via `bootstrap.js`'s bestaande remount-op-elke-
   `location.href`-wijziging (unmount + remount van heel `page/main.js`), dus de
   overlay sluit nu ook bij in-MR-navigatie die voorheen geen effect had.
2. **content.js's ack is optimistisch geworden.** `golens-show-settings`/
   `golens-close-settings` retourneren `{ok:true, ...}` zonder zelf nog het
   werk te doen — dat werk gebeurt parallel via `page/lifecycle`'s eigen
   (niet-antwoordende) listener, die de module aanroept. Dit volgt letterlijk
   `page/lifecycle/index.js`'s eigen documentatie ("content.js's remains the
   one that responds, unchanged"), niet iets nieuws bedacht voor dit ticket.
3. **Onboarding↔settings wederzijds sluiten is niet meer één synchrone
   functieaanroep.** Settings-opent-sluit-onboarding blijft in `content.js`
   (rechtstreekse `closeOnboarding()`-aanroep, legaal want content.js is nog
   eigenaar van onboarding). Onboarding-opent-sluit-settings loopt nu via een
   eigen `chrome.runtime.onMessage`-listener in de module zelf (luistert ook
   naar `golens-show-onboarding`, met dezelfde `isGitLab()`/`isMergeRequest()`-
   guard als content.js's handler) i.p.v. een directe cross-module call
   (verboden per ticket 03 §3: feature → feature). Relatieve volgorde hangt nu
   af van listener-registratievolgorde i.p.v. gegarandeerd binnen één
   functielichaam.
4. **`golens-settings-ready` krijgt geen antwoord meer van content.js.**
   `settings.js`'s aanroep is al `.catch(() => undefined)` — geen
   gedragsverschil voor de caller. De handshake (`host.dataset.ready = 'true'`)
   zit nu in de module's `ready()`, bereikt via `page/lifecycle`'s bestaande
   `FEATURE_ROUTES`-route.

### Restant in content.js en waarom
- De ack-only `golens-show-settings`/`golens-close-settings`-handlers (met
  `isGitLab()`-guard en `closeOnboarding()`-call) blijven staan: nodig zolang
  `page/lifecycle`'s onMessage-listener zelf geen `sendResponse` doet (dat
  bestand valt buiten de file-ownership van dit ticket).
- `requestMascotMoment`'s `document.getElementById('golens-settings-root')`-
  check (regel ~1300) blijft ongewijzigd: leest alleen het DOM-id, dat de
  module nu identiek aanmaakt, dus blijft werken zonder wijziging.
- De `overlayRegistry.subscribe(...)`-flush voor `queuedMascotMoment` blijft in
  content.js staan (niet verplaatsbaar: `showMascotMoment`/`state.enabled`/
  `state.pageActive` zijn content.js-eigen celebration-state, geen onderdeel
  van de settings-overlay-migratie-scope).

# GoLens performance findings (analyse, geen wijzigingen)

Volgorde = hypothese-ranking op basis van code-inspectie. Alleen punt 5 is gemeten (zie onderaan).
Meet voordat je aan iets begint dat meer dan een uur kost.

---

## 1. `searchScope` draait bij élke hover over alle geïndexeerde bestanden
`go-semantic-core.js:569`. De worker roept dit aan via `withResultScope` voor `resolveHover`,
`resolveDefinition`, `findReferences` en `findImplementations` (`go-semantic-worker.js:52,151-155`).
Per aanroep:
```js
[...this.packages.values()].filter(...)            // kopie van alle packages
entries.flatMap(entry => [...entry.files.values()] // kopie van alle bestanden
  .map(file => `${entry.packagePath}\0${file.packageName}`))  // string per bestand
→ new Set(...).size
```
Bij een volledig geïndexeerd project is dat een allocatie per bestand, per hover — puur om een
`packageCount` te tonen. Cache `packageCount` per (origin, project, ref) en invalideer bij
`indexPackage`/`indexProject`/`disposeProject`. Lage risico's, raakt geen resolutie-semantiek.

## 2. `findReferences` roept `resolve()` aan per kandidaat
`go-semantic-core.js:1090`. De `identifierCandidates`-index is goed, maar per kandidaat volgt een
volledige `resolve()` (1110), en `resolve` doet `findIdentifierNode` = een boomwandeling door dat
bestand (988). Voor een veelgebruikte naam (`New`, `Err`, `Client`) in een volledig project zijn dat
honderden boomwandelingen per Cmd-klik. Het `locations.length > size` break helpt alleen als de
eerste kandidaten raak zijn.
Opties: kandidaten groeperen per bestand en per bestand één keer wandelen; of `findIdentifierNode`
overslaan omdat de node al bekend is (de kandidaat bevat `{file, node}`) en direct de
resolutie-stap op die node uitvoeren.

## 3. `findImplementations` bouwt per query het volledige project opnieuw op
`go-semantic-core.js:872`. Per aanroep: `flatMap` over alle `typeRecords` van alle packages, twee
Maps over álle records, `methodsByReceiver` over alle methods, daarna `promotedMethods()` **twee
keer** (value + pointer) voor élk type-record, recursief met een `new Set(visiting)`-kopie per tak
(922). Vervolgens sorteren. Niets gememoïseerd, en elke volgende cursor-pagina (970) herberekent
alles.
Commit 822cb29 ("Search all interface methods when finding Go implementations") heeft deze zoekruimte
recent verbreed — plausibele regressiebron.
Opties: `recordsByIdentity` / `methodsByReceiver` / `promotedMethods` cachen per (project, ref) en
invalideren bij index-mutatie; het volledige kandidatenresultaat per interface-identity cachen zodat
paginering gratis is.

## 4. In-memory index verdwijnt bij elke service-worker respawn
`go-semantic-worker.js:20 semanticIndex()` houdt de index alleen in geheugen; MV3 killt de SW na
~30 s idle. Elke respawn: WASM-init + Tree-sitter parse van **alle** bronbestanden opnieuw
(`restoreProject`/`restorePackage` → `index.indexProject`, core:795). Bij een gecachet volledig
project is dat de zwaarste post op een koude hover. WASM-init is al lui — dat deel is goed.
Opties: geserialiseerde symbolenindex in IndexedDB (key = origin+project+ref + formaatversie), of de
SW warm houden tijdens een actieve review via de bestaande `golens-go-rpc` port (heartbeat < 30 s).
Grootste winst, grootste implementatiekost.

## 5. Cache-statuschecks: sequentiële IDB-rondgangen + hash-hervalidatie
`go-semantic-cache.js`. `validSourceRecord` (96) → `gitBlobID` hasht de volledige bron van élk
bestand bij élke lees- én statuscheck: `readSnapshot` (439), `hasSnapshot` (464), `prepareSources`
(288), en `stageSnapshotSources` (406/418 — hasht net geschreven records meteen weer terug).

**Gemeten** (Node, `crypto.subtle` SHA-1, 4 KB per bestand): 100 → 5 ms, 500 → 7 ms, 2000 → 21 ms.
Het hashen zelf is dus *niet* de bottleneck. De kost zit in de structuur eromheen:
- `mergeRequestStatus` (240) loopt **sequentieel** over alle packages → `packageStatus` (265) →
  `hasSnapshot`, elk met een eigen IDB-transactie + N `get`-requests. Bij een MR met 20 packages
  zijn dat 20 manifest-reads + honderden losse `get`s achter elkaar.
- De fallback in `packageStatus` (270) leest het **volledige project-manifest** per package.
Opties: één transactie voor de hele MR-status; packages parallel; `verified`-vlag op het
source-record zodat de leespad-hash vervalt (de record-ID bevat de blobId al — `sourceID`, 16 — dus
de hash is defense-in-depth, geen correctheid).

Extra, bijna gratis: `loadPackage` (`go-navigation.js` ~797) roept eerst `packageCacheStatus` aan en
daarna pas `restorePackage`, terwijl `restorePackage` (worker:87) begint met `index.hasPackage` —
de gratis geheugencheck. Het warme pad betaalt dus de dure IDB-statuscheck om iets te bewaken dat
sowieso zou kortsluiten. Omdraaien.

## 6. `mutationQueue` serialiseert statuschecks achter zware jobs — **hangt af van 5**
`go-semantic-worker.js:9,160`: `packageCacheStatus`, `projectCacheStatus`, `prepareSources` staan in
`MUTATING_METHODS`, en `dispatch` laat óók niet-muterende calls op `mutationQueue` wachten. Een hover
tijdens "cache full project" wacht tot die job klaar is (timeout 120 s).

Let op: die methodes staan daar **terecht** — ze muteren echt (`hasSnapshot`/`readSnapshot` →
`validateSourceRecords` → `deleteSourceRecords`, cache.js:401; `prepareSources` → idem, 290).
Ze kunnen pas uit de queue nadat punt 5 de hervalidatie van het leespad haalt.
Beperk dit bovendien tot de IDB-only subset (`*CacheStatus`, `cacheStats`). Haal `resolve*`/`find*`
**niet** uit de queue: `cacheProject` (worker:131) await tussen `stageProject` → `indexProject` →
`writeProject`, dus een read die de queue omzeilt kan een half gevulde index zien en "niet gevonden"
teruggeven — dat botst met "nooit speculatief navigeren op ontbrekende symbolen".

## 7. `onMouseMove` doet volledig DOM-werk per muisbeweging
`go-navigation.js:2694` → `targetAtEvent` (2840), ongethrottled, capture-fase op document:
- `codeCellFor` (188): meerdere `closest`/`querySelector`.
- `fileContextFor` (151): `JSON.parse(data-file-data)` + `[...root.querySelectorAll('a[href*="/-/blob/"]')]`
  + `parseBlobLink` per link — per mousemove, zonder cache per diff-root.
- `caretAtPoint` (387): `caretPositionFromPoint` + `Range.toString()` over de hele cel (forced layout).

De 350 ms hover-timer (2718) beschermt alleen de RPC, niet de hit-test. Winst: `fileContextFor`
cachen per root (WeakMap, invalideren via de bestaande diffObserver) en de hit-test throttlen op
rAF of ~50 ms.

## 8. `occurrenceRanges` is kwadratisch over de hele diff
`go-navigation.js:2151`: per code-cel van élke diff-file een TreeWalker, en per tekstnode een nieuwe
Range + `prefix.toString()` (2160-2163) die telkens de hele cel-prefix opnieuw opbouwt. Draait via
`scheduleOccurrenceRefresh` (30 ms) bij iedere DOM-mutatie zolang er een symbool geselecteerd is.
Opties: prefix-offset incrementeel bijhouden i.p.v. `Range.toString()`; alleen gewijzigde roots
herberekenen; cellen zonder `textContent.includes(identifier)` overslaan vóór de walker.

## 9. Twee body-brede MutationObservers zonder debounce
- `content.js:2016`: `observe(document.body, {childList, subtree})` → `schedulePageReconcile`
  (setTimeout 0). `reconcilePage` (1959) doet 4-5 document-brede `querySelectorAll`-sweeps
  (512-513, 195-201, 223-243, 292-300) die zelf weer muteren → observer vuurt opnieuw.
- `go-navigation.js:2860`: idem, plus `characterData: true`.
Opties: debounce naar ~100-150 ms met idle-fallback; observer scopen op de diff-container i.p.v.
`document.body`.

## 10. Netwerk
- `mapLimit(..., 6, ...)` (791) voor blobs. Verhogen naar 10-12 kan, **maar** `fetchBlob` (836)
  gooit bij elke `!response.ok` zonder retry, dus één 429 breekt de hele full-project-cachejob af.
  Backoff/retry is een voorwaarde vooraf, geen extraatje.
- Paginering (647/665/705/726/745) is strikt sequentieel: pagina N+1 pas na N. Met `x-total-pages`
  kunnen 2..N parallel — maar de sequentiële fallback moet blijven wanneer de header ontbreekt
  (AGENTS.md eist het behoud van de page-size fallback, GitLab.com laat headers soms weg).
- Geen negatieve caching van 404's in `fetchSource`/`fetchBlob`; herhaalde hovers op een ontbrekend
  pad refetchen elke keer.

## 11. Kleine posten
- `new TextEncoder()` per bestand in `snapshotFiles` (79) en `stats` (306/110) → één gedeelde instantie.
- `restoreMergeRequest` (worker:111) leest packages sequentieel, elk een eigen IDB-transactie.
- ~287 KB niet-geminificeerde content scripts (`shortcut-settings` + `bookmark-store` +
  `go-navigation` 147 KB + `content` 121 KB) parsen op élke gitlab.com-pagina, ook niet-MR-pagina's.
  `go-navigation.js` pas injecteren na MR-detectie (`chrome.scripting`) scheelt parse + init overal
  elders.

---

## Meten
`tests/browser-smoke.mjs` heeft al large-diff dekking (commit dd59799 / #15). Instrumenteer daar
fase-timings: inject → MR gedetecteerd → eerste hover opgelost → definitie opgelost. Plus één
handmatige opname via chrome://extensions → service worker → Performance voor de koude hover
(punt 4) en één Cmd-klik op een veelgebruikt symbool (punten 2 en 3).

## Randvoorwaarden (AGENTS.md)
- Semantiek DOM-onafhankelijk in `go-semantic-core.js`; browserintegratie in `go-navigation.js`.
- Commit-pinned, same-origin, geen nieuwe permissies. `unlimitedStorage` is er al → IDB-caching mag.
- Niet speculatief navigeren; directory-limiet moet expliciet falen. Prefetchen mag, index afknippen niet.
- Zichtbare wijzigingen trekken de Help-referentie + `tests/content-onboarding.test.js` mee → geef de
  voorkeur aan onzichtbare optimalisaties.

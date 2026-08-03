# 24 — Benchmark weer bruikbaar maken als gate

**What to build:** `npm run bench` loopt weer tot het einde, zodat performance-regressies in 13–21
meetbaar zijn. De benchmark crashte met
`FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory`.

**Meting (2026-08-03):** de crash is niet door deze operatie veroorzaakt — hij treedt identiek op bij
`8cf692c` (vóór ticket 05/06/07, dus vóór elke codewijziging van deze operatie) en bij `22a22b5`.
De run komt door de vroege scenario's heen en klapt in de latere, grotere scenario's
(`stats [large: ~20000 source records]` / `indexProject` en verder). Node v26.5.1.

**Blocked by:** None — can start immediately.

**Status:** closed — `npm run bench` groen op de standaard heap, geen `package.json`-wijziging nodig

- [x] Oorzaak benoemd: **de drie `diff-dom`-benchmarks gaven hun happy-dom-fixture nooit vrij.**
      Geen lek in productiecode, en ook geen "fixture te groot voor de standaard heap". Zie
      "Diagnose".
- [x] `npm run bench` draait tot het einde en print zijn resultaten — `EXIT:0` op de **standaard**
      heap (geen `--max-old-space-size`), peak RSS 1.95 GB (was 5.42 GB), heap-plateau 302 MB.
- [x] Een baseline-meting vastgelegd in dit ticket, zodat 13–21 ertegen kunnen vergelijken
- [x] Geen echt lek in `go-semantic-*.js` als crash-oorzaak; wel een apart, gedocumenteerd
      geheugen-risico op 20k-bestand schaal — zie "Risico". Niet aangeraakt.

## Diagnose (2026-08-03)

Node's default V8 oud-generatie-limiet op de meetmachine is 4192 MB. `npm run bench` klapte bij
~4.56 GB RSS.

`scripts/benchmark.mjs` logt nu (alleen onder `--expose-gc`) `heapUsed` na een geforceerde GC per
scenario. Dat maakte de oorzaak zichtbaar: heapUsed springt in drie stappen omhoog tijdens de eerste
drie `diff-dom`-scenario's (`fileContextFor`/`codeCellFor`/`caretAtPoint`, elk met een eigen
60x120 happy-dom-fixture): **1342 → 2664 → 4003 MB**, en zakt daarna nooit terug. Vanaf dat plateau
is er nog ~190 MB over voor de rest van de suite, en de "large" `semantic-core`-scenario's
(1200x16 ≈ 19.200 bestanden, ~290 MB) passen daar niet meer in. Dat is de crash.

Wie hield die drie DOM's vast? Geïsoleerd gemeten, in aflopende volgorde:

- Niet de productiecode. Dezelfde groei van ~1.3 GB per iteratie treedt op **zonder ook maar één
  helper uit `go-navigation.js` aan te roepen**; `fileContextCache` is bovendien een `WeakMap`.
- Niet `runCase`: de setup-context is na afloop niet meer bereikbaar vanuit de harness.
- Wel de teardown van `happy-dom`. Gemeten per variant, 2 iteraties met een 60x120-fixture:

  | teardown | heap-delta |
  | --- | ---: |
  | `window.close()` (synchroon) | **+2635 MB** |
  | `await window.happyDOM.close()` | −1 MB |
  | `document.body.innerHTML = ''` + `close()` | +1 MB |

  Alleen `globalThis.document = window.document` zetten is al genoeg om de document vast te pinnen,
  en een `delete globalThis.document` maakt dat niet ongedaan. De synchrone `window.close()` breekt
  die keten niet; `happyDOM.close()` wel.

**Fix:** `runCase` in `scripts/benchmark.mjs` kreeg een `teardown`-hook (aangeroepen in een
`finally`, dus ook bij een falend scenario), en de vier cases in
`tests/benchmarks/diff-dom.bench.mjs` geven hun fixture vrij via `await window.happyDOM.close()`.

Resultaat: heap-plateau **302 MB** in plaats van 4009 MB, peak RSS **1.95 GB** in plaats van
5.42 GB, `npm run bench` `EXIT:0` op de standaard heap. Een `--max-old-space-size`-verhoging in
`package.json` is dus **niet** nodig en is bewust niet toegepast — dat had de echte oorzaak
gemaskeerd, precies zoals de "Let op" van dit ticket waarschuwde.

## Risico (apart gerapporteerd, niet gerepareerd — buiten scope van dit ticket)

Geïsoleerd gemeten (nieuw proces, alleen `indexProject` op de 19.200-bestands fixture, één aanroep,
geforceerde GC voor/na): heapUsed-delta 274.3 MB ≈ **15.0 KB/bestand**, RSS-delta 549.0 MB ≈
**29.9 KB/bestand**. Dat is een eenmalige, met de fixture-grootte schalende kost — geen groei per
herhaalde aanroep — maar voor een repo van de doelgrootte is dat ~275–550 MB voor **één**
`indexProject`. In een Node-proces met GB's ruimte onopvallend; de extensie draait in een
Chrome-service-worker met een aanzienlijk krapper geheugenbudget.

Aanbevolen vervolgonderzoek (niet uitgevoerd):

- Houdt `go-semantic-core.js` ooit twee volledige indices van dezelfde grootteorde tegelijk levend
  (her-index terwijl de oude index nog in gebruik is, of basis- én vergelijkingsref van een MR-diff)?
- Worden `Tree`/`Node`-objecten van `web-tree-sitter` vrijgegeven wanneer bestanden uit de index
  verdwijnen? `this.files.delete(...)` in `go-semantic-core.js` roept nergens `tree.delete()` /
  `node.delete()` aan (via `grep` bevestigd). Dat zou een accumulerend **native** geheugenlek zijn
  over de levensduur van de service worker, onzichtbaar in `heapUsed`/`external`/`arrayBuffers` —
  het veroorzaakt de hierboven gemeten OOM dus niet, maar verdient een eigen ticket als het
  bevestigd wordt.

## Baseline (2026-08-03, `npm run bench`, standaard heap, Node v26.5.1)

Zwaarste scenario's: `stats [large] (IndexedDB (fake))` 24852 ms,
`indexProject (cold) [large: 1200x16 (~19,200 files)]` 2943 ms,
`findReferences (widely used identifier, pageSize:100) [large]` 1162 ms.

```
name                                                                                                          median(ms)  p95(ms)  ops/s
fileContextFor x1000 (uncached, 60x120 diff, un-throttled mousemove path)                                          1.530    1.655       653
codeCellFor x1000 (uncached, 60x120 diff, hit-test path)                                                           0.220    0.230      4539
caretAtPoint x1000 (uncached, 60x120 diff, hover hit-test path, stubbed browser caret hit-test)                    68.03    70.52        15
occurrenceRanges (8x3 diff, reduced from 60x120 — see file header)                                                 6.739    6.824       148
prepareSources (500 files, half cached) (in-memory)                                                                1.909    2.974       524
prepareSources (500 files, half cached) (IndexedDB (fake))                                                         4.358    5.026       229
writePackage + readPackage round trip (in-memory x20)                                                              0.603    0.703      1659
writePackage + readPackage round trip (IndexedDB (fake))                                                           6.480    6.552       154
packageStatus (single package) (in-memory x50)                                                                     0.089    0.118     11212
packageStatus (single package) (IndexedDB (fake))                                                                  2.559    2.591       391
mergeRequestStatus (20 packages, sequential loop) (in-memory x10)                                                  0.184    0.227      5436
mergeRequestStatus (20 packages, sequential loop) (IndexedDB (fake))                                               5.176    5.243       193
stats (in-memory x300)                                                                                             0.164    0.202      6095
stats (IndexedDB (fake))                                                                                           64.74    65.72        15
stats [large: ~20000 source records, ~20k-file-repo scale] (in-memory x20)                                         3.244    11.30       308
stats [large: ~20000 source records, ~20k-file-repo scale] (IndexedDB (fake))                                   24852.01  24852.01         0
indexProject (cold) [small: 40x8 (~320 files)]                                                                     50.88    53.85        20
searchScope (mode: project) [small: 40x8 (~320 files)]                                                             0.001    0.006    959693
findReferences (widely used identifier, pageSize:100) [small: 40x8 (~320 files)]                                   17.67    18.19        57
findImplementations (page 1) [small: 40x8 (~320 files)]                                                            0.300    0.355      3331
findImplementations (page 2 via cursor) [small: 40x8 (~320 files)]                                                 0.255    0.410      3921
searchScope (mode: package) [small: 40x8 (~320 files)]                                                             0.001    0.004   1715266
resolve (common identifier "New") x100 [small: 40x8 (~320 files)]                                                  0.195    0.257      5134
indexProject (cold) [large: 1200x16 (~19,200 files, ~20k-file-repo scale)]                                       2943.28  2943.28         0
searchScope (mode: project) [large: 1200x16 (~19,200 files, ~20k-file-repo scale)]                                 0.001    0.001   1142857
findReferences (widely used identifier, pageSize:100) [large: 1200x16 (~19,200 files, ~20k-file-repo scale)]     1161.88  1203.19         1
findImplementations (page 1) [large: 1200x16 (~19,200 files, ~20k-file-repo scale)]                                40.48    41.74        25
findImplementations (page 2 via cursor) [large: 1200x16 (~19,200 files, ~20k-file-repo scale)]                     40.17    40.77        25
searchScope (mode: package) [large: 1200x16 (~19,200 files, ~20k-file-repo scale)]                                 0.001    0.005   1454545
```

Let op bij het vergelijken: de eerste drie `diff-dom`-cijfers liggen iets hoger dan in de
pre-fix-meting, omdat elk scenario nu een eigen, niet-vervuilde heap heeft. Gebruik deze tabel
(standaard heap, na de teardown-fix) als baseline voor 13–21, niet de oudere `--max-old-space-size`-runs.

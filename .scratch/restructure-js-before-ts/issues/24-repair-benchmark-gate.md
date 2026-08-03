# 24 — Benchmark weer bruikbaar maken als gate

**What to build:** `npm run bench` loopt weer tot het einde, zodat performance-regressies in 13–21
meetbaar zijn. De benchmark crasht nu met
`FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory`.

**Meting (2026-08-03):** de crash is niet door deze operatie veroorzaakt — hij treedt identiek op bij
`8cf692c` (vóór ticket 05/06/07, dus vóór elke codewijziging van deze operatie) en bij `22a22b5`.
De run komt door de vroege scenario's heen en klapt in de latere, grotere scenario's
(`stats [large: ~20000 source records]` / `indexProject` en verder). Node v26.5.1.

**Blocked by:** None — can start immediately.

**Status:** partial — oorzaak beantwoord, fix bekend, package.json-wijziging niet zelf toegepast
(buiten file-ownership van deze operatie)

- [x] Oorzaak benoemd: **fixture-schaal boven de standaard heap-limiet, geen accumulerend lek.**
      Zie "Diagnose" hieronder.
- [x] `npm run bench` draait tot het einde en print zijn resultaten — geverifieerd met
      `node --max-old-space-size=8192 scripts/benchmark.mjs` (exit 0). Standaard `npm run bench`
      (zonder flag) crasht nog steeds, omdat `package.json` buiten mijn file-ownership valt — zie
      "Actie voor orchestrator" hieronder.
- [x] Een baseline-meting vastgelegd in dit ticket, zodat 13–21 ertegen kunnen vergelijken
- [x] Geen echt lek in `go-semantic-*.js` gevonden qua "accumuleert onbeperkt over herhaalde calls";
      wel een apart, gedocumenteerd geheugen-risico bij 20k-bestand schaal — zie "Risico" hieronder.
      Niet aangeraakt (`go-semantic-*.js` is verboden voor mij).

## Diagnose (2026-08-03, herhaling van de meting)

Node's default V8 oud-generatie-limiet op de meetmachine is 4192 MB (machine heeft 20.7 GB RAM).
`npm run bench` klapt bij ~4.56 GB RSS; met `--max-old-space-size=8192` loopt de volledige suite
door: exit 0, 85–87s real, peak RSS 5.42 GB / peak memory footprint 5.68 GB.

Verificatie dat dit **geen** over-scenario's-heen accumulerend lek is: `scripts/benchmark.mjs` logt
nu (alleen onder `--expose-gc`) `heapUsed` na een geforceerde GC per scenario. Uitkomst van één volle
run (`node --expose-gc --max-old-space-size=8192 scripts/benchmark.mjs`):

- heapUsed springt in drie stappen omhoog tijdens de eerste drie `diff-dom`-scenario's
  (`fileContextFor`/`codeCellFor`/`caretAtPoint`, elk met een eigen 60x120 happy-dom-fixture):
  1342 MB → 2664 MB → 4003 MB (~1.3 GB per fixture, blijkbaar niet vrijgegeven door GC tussen
  scenario's — zie risico-notitie hieronder over `tests/benchmarks/diff-dom.bench.mjs`, niet mijn
  bestand).
- Daarna **vlak** voor 13 opeenvolgende `semantic-cache`-scenario's: 4009.3 → 4009.6 → 4009.6 → ...
  → 4009.6 MB. Geen groei — dit weerlegt een lek dat doorloopt over scenario's heen.
- Pas bij de "large" `semantic-core`-scenario's (1200x16 ≈ 19.200 bestanden) stijgt het opnieuw,
  van 4015.6 naar 4304.1 MB, en blijft daarna weer vlak.

Los daarvan, geïsoleerd gemeten (nieuw proces, alleen `indexProject` op de 19.200-bestands fixture,
één aanroep, geforceerde GC voor/na):
- heapUsed-delta: 274.3 MB voor 19.200 bestanden ≈ **15.0 KB/bestand**
- RSS-delta: 549.0 MB ≈ **29.9 KB/bestand**

Dit is een eenmalige, met de fixture-grootte schalende kost — geen kost die per herhaalde aanroep
verder oploopt. Conclusie: de OOM-crash komt door de optelsom van meerdere legitiem grote fixtures
(happy-dom-DOM's + het 19.200-bestands synthetische Go-project) die in één Node-proces samen boven
de standaard heap-limiet uitkomen, niet door een geheugenlek dat binnen één scenario onbeperkt
doorgroeit.

## Risico (apart gerapporteerd, niet gerepareerd — `go-semantic-*.js` is verboden voor mij)

15 KB heapUsed / 30 KB RSS per bestand om eenmalig te indexeren is, voor een repo van de doelgrootte
(~20.000 bestanden), ~275–550 MB voor **één** `indexProject`-aanroep — in een Node-proces met GB's
ruimte onopvallend, maar de extensie draait in een Chrome-service-worker met een aanzienlijk kleinere
geheugenbudget. Als de extensie ooit meer dan één index tegelijk vasthoudt (bv. tijdens een
her-index terwijl de oude index nog in gebruik is, of index van basis- én vergelijkingsref in een
MR-diff), is een piek van 0.5–1+ GB in een service worker een reëel risico op een crash/eviction
door Chrome, los van of dit een "lek" in de klassieke zin is (het is geen onbeperkte groei — het is
een grote maar begrensde, met bestandsaantal schalende kost). Aanbevolen vervolgonderzoek (niet
uitgevoerd, buiten scope van dit ticket): of `go-semantic-core.js` ooit twee volledige indices van
eenzelfde grootteorde tegelijk levend houdt, en of `Tree`/`Node`-objects van `web-tree-sitter`
(`.delete()`) worden vrijgegeven wanneer bestanden uit de index verdwijnen (`this.files.delete(...)`
in `go-semantic-core.js` roept nergens `tree.delete()`/`node.delete()` aan — geconfirmeerd via
`grep`; dat is een apart, mogelijk accumulerend native-geheugenlek bij herhaald her-indexeren over de
levensduur van de service worker, dat NIET zichtbaar is in `heapUsed`/`external`/`arrayBuffers` en
dus niet de hierboven gemeten OOM-crash veroorzaakt, maar wel een eigen ticket verdient als dit
bevestigd wordt).

## Baseline (2026-08-03, `node --max-old-space-size=8192 scripts/benchmark.mjs`, Node v26.5.1)

Zwaarste scenario's: `indexProject (cold) [large: 1200x16 (~19,200 files)]` 3020.87 ms,
`findReferences (widely used identifier, pageSize:100) [large]` 1207.39 ms. Volledige tabel:

```
name                                                                                                          median(ms)  p95(ms)  ops/s
fileContextFor x1000 (uncached, 60x120 diff, un-throttled mousemove path)                                          0.507    1.029      1971
codeCellFor x1000 (uncached, 60x120 diff, hit-test path)                                                           0.223    0.237      4476
caretAtPoint x1000 (uncached, 60x120 diff, hover hit-test path, stubbed browser caret hit-test)                    67.78    71.34        15
occurrenceRanges (8x3 diff, reduced from 60x120 — see file header)                                                 7.003    7.277       143
prepareSources (500 files, half cached) (in-memory)                                                                1.947    4.220       514
prepareSources (500 files, half cached) (IndexedDB (fake))                                                         3.860    6.093       259
writePackage + readPackage round trip (in-memory x20)                                                              0.630    0.731      1588
writePackage + readPackage round trip (IndexedDB (fake))                                                           6.464    6.598       155
packageStatus (single package) (in-memory x50)                                                                     0.073    0.094     13746
packageStatus (single package) (IndexedDB (fake))                                                                  2.556    2.575       391
mergeRequestStatus (20 packages, sequential loop) (in-memory x10)                                                  0.183    0.250      5469
mergeRequestStatus (20 packages, sequential loop) (IndexedDB (fake))                                               5.188    5.236       193
stats (in-memory x300)                                                                                             0.176    0.245      5691
stats (IndexedDB (fake))                                                                                           63.68    67.30        16
stats [large: ~20000 source records, ~20k-file-repo scale] (in-memory x20)                                         2.983    8.458       335
stats [large: ~20000 source records, ~20k-file-repo scale] (IndexedDB (fake))                                   25690.27  25690.27         0
indexProject (cold) [small: 40x8 (~320 files)]                                                                     54.59    57.70        18
searchScope (mode: project) [small: 40x8 (~320 files)]                                                             0.001    0.006    923361
findReferences (widely used identifier, pageSize:100) [small: 40x8 (~320 files)]                                   19.00    19.71        53
findImplementations (page 1) [small: 40x8 (~320 files)]                                                            0.287    2.645      3485
findImplementations (page 2 via cursor) [small: 40x8 (~320 files)]                                                 0.256    0.309      3901
searchScope (mode: package) [small: 40x8 (~320 files)]                                                             0.001    0.003   2000000
resolve (common identifier "New") x100 [small: 40x8 (~320 files)]                                                  0.212    0.276      4713
indexProject (cold) [large: 1200x16 (~19,200 files, ~20k-file-repo scale)]                                       2996.03  2996.03         0
searchScope (mode: project) [large: 1200x16 (~19,200 files, ~20k-file-repo scale)]                                 0.001    0.012   1142857
findReferences (widely used identifier, pageSize:100) [large: 1200x16 (~19,200 files, ~20k-file-repo scale)]     1256.43  1272.14         1
findImplementations (page 1) [large: 1200x16 (~19,200 files, ~20k-file-repo scale)]                                41.11    45.32        24
findImplementations (page 2 via cursor) [large: 1200x16 (~19,200 files, ~20k-file-repo scale)]                     41.76    46.13        24
searchScope (mode: package) [large: 1200x16 (~19,200 files, ~20k-file-repo scale)]                                 0.001    0.007   1713796
```

## Actie voor orchestrator (buiten mijn file-ownership — `package.json` niet zelf gewijzigd)

Verhoog de heap voor het `bench`-script in `package.json`:

```
"bench": "node --max-old-space-size=8192 scripts/benchmark.mjs",
```

(was: `"bench": "node scripts/benchmark.mjs",`). 8192 MB is ruim boven de gemeten 5.68 GB piek en
laat comfortabele marge voor toekomstige, iets grotere fixtures.

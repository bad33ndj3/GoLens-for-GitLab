# 24 — Benchmark weer bruikbaar maken als gate

**What to build:** `npm run bench` loopt weer tot het einde, zodat performance-regressies in 13–21
meetbaar zijn. De benchmark crasht nu met
`FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory`.

**Meting (2026-08-03):** de crash is niet door deze operatie veroorzaakt — hij treedt identiek op bij
`8cf692c` (vóór ticket 05/06/07, dus vóór elke codewijziging van deze operatie) en bij `22a22b5`.
De run komt door de vroege scenario's heen en klapt in de latere, grotere scenario's
(`stats [large: ~20000 source records]` / `indexProject` en verder). Node v26.5.1.

**Blocked by:** None — can start immediately.

**Status:** open

- [ ] Oorzaak benoemd: echt geheugenlek in de gemeten code, of een te grote fixture / te lage
      standaard heap-limiet in `scripts/benchmark.mjs`
- [ ] `npm run bench` draait tot het einde en print zijn resultaten
- [ ] Een baseline-meting vastgelegd in dit ticket, zodat 13–21 ertegen kunnen vergelijken
- [ ] Als het een echt lek in productiecode is: apart gerapporteerd, niet stilzwijgend weggeconfigureerd

**Let op:** als de fix `--max-old-space-size` is, controleer eerst of de gemeten code niet zelf lekt.
De extensie draait in een service worker met een krappere heap dan Node; een benchmark die alleen met
een opgehoogde heap haalbaar is, kan een echt productieprobleem maskeren.

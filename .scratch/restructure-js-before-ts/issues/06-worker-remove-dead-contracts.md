# 06 — Worker-opruiming: dode contracten verwijderen

**What to build:** De twee door ticket 02 gevonden dode contracten verdwijnen, gedragsbehoudend:
de nooit-gevulde `_implementationCache` in `go-semantic-core.js` inclusief alle onderhoudscode
(clear/dispose-paden), en het `golens-go-status` custom event in `go-navigation.js` dat nergens
een listener heeft (ticket 03 §7).

**Blocked by:** None — can start immediately.

**Status:** resolved — scope ingeperkt tot één dood contract, zie besluit hieronder

- [x] Geen verwijzing naar `_implementationCache` meer; `findImplementations`-gedrag ongewijzigd
- [x] ~~Geen `golens-go-status`-dispatch meer~~ — **geschrapt uit dit ticket** (besluit 2026-08-03,
      door de user: het event is niet dood, zie note)
- [x] Volledige `npm run check` groen (unit tests; `test:browser` fails in this sandbox for
      unrelated reasons — no Chrome DevTools target reachable, same failure pre-existing before
      this change)

**Note (2026-08-03):** `golens-go-status` is not dead. `tests/browser-smoke.mjs:268` registers
a listener that sets `document.body.dataset.goStatus`, and `tests/browser-smoke.mjs:445` gates
the ctrl-click that drives the whole "implementations popover" smoke-test path on
`dataset.goStatus === 'ready'`. Deleting the dispatch would silently break that smoke coverage
(the click never fires, later popover assertions never run/time out) — this is a real
test-observability consumer, not a leftover. Ticket 02/03's "zero listeners" claim was made
before this grep. Left the dispatch in place per hard rule: stop and report rather than delete
when a real consumer surfaces. Options: (a) keep the dispatch, drop this item from the ticket;
(b) give the smoke test an independent readiness signal first (separate ticket), then delete the
dispatch; (c) delete both and accept losing that smoke coverage. Recommend (a) or (b).

**Besluit (2026-08-03, user):** optie (a). De dispatch blijft staan; dit ticket dekt alleen nog
`_implementationCache`. Reden: de "geen listener"-premisse van 02/03 §7 was feitelijk onjuist, dus
de grond om het contract te slopen vervalt. Een vervangend readiness-signaal is dezelfde
DOM-koppeling in een andere vorm, zonder winst en met risico op verlies van juist die
smoke-coverage die deze operatie moet beschermen. Ticket 03 §7 hiermee gecorrigeerd: één dood
contract gevonden, niet twee.

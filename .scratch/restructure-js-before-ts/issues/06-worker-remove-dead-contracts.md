# 06 — Worker-opruiming: dode contracten verwijderen

**What to build:** De twee door ticket 02 gevonden dode contracten verdwijnen, gedragsbehoudend:
de nooit-gevulde `_implementationCache` in `go-semantic-core.js` inclusief alle onderhoudscode
(clear/dispose-paden), en het `golens-go-status` custom event in `go-navigation.js` dat nergens
een listener heeft (ticket 03 §7).

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Geen verwijzing naar `_implementationCache` meer; `findImplementations`-gedrag ongewijzigd
- [ ] Geen `golens-go-status`-dispatch meer; loading-progress-gedrag ongewijzigd
- [ ] Volledige `npm run check` groen

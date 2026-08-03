# 08 — platform/clock dedup

**What to build:** De onafhankelijk gedupliceerde `defaultClock`/`setClock`/`debounceIdle` in
`go-navigation.js` en `content.js` worden één `platform/clock`-module (interface ticket 04 §2).
Expand–contract: module bestaat al uit ticket 05; beide legacy-bestanden migreren hun call sites
(via een tijdelijke bridge zolang ze geen ES modules zijn), daarna verdwijnen de duplicaten.
Tests die `setClock` gebruiken schakelen over op de clock-seam.

**Blocked by:** 05 — Bootstrap + page-skelet.

**Status:** ready-for-agent

- [ ] Eén clock-implementatie; duplicaten uit beide legacy-bestanden verwijderd
- [ ] Debounce-/timinggedrag ongewijzigd (bestaande tests bewijzen dit)
- [ ] Volledige `npm run check` groen

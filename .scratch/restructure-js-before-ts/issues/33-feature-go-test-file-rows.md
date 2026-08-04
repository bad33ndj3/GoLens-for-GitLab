# 33 — Feature-migratie: go-test-file-rows

**What to build:** `page/features/go-test-file-rows.js`: `normalizeRepositoryPath`/
`restoreGoTestFileRows`/`reconcileGoTestFileRows` uit `content.js` — het gemiste-slice-gat dat
map.md al onder tickets 13/22 signaleerde ("Geen enkel ticket 13–21 claimt de
go-test-file-rows-feature"). Kleine, op zichzelf staande feature.

**Blocked by:** geen.

**Status:** resolved

- [ ] `_test.go`-detectie en attribute-toggling exact ongewijzigd
- [ ] Unit tests in `tests/features-go-test-file-rows.test.js`
- [ ] `npm run check:syntax` en `npm test` groen

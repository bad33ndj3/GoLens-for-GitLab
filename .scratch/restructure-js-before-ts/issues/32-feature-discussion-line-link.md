# 32 — Feature-migratie: discussion-line-link

**What to build:** `page/features/discussion-line-link.js`: `overviewDiscussionLineTarget`/
`mountOverviewDiscussionLineLink`/`removeOverviewDiscussionLineLinks`/
`reconcileOverviewDiscussionLineLinks` uit `content.js` — de "View in changes"-link op
discussion-overzichten. Kleine, op zichzelf staande feature; geen `legacy`-bag nodig (leest alleen
eigen DOM-queries).

**Blocked by:** geen.

**Status:** resolved

- [ ] Link-plaatsing/verwijdering/href-berekening exact ongewijzigd
- [ ] Unit tests in `tests/features-discussion-line-link.test.js`
- [ ] `npm run check:syntax` en `npm test` groen

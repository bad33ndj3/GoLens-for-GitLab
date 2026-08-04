# 35 — content.js's resterende message-types naar bootstrap

**What to build:** `content.js`'s eigen `chrome.runtime.onMessage`-listener behandelt vandaag
`golens-enabled`/`golens-cache-invalidated`/`golens-preload-full-project`/
`golens-full-project-status`. Zodra `content.js` verdwijnt (ticket 22) hebben deze vier types een
claim in `bootstrap.js` nodig, zelfde patroon als ticket 16's drie settings-types (zie map.md's
"Message-seam"-sectie: geclaimde types in een lijst, `withHandle()`, kind-uit-gesloten-verzameling
antwoorden, `tests/bootstrap-message-seam.test.js` bewaakt de deelverzameling-invariant). Valt
vermoedelijk toe aan welke van 30/31 het onderliggende gedrag bezit (`golens-enabled` → 34's
eigenaar; `golens-cache-invalidated`/`golens-preload-full-project`/`golens-full-project-status` →
30's preload-state-machine) — dit ticket claimt ze expliciet in bootstrap.js zodat ze niet
stilzwijgend verloren gaan.

**Blocked by:** 30 — feature-controls; 34 — derived-enabled-owner.

**Status:** ready-for-agent

- [ ] Alle vier message-types geclaimd in `bootstrap.js`, geroute naar de juiste feature-handle
- [ ] `tests/bootstrap-message-seam.test.js`'s deelverzameling-invariant blijft kloppen
- [ ] Geen twee responders op hetzelfde message-type
- [ ] `npm run check:syntax` en `npm test` groen; browser-smoke solo groen

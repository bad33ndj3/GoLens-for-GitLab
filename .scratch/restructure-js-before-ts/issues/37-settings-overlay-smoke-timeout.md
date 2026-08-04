# 37 — Browser-smoke: settings-overlay-scenario timeout

**What to fix:** het settings-overlay-scenario in `tests/browser-smoke.mjs` (~:741) haalt zijn
completion-expression niet en loopt in de 30s-deadline:

```js
document.getElementById('golens-settings-root')?.dataset.loaded === 'true'
  && ...dataset.ready === 'true'
  && ...shadowRoot?.querySelector('iframe')?.src.endsWith('/settings.html')
```

De HTML-dump bij de timeout laat de overview-fixture zien met
`data-golens-page-skeleton-mounted="true"` en `data-golens-skeleton-remounted="true"`, maar er is
nooit een `#golens-settings-root` aangemaakt. Het scenario stuurt de tab een
`golens-show-settings`-bericht via `chrome.tabs.sendMessage`, dus de verdenking ligt bij de
message-seam (bootstrap.js, ticket 16) of bij de tab-lookup: `sendExtensionTabMessage` zoekt de
tab op exacte URL, en dezelfde fixture doet zelf een `pushState`/`replaceState`-dans
(`?golens-spa-nav=1`) om de skeleton-remount te bewijzen. Een race daartussen is de eerste
hypothese om te toetsen — het bericht kan aankomen terwijl de URL tijdelijk afwijkt, en dan
vindt `chrome.tabs.query` de tab niet en wordt er stil niets afgeleverd.

**Niet veroorzaakt door batch 1.** Een baseline-run op HEAD 9c62a28 (ticket 26, vóór 27–29)
faalt identiek met dezelfde fingerprint. Uitgesloten dat het een stille import-bridge-failure
was: tijdelijke `console.error` in alle `.catch()`-handlers van de bridges gaf nul treffers over
drie runs.

**Blocked by:** geen.

**Status:** proposed

- [ ] Vastgesteld of `golens-show-settings` de tab überhaupt bereikt (log aan beide kanten van de
      seam) — dus: lookup-race of listener die niet reageert
- [ ] Root cause gefixt in productiecode óf in de fixture/harness, met in het ticket vastgelegd
      welk van de twee het was
- [ ] Als het de fixture is: de `pushState`-dans en de tab-lookup ontkoppeld, zodat het scenario
      niet afhangt van timing tussen twee ongerelateerde dingen
- [ ] `npm run test:browser` solo groen, twee keer achter elkaar

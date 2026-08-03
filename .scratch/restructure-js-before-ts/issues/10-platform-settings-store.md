# 10 — platform/settings-store

**What to build:** Alle `chrome.storage`-toegang van `content.js` gaat achter een
`platform/settings-store` (interface ticket 04 §2: `get`/`ready`/`subscribe`/`set`).
Key-eigenaarschap conform ticket 03 §5: `enabled` → lifecycle, `hideGeneratedFiles` →
generated-files, `shortcutBindings`/`shortcutCoachEnabled` → settings-store zelf (seam richting
`settings.js`/`shortcut-settings.js`, die buiten scope blijven). `onChanged`-plumbing en
area/key-layout worden privé; live-propagatie vanuit popup/settings blijft werken.

**Blocked by:** 05 — Bootstrap + page-skelet.

**Status:** resolved — behalve de browser-smoke-verificatie, zie note

- [x] Geen direct `chrome.storage`-gebruik meer in content.js; alles via de store(-bridge)
- [x] Externe writes (popup/settings) propageren live via subscribe, zoals nu
- [ ] Alleen de eigenaar schrijft een key — partieel: alle schrijfacties in content.js gaan nu via
      de ene store-seam, maar content.js's onboarding-save schrijft nog steeds `shortcutBindings`
      (eigendom van settings-store zelf per ticket 03 §5), en `settings.js`/`shortcut-settings.js`
      blijven buiten scope en schrijven die sleutel nog rechtstreeks. Volledige key-ownership is dus
      niet bereikt binnen dit ticket.
- [ ] Volledige `npm run check` groen — niet geverifieerd: `check` keten `test:browser`
      (`tests/browser-smoke.mjs`), dat op deze machine omgevingsbreed kapot is (zie ticket 05's
      environment note). `check:syntax` + `node --test tests/*.test.js` zijn wel groen (194/194).

**Resolution notes:** `page/platform/settings-store.js` (new) implements the ticket 04 §2 interface
(`get`/`ready`/`subscribe`/`set`) with a private schema mapping each key to its `chrome.storage` area
and default (`enabled`/`hideGeneratedFiles`/`shortcutCoachEnabled`/`shortcutBindings` → sync,
`golensOnboardingVersion` → local). `set()` coalesces synchronous same-tick writes to the same area
into one `chrome.storage.<area>.set` call, so content.js's onboarding-save (which sets
`hideGeneratedFiles` and `shortcutBindings` together) still produces exactly one combined write, as
the existing `content-onboarding.test.js` asserts (`savedSettings.length === 1`) — that test was not
modified and stayed green. `content.js` still runs as a classic content script (not an ES module per
`manifest.json`), so it loads the store via dynamic `import()`: `chrome.runtime.getURL(...)` first
(matching `bootstrap.js`'s validated ticket-04-§7 pattern, production path), with a relative-path
fallback so `node --test` can resolve the real module without editing other tests' `chrome.runtime.
getURL` mocks. All `chrome.storage` call sites (onboarding version, onboarding save, `enabled`
persist, init load, `onChanged` propagation) now go through the store; the direct `chrome.storage.
onChanged` listener is gone, replaced by three `subscribe()` calls (`enabled`, `hideGeneratedFiles`,
`shortcutBindings`) reproducing the prior propagation behaviour (external writes still flip
`enabled`/reconcile generated files/re-merge shortcut bindings). Both `settingsStore` dereferences
that run on every page load if the dynamic import fails (`showFirstRunOnboarding`'s `get`, `setEnabled`'s
persisted `set`) are now null-guarded so a missing module (e.g. `scripts/package-extension.mjs`'s
known `page/*` gap noted in ticket 05, not owned here) degrades instead of throwing.

New test: `tests/platform-settings-store.test.js` (7 cases) covers defaults, per-key `set`/`get`,
same-tick write coalescing, unknown-key rejection, `subscribe`/`onChanged` fan-out scoped by area and
key, unsubscribe, and idempotent `ready()`. Full suite: 194/194 green (175 baseline + 12 rpc-client +
7 settings-store, from concurrent tickets); `check:syntax` green. One transient failure was observed
mid-session in `tests/platform-rpc-client.test.js` (120s timeout under the full-suite run, from the
other agent's concurrent file writes) — re-ran standalone and it passed 12/12; not a regression from
this ticket.

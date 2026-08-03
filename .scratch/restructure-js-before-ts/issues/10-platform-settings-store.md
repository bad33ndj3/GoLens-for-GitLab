# 10 — platform/settings-store

**What to build:** Alle `chrome.storage`-toegang van `content.js` gaat achter een
`platform/settings-store` (interface ticket 04 §2: `get`/`ready`/`subscribe`/`set`).
Key-eigenaarschap conform ticket 03 §5: `enabled` → lifecycle, `hideGeneratedFiles` →
generated-files, `shortcutBindings`/`shortcutCoachEnabled` → settings-store zelf (seam richting
`settings.js`/`shortcut-settings.js`, die buiten scope blijven). `onChanged`-plumbing en
area/key-layout worden privé; live-propagatie vanuit popup/settings blijft werken.

**Blocked by:** 05 — Bootstrap + page-skelet.

**Status:** ready-for-agent

- [ ] Geen direct `chrome.storage`-gebruik meer in content.js; alles via de store(-bridge)
- [ ] Externe writes (popup/settings) propageren live via subscribe, zoals nu
- [ ] Alleen de eigenaar schrijft een key
- [ ] Volledige `npm run check` groen

# 29 — Platform: toast

**What to build:** `page/platform/toast.js`: de gedeelde toast-shadow-host uit `go-navigation.js`
(`ensureUI`/`toast`/`hideToast`/`isToastShowing`/`showShortcutCoachHint`). `createX(deps)` (ticket
04 §2) — geen deps nodig buiten `document`/`clock` voor de timer, dus `createToast({ clock })`.
Blijft de enige toast-DOM (keyboard-nav.js/bookmarks.js/project-search.js/code-intel.js reiken hem
nu via go-navigation.js's `legacyToast`-capability; na deze ticket via directe injectie).

**Blocked by:** geen.

**Status:** proposed

- [ ] Shadow-DOM/CSS/markup identiek; toast-timers (2600ms bericht, 8000ms shortcut-hint) ongewijzigd
- [ ] `go-navigation.js` gebruikt deze module i.p.v. eigen kopie
- [ ] Unit tests in `tests/platform-toast.test.js`
- [ ] `npm run check:syntax` en `npm test` groen

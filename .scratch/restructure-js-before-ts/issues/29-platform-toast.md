# 29 — Platform: toast

**What to build:** `page/platform/toast.js`: de gedeelde toast-shadow-host uit `go-navigation.js`
(`ensureUI`/`toast`/`hideToast`/`isToastShowing`/`showShortcutCoachHint`). `createX(deps)` (ticket
04 §2) — geen deps nodig buiten `document`/`clock` voor de timer, dus `createToast({ clock })`.
Blijft de enige toast-DOM (keyboard-nav.js/bookmarks.js/project-search.js/code-intel.js reiken hem
nu via go-navigation.js's `legacyToast`-capability; na deze ticket via directe injectie).

**Blocked by:** geen.

**Status:** resolved (commit d295410)

- [x] Shadow-DOM/CSS/markup identiek; toast-timers (2600ms bericht, 8000ms shortcut-hint) ongewijzigd
- [x] `go-navigation.js` gebruikt deze module i.p.v. eigen kopie
- [x] Unit tests in `tests/platform-toast.test.js`
- [x] `npm run check:syntax` en `npm test` groen

## Resolutie

`page/platform/toast.js` aangemaakt; markup/CSS/timers (2600ms bericht, 8000ms shortcut-hint)
verbatim overgenomen. 13 unit tests in `tests/platform-toast.test.js` (globale `setTimeout`
gestubd om de delays te asserten zonder ze uit te zitten).

**Afwijkingen van de ticketletter:**

1. `createToast()` neemt **geen** `clock`. De originelen gebruikten kale `setTimeout`, niet
   go-navigation.js's verwisselbare `clock`; die alsnog doorlussen zou `setClock` nieuw
   invloed geven op toast-timing — een gedragsverandering binnen een lift-and-shift-ticket.
2. keyboard-nav/bookmarks/project-search/code-intel bereiken de toast nog steeds via
   `go-navigation.js`'s `legacyToast`-capability, niet via directe injectie. Directe injectie
   vereist dat die features hun mount-deps van de lifecycle krijgen i.p.v. van
   go-navigation.js — dat is ticket 36/22-werk, niet dit ticket.
3. `isToastShowing()` rapporteert nog steeds de class van een losgekoppelde node (alleen
   `ensureUI` checkt `isConnected`). Quirk bewust behouden en in de test gedocumenteerd i.p.v.
   stilletjes "gefixt".

4. **Nieuw laadvenster tussen IIFE-start en bridge-resolve.** Alle toast-wrappers in
   `go-navigation.js` optional-chainen (`toastSurface?.toast(...)`,
   `toastSurface?.isToastShowing() ?? false`), dus een toast die in dat venster gevraagd wordt
   is een stille no-op en `isToastShowing()` antwoordt `false` waar het origineel `true` zei.
   Bewust: een toast is nooit load-bearing, en gooien zou de navigatie-actie meeslepen die hem
   wilde tonen. `tests/shortcut-coach-ui.test.js` await't daarom `helpers.toastReady`.

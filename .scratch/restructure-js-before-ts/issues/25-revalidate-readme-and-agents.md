# 25 — README en AGENTS hervalideren na de herstructurering

**What to build:** `README.md`, `AGENTS.md` en de docs waar ticket 01 al doorheen ging
(`docs/agents/*`, `domain.md`) kloppen weer met de code zoals die er ná deze operatie uitziet.
Ticket 01 valideerde ze tegen de oude structuur; sindsdien zijn `bootstrap.js`, `page/lifecycle/`,
`page/platform/` en de feature-modules erbij gekomen en zijn `content.js` en `go-navigation.js`
uitgekleed.

**Blocked by:** 22 — draait pas als alle capability-migraties binnen zijn.

**Status:** resolved

- [x] Beschreven bestandslayout in README/AGENTS/`domain.md` komt overeen met de werkelijke boom
      (inclusief `page/`, `bootstrap.js`, en welke bestanden nog legacy zijn)
- [x] Alle genoemde npm-scripts bestaan nog en doen wat er staat (`test`, `test:browser`, `bench`,
      `check`, `check:syntax`, `package`, `release`)
- [x] De dependency-regels uit ticket 03 (feature↛feature, feature↛lifecycle, geen `globalThis`)
      staan ergens waar een volgende bijdrager ze vindt, niet alleen in `.scratch/`
- [x] Elke claim daadwerkelijk geverifieerd tegen de code, niet overgeschreven uit een ticket —
      in deze operatie bleken drie analyse-claims feitelijk onjuist (zie `map.md`)

## Voltooiing (2026-08-04)

### Wat gewijzigd is

- **`AGENTS.md`** — Project Structure herschreven (`bootstrap.js` → `page/main.js` →
  `lifecycle`/`platform`/`features`, met de werkelijke 12 features en 8 platform-services);
  nieuwe sectie **Module Boundaries** met de ticket-03-regels; Runtime & User Workflow's
  manifest-claim, source-fetch-claim en message-seam-claim gecorrigeerd; Coding Style's
  `go-navigation.js`-helft vervangen; Testing Guidelines uitgebreid met de
  `*-internal`/`features-*`/`platform-*` testnaamgeving. 127 regels (grens: 200).
- **`docs/agents/domain.md`** — de "modules liggen plat in de root"-boom vervangen door de
  werkelijke boom met `page/`, plus een alinea over wat er wél in de root hoort te blijven.
- **`README.md`** — géén wijziging nodig. De enige toetsbare claims zijn `npm install`/
  `npm run check` (beide groen) en de shortcut-defaults in §Highlights; die zijn regel voor regel
  vergeleken met `shortcut-settings.js:3-16` en kloppen alle veertien.

### Verificatie van de npm-scripts (checkbox 2 — daadwerkelijk uitgevoerd, niet gelezen)

| Script | Uitkomst |
|---|---|
| `check:syntax` | exit 0 |
| `test` | exit 0 — 508 pass, 0 fail |
| `test:browser` | exit 0 — één run. Per map.md's batch-4-notitie telt dat als gunstig toeval
  zolang ticket 37 openstaat, niet als bevestiging; het script bestaat en doet wat AGENTS.md
  beschrijft, dat is wat deze checkbox vraagt. |
| `bench` | exit 0 op de standaard heap (ticket 24's teardown-fix houdt stand) |
| `package` | exit 0 — `dist/golens-for-gitlab-v0.3.0.zip`, 40 `page/`-entries in de zip |
| `check` | exit 0 (compositie van de eerste drie) |
| `release` | **niet uitgevoerd** — tagt en pusht. Geverifieerd door lezing van
  `scripts/release-extension.mjs`: valideert manifest/package-versiegelijkheid, versieformaat,
  schone worktree en branch `main` vóór het tagt. |

### Bevindingen tijdens verificatie

- **Twee besluiten uit ticket 03 zijn nooit uitgevoerd en door geen ticket geclaimd.** §2's
  hernoeming van de drie worker-bestanden naar `worker/dispatch|index-core|source-cache` (06/07
  trimden alleen surfaces) en §6's "de `globalThis.GoLens*`-contracten verdwijnen"
  (`bookmark-store.js`/`shortcut-settings.js` staan er nog, en `page/main.js:192` +
  `settings.js` leunen erop). Beide staan nu in `AGENTS.md` als *intended end state, not yet
  done* — de docs beschrijven de werkelijke boom, niet het doel.
- **`settings.js` schrijft `shortcutBindings` nog rechtstreeks naar `chrome.storage.sync`**
  (`:80`, `:90`, `:131`), buiten `page/platform/settings-store.js` om. Bevestigt map.md's
  ticket-10-correctie; opgenomen in Module Boundaries als expliciete uitzondering met
  "do not add new writers", niet weggeschreven als opgelost.

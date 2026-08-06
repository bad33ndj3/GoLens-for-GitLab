# Browser Smoke Tests

`tests/browser-smoke.mjs` is a hand-rolled integration test, not a Playwright/Puppeteer suite. It talks
directly to Chrome over the DevTools Protocol (raw WebSocket via `ws`), spawns a fresh headless Chrome
process per `runBrowser(...)` scenario with `--load-extension` pointed at a temp copy of the repo, serves
GitLab-shaped fixture HTML from a local `node:http` mock server, and polls a JS completion expression
against the live page until it's true or a 30s deadline hits. Each scenario's assertions then run against
a captured `document.documentElement.outerHTML` snapshot. `npm run test:browser` runs it; `npm run check`
runs it as part of the full gate.

## Running it locally against the exact CI browser

`CHROME_BIN` picks the browser; without it the script searches for Helium or Google Chrome. CI does not
use either — it downloads a version-pinned "Chrome for Testing" build (see
`CHROME_FOR_TESTING_VERSION` in `.github/workflows/ci.yml`). A local run against Helium or your everyday
Chrome install is not the same browser CI uses, and behavioral differences between them are large enough
to matter (see below). To get a real local repro, download the matching build for your platform from
`https://storage.googleapis.com/chrome-for-testing-public/<version>/<platform>/chrome-<platform>.zip`
(platform list at `https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json`)
and run:

```
CHROME_BIN="/path/to/chrome-for-testing/chrome" CHROME_NO_SANDBOX=1 npm run test:browser
```

## Known environment gotchas

**`requestAnimationFrame` can go silent in headless Chrome.** A tab that isn't actively compositing may
never fire a pending `rAF` callback — a different throttling mechanism than the `setTimeout`/`setInterval`
backgrounding the existing launch flags (`--disable-renderer-backgrounding` etc.) already handle. Any
production code path gated behind `rAF` (e.g. `page/features/code-intel.js`'s hover throttle, via
`page/lifecycle/mr-session.js`'s `requestFrame`) can hang forever in CI as a result. `requestFrame` races
`requestAnimationFrame` against a plain `setTimeout` fallback for exactly this reason — don't reintroduce
a bare `requestAnimationFrame` call on a path a smoke scenario depends on completing.

**A fixture's own SPA-remount simulation can eat a scenario's extension message.** The `overviewURL`
fixture (serving `/group/project/-/merge_requests/44`) runs a scripted `pushState` → `replaceState` dance
shortly after load to exercise `bootstrap.js`'s SPA re-mount path. Any scenario reusing that URL with
`{ extensionMessage: '...' }` can have its one-shot `chrome.tabs.sendMessage` land, ack, and open UI (e.g.
the settings overlay) right as that remount tears down and rebuilds the module graph — silently discarding
what it just opened, with nothing left to ask again. `runBrowserAttempt` resends the extension message
every 500ms until the scenario's completion expression is satisfied for this reason; if you add a new
`extensionMessage`-driven scenario against a fixture with its own remount/reload behavior, make sure it's
covered by that resend loop rather than a single `await sendExtensionTabMessage(...)`.

**The large-diff scenario is sensitive to machine load.** It records the worst observed timer-callback
delay while streaming a synthetic 80-file diff and asserts it stays under 40ms. On a loaded machine
(several Chrome instances spawned back-to-back, as happens running the full suite repeatedly in a row)
this can occasionally time out or exceed the threshold. This is a pre-existing, load-sensitive scenario,
not evidence of a regression — rerun in isolation before concluding a change broke it.

**macOS-only Keychain noise.** `Error parsing certificate: ... Failed parsing key usage` from
`net/cert/internal/trust_store_mac.cc` is Chrome failing to parse an unrelated cert in the local macOS
Keychain at startup. It's harmless log noise (this string doesn't exist on Linux, where CI runs) — don't
chase it as a cause of a scenario failure.

## Debugging a hung or failing scenario

The thrown `Browser scenario timed out` error already includes `stderr` and the last `outerHTML`
snapshot — check the fixture's `data-*` attributes in that snapshot first; each scenario's assertions
name exactly which attribute they expect and why. For anything deeper (console errors, network
failures, exceptions inside the page), enable the relevant CDP domains
(`Runtime.enable`/`Log.enable`/`Network.enable`) and log incoming events in `connectDevTools`'s message
listener in `tests/browser-smoke.mjs` — temporarily; this instrumentation is not meant to ship, since the
suite's whole point is being a fast, dependency-free triage tool.

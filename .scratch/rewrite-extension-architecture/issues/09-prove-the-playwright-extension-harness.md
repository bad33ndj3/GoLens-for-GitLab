# Prove the Playwright extension harness

Type: `prototype`
Status: resolved
Blocked by: 02

## Question

Can a minimal Playwright persistent-context harness reliably build and load the unpacked extension, serve the GitLab fixture, exercise content-to-worker messaging, and replace the custom DevTools WebSocket harness in local and CI environments?

## Answer

Yes. Replace the custom DevTools WebSocket client with a Playwright
persistent-context harness. The throwaway prototype on
`caspers/prototype-playwright-harness` assembles an unpacked MV3 extension,
serves a GitLab-shaped fixture on an ephemeral localhost port, loads the
extension into Chromium, observes a real content-script-to-service-worker
round trip through the page, and discovers the worker through Playwright's
service-worker API.

The corrected harness passed four consecutive agent-driven runs and one
human-driven run. The first attempt also exposed a genuine MV3 constraint:
classic content scripts cannot use top-level `await`; wrapping the message
exchange in an async function fixed the extension rather than requiring a
harness workaround.

For the rewrite, browser acceptance tests must load the validated
`dist/extension/` artifact established by “Design the TypeScript build and
package topology.” Local runs may use `CHROME_BIN` for an installed Chromium.
CI must install the Playwright-managed Chromium build explicitly and run the
same harness after the production build. Page assertions, browser contexts,
extension service workers, traces, and screenshots belong to Playwright; no
raw debugging port discovery, target polling, `Runtime.evaluate`, or direct
WebSocket transport remains.

The prototype proves the replacement mechanism, not behavioural parity. The
switch-over plan must migrate the existing fixture scenarios and assertions
against the observable behaviour contract before deleting
`tests/browser-smoke.mjs` and the `ws` development dependency.

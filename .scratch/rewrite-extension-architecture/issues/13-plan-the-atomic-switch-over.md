# Plan the atomic switch-over and merge-request sequence

Type: `grilling`
Status: resolved
Blocked by: 02, 04, 05, 06, 07, 08, 09, 11, 12

## Question

What ordered, logically reviewable commit sequence builds the replacement beside the legacy runtime, switches every MV3 entry point atomically, resets storage with clear upgrade communication, removes obsolete files and compatibility layers, and provides a safe rollback point plus final acceptance checklist?

## Answer

Use one draft merge request and keep the repository-root legacy extension as
the releaseable runtime until the switch commit. Build the replacement from
`src/` into uncommitted `dist/extension/`; because its stable output names match
the hand-authored manifest, Playwright can load that artifact while the legacy
harness continues loading the repository root. The replacement must never
import, call, or fall back to legacy runtime code. This is parallel validation,
not a hybrid architecture.

### Commit sequence

Keep every commit green for the checks available at that point and use these
imperative subjects and scopes:

1. **Add rewrite build and architecture guardrails** — add locked TypeScript,
   esbuild, Lit, Valibot, and Playwright dependencies; strict `tsconfig.json`;
   the explicit four-entry build and copy/validation scripts; the final source
   directories; and the import-rule test. `npm run build` may produce the new
   artifact, but the manifest, package, release, and legacy browser commands
   still ship and test the repository-root runtime.
2. **Add shared values and user-data adapters** — add `domain.ts`, the typed
   feature catalog, shortcut rules, and validated preference/bookmark/learning
   storage. Add tests through their direct interfaces. Do not activate the new
   storage epoch or alter existing user data yet.
3. **Implement Go Intelligence semantic outcomes** — port the parser-backed
   index behind the accepted public interface, including proof-carrying
   coverage, conservative missing/ambiguous/unsupported outcomes, stable
   pagination, and the existing semantic regression fixtures. Make no semantic
   product improvement.
4. **Implement Go Intelligence cache and worker runtime** — add content-addressed
   storage, immutable snapshot publication, mutation serialization, the clear
   barrier, validated private protocol, cancellation commit point, restart
   recovery, and cache administration. Test protocol and storage privately;
   test behavior through the Go Intelligence interface.
5. **Implement GitLab Host repository contracts** — move commit/ref discovery,
   authenticated same-origin reads, pagination, search coverage, safety limits,
   and self-hosted access behind stable host outcomes. Keep all raw GitLab
   payloads, responses, URLs, and headers private.
6. **Implement GitLab Host page projection** — add supported-review discovery,
   Rapid and legacy adapters, revisioned events/targets, complete idempotent
   projection, explicit actions, fullscreen/native integration, and Lit-owned
   Shadow DOM surfaces. Keep selectors and DOM nodes inside the package.
7. **Implement Review Session orchestration** — add the accepted reducer,
   effect runtime, replace-not-retarget lifecycle, hierarchical cancellation,
   stale-result guards, projection reconciliation, focus confirmation, semantic
   history, cache workflows, bookmarks, celebrations, and terminal teardown.
8. **Compose the rewrite extension entries** — wire `content.ts`, `worker.ts`,
   `popup.ts`, and `settings.ts` only through public package interfaces. Produce
   a complete `dist/extension/` with all four new entry points, static assets,
   checked-in WASM, HTML, CSS, and the authoritative manifest. Add entrypoint
   contract tests; do not change the releaseable root runtime.
9. **Add Playwright rewrite parity coverage** — migrate every scenario from the
   observable-behaviour contract to Playwright against `dist/extension/`,
   including worker messaging, Rapid and legacy diffs, navigation/replacement,
   accessibility, self-host access, cold/warm cache behavior, cancellation, and
   the streamed-diff responsiveness floor. Keep the old browser smoke running
   beside it so missing parity is visible.
10. **Enforce rewrite performance budgets** — compare ten fresh-process legacy
    and rewrite samples in one job, enforce the accepted per-path budgets, and
    retain both machine-readable reports as merge-request evidence. Do not add a
    combined performance score.
11. **Prepare the architecture storage reset** — add the inactive, idempotent
    reset coordinator, the new storage epoch, the required upgrade-notice setup
    step, interrupted-reset coverage, and a Playwright extension-update
    scenario. Bump the onboarding version, but do not trigger the reset before
    the runtime switch.

The head of commit 11 is the **pre-switch rollback checkpoint**. Record its SHA
in the merge-request description. It must pass the legacy release checks, the
complete rewrite checks, the paired performance gate, and artifact validation.
No code after this checkpoint may add capability; it may only switch ownership,
delete legacy material, or correct acceptance failures.

12. **Switch all extension entries to the rewrite** — in one commit, change the
    production check, package, and release paths to the validated
    `dist/extension/`; make the static and dynamic content registrations name
    the built content bundle and stylesheet; make the service worker, popup,
    and settings HTML name their built entry points; bump `manifest.json` and
    `package.json` to the same next minor version; and activate the storage
    epoch. No manifest or HTML reference may still reach a legacy file. Run the
    complete legacy and rewrite checks in this commit.
13. **Remove the legacy runtime and harness** — delete the root JavaScript
    runtime, old CSS/HTML copies replaced by `src/`, compatibility globals,
    superseded implementation-level tests, `tests/browser-smoke.mjs`, raw
    DevTools/WebSocket code, the `ws` dependency, and any transitional command.
    Update README, privacy/security documentation, development instructions,
    packaging allowlists, CI, and release workflow to describe only the rewrite.
    The final tree contains one runtime and one test path.

Do not hide fixes inside the switch or deletion commits. If either exposes a
behavior defect, add the failing contract or Playwright assertion first, fix it
in its owning pre-switch module, rerun both runtimes where applicable, then
repeat the switch/cleanup commit cleanly.

### Reset and upgrade notice

The worker entry owns one serialized, restart-safe reset coordinator. Before any
new entry point reads preferences or opens a Review Session, it asks the worker
to ensure the new storage epoch. When the epoch is absent or an interrupted
reset marker exists, the worker:

1. records `resetting` in local storage;
2. clears extension sync storage;
3. clears Go Intelligence IndexedDB through its public cache administration;
4. clears extension local storage, including old bookmarks and learning state;
5. writes the new epoch and `upgradeNoticePending: true` last.

Every step is idempotent. A worker stop leaves the epoch absent, so the whole
reset safely repeats. Content, popup, and settings show a bounded “Finishing
the GoLens update” state and do not read mixed old/new data while it runs. Add
no legacy record reader or migration adapter.

On the first supported merge request after reset, setup starts with this
required step before keymap/generated-file choices:

> **GoLens was rebuilt**
>
> This update reset your GoLens settings, shortcuts, bookmarks, and cached Go
> source. Your GitLab repositories and GitLab data were not changed.

The primary action is **Continue setup**. Escape or close dismisses it only for
the current page and leaves `upgradeNoticePending` true; the notice returns on
the next supported review. Continuing clears the pending flag and advances to
normal first-run setup. The notice uses the existing accessible modal,
focus-trap, focus-restoration, and reduced-motion contracts.

### Rollback

- Before merge, revert the switch and cleanup commits to the recorded
  pre-switch checkpoint; the legacy manifest/package path is still complete
  there and the new source may remain inert for diagnosis.
- After merge, revert the whole merge request and publish the last known-good
  extension version. Do not attempt to restore reset settings, bookmarks, or
  cache data; the legacy runtime starts from defaults and rebuilds cache safely.
- Keep the last published ZIP and checksum available until the rewritten
  release has passed the post-release smoke. Do not hot-patch only one MV3 entry
  back to legacy code.

### Final acceptance checklist

The merge request is ready only when all of the following are true:

- Every row in the observable-behaviour contract points to retained policy
  evidence, a `node:test` contract, or a Playwright assertion; no row is merely
  marked “covered” without a pointer.
- `npm ci`, parser-vendor regeneration with a clean diff, strict typecheck,
  import rules, all contract/private/entrypoint tests, production build,
  Playwright, paired performance gates, deterministic packaging, ZIP
  verification, and version/tag guardrails pass from a clean checkout.
- Playwright loads only `dist/extension/` and proves all four entry points,
  content-to-worker recovery, GitLab navigation/replacement, disable/re-enable,
  storage reset/notice/setup, accessibility, and cold/warm cache behavior.
- The paired report satisfies every accepted DOM, semantic, cache, heap, query,
  and 40 ms streamed-diff budget with complete/correct workload assertions.
- The final manifest has unchanged permissions and host-access scope, valid CSP
  and web-accessible resources, and no remote code, analytics, repository upload,
  token handling, cross-origin source fetch, or unpinned source read.
- Safe semantic regressions pass: ambiguity and unsupported cases never guess,
  incomplete coverage never proves absence, external test packages stay
  separate, and the single-root-module limitation remains explicit.
- The storage reset is idempotent across an interrupted worker, the required
  notice appears exactly until acknowledged, and no legacy key/schema reader or
  old IndexedDB database remains in production.
- The architecture import test proves the accepted dependency directions; no
  deep cross-package import, cycle, generic utility package, framework, runtime
  chunk, compatibility global, or legacy fallback remains.
- `dist/` is untracked; the validated unpacked tree and deterministic ZIP contain
  only allowlisted runtime assets, no source maps, tests, TypeScript, build
  metadata, or obsolete legacy file.
- README, AGENTS guidance where affected, privacy/security text, user guide,
  screenshots for changed setup, and merge-request description agree with the
  shipped runtime. The description records all checks, paired reports, the
  pre-switch checkpoint SHA, reset impact, rollback command shape, and the
  explicit absence of product/semantic scope additions.
- The final branch head is green. Merge the whole change or revert it as a
  whole; never merge or release a partially switched extension.

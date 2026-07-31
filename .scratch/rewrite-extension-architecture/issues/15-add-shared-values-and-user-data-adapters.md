# Add shared values and user-data adapters

Status: resolved
Blocked by: 14

## Acceptance criteria

- Add validated immutable repository, commit, path, and Source identity values.
- Add synchronized enablement, generated-file, shortcut-coach, and shortcut preferences.
- Add privacy-safe local bookmarks, onboarding, learning, and celebration state.
- Add presets, editable bindings, duplicate handling, platform matching, and blocked input contexts.
- Add one typed feature catalog with unique entries, setup subset, and guide chapters.
- Test malformed stored data through public interfaces and fall back safely.
- Do not activate the storage reset or migration yet.

## Answer

Added dependency-free validated source identity values, typed feature and shortcut catalogs, and validated sync/local user-storage adapters. Direct contract tests cover malformed data, preference synchronization, shortcut behavior, privacy-safe bookmarks, and write-before-delete recovery. The new adapters remain inert until later composition tickets wire them into the extension; no reset or migration is active.

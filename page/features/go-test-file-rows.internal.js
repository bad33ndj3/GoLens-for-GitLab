// page/features/go-test-file-rows.internal.js — pure decision core for
// page/features/go-test-file-rows.js. No DOM, no chrome.*, no timers.
//
// normalizeRepositoryPath is a deliberate duplicate of
// generated-files.internal.js's copy of the same function — same rationale
// as that module's own header comment: a one-line, unlikely-to-drift pure
// helper isn't worth a shared platform module for two features' sake.

// normalizeRepositoryPath(path) -> path with bidi marks stripped, trimmed,
// internal whitespace around slashes collapsed, and no leading/trailing
// slash. Total: never throws, treats a missing path as ''.
export function normalizeRepositoryPath(path) {
  return (path || '')
    .replace(/[‎‏‪-‮⁦-⁩]/g, '')
    .trim()
    .replace(/\s*\/\s*/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

// isGoTestFileRow(labels) -> true when any of a file-tree row's candidate
// labels (title/aria-label/text content) normalizes to a `_test.go` path.
// Total.
export function isGoTestFileRow(labels) {
  return (labels || []).some((label) => normalizeRepositoryPath(label).endsWith('_test.go'));
}

// shouldMarkGoTestFileRows({ enabled, isDiffPage }) -> the top-level gate
// content.js's reconcileGoTestFileRows used to open with. Total.
export function shouldMarkGoTestFileRows({ enabled, isDiffPage }) {
  return Boolean(enabled && isDiffPage);
}

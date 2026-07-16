# Privacy Policy

Effective: July 16, 2026

GoLens for GitLab processes repository information locally in your browser. It
does not send repository content, usage data, or personal information to the
GoLens developer or to analytics, advertising, or other third-party services.

## Information the extension accesses

On a supported GitLab merge-request page, GoLens reads page context and uses
your existing signed-in GitLab session to request repository paths, commit and
blob identifiers, and source files needed for Go navigation. Those requests go
only to the GitLab origin open in the current tab. The broad HTTP(S) host
permission exists so the extension can support both GitLab.com and self-hosted
GitLab instances.

## Information stored in your browser

GoLens stores:

- The global enabled preference in `chrome.storage.sync`. Your browser vendor
  may synchronize this value between signed-in browser profiles under its own
  privacy policy.
- The completed onboarding version in `chrome.storage.local`.
- Commit-pinned source snapshots and semantic-cache metadata in extension
  IndexedDB storage. This can include GitLab origins, project and package
  paths, merge-request identifiers, commit and blob identifiers, file paths,
  source contents, cache sizes, and timestamps.

Cached source remains in the browser profile until you clear it from the GoLens
popup, remove the extension, or clear the extension's browser data. Disabling
GoLens does not clear the cache.

## Sharing and remote processing

GoLens has no developer-operated backend, telemetry, remote analytics, or
advertising integration. It does not sell or share data. Repository requests
are made directly between your browser and the GitLab instance you are using;
that GitLab instance processes them under its own policies.

## Security

Cached repository source is protected by the security of your browser profile,
device, and operating system. Anyone with access to that profile or its local
data may be able to access the cache. See [SECURITY.md](SECURITY.md) for private
vulnerability reporting.

## Changes and questions

Material changes to this policy will be documented in this repository. For
privacy questions, open an issue in the
[GoLens for GitLab repository](https://github.com/bad33ndj3/GoLens-for-GitLab/issues).

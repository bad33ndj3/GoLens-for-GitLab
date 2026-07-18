# GoLens for GitLab™

> This extension is not affiliated, endorsed, sponsored, or approved with or by GitLab Inc.
>
> GITLAB is a trademark of GitLab Inc. in the United States and other countries and regions

<p align="center">
  <strong>A calmer, Go-aware code review experience for GitLab.</strong><br>
  Navigate symbols, find interface implementations, and focus on the diff—without sending repository code anywhere.
</p>

![GoLens racing through a merge-request diff](assets/golens-banner.png)

GoLens for GitLab is a dependency-light Manifest V3 extension for GitLab.com and self-hosted GitLab. It reads source through your signed-in GitLab session and runs its Go intelligence entirely inside the browser.

## Highlights

- Hover Go identifiers for signatures and documentation.
- `Cmd/Ctrl`-click to find definitions, usages, and interface implementations.
- Plain-click a Go identifier to highlight its loaded-diff occurrences, then move between occurrences, hunks, and files with configurable shortcuts.
- Go back and forward through in-diff semantic jumps without leaving the merge request.
- Enter review focus to hide GitLab chrome and give the diff more room.
- Cache related packages—or the full project—for broader navigation.
- Let the mascot mark review focus, a completed cache pitstop, the final resolved discussion, confirmed approvals and merges, plus an extra-long Friday-after-16:00 beer-kart lap with confetti.
- Keep source local, same-origin, and pinned to the merge-request commit.

## In action

### Hover and jump to definitions

![GoLens showing Go documentation and a definition target in a GitLab diff](assets/screenshots/go-definition.png)

### Find usages without leaving the diff

![GoLens finding Go symbol usages in a GitLab diff](assets/screenshots/go-usages.png)

## Install

1. Clone this repository.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Choose **Load unpacked** and select the repository folder.
4. Refresh a GitLab.com merge-request Changes page.

The three-button control appears beside GitLab's AI-panel button. For a self-hosted instance, open the popup and approve that exact HTTP(S) origin first, then refresh its merge-request page. Use the popup to manage approved origins, enable GoLens globally, cache a full project, clear cached source, or replay the quick tour.

## Development

```sh
npm install
npm run check
```

The extension deliberately favors safe, browser-native Go navigation over speculative results: missing or ambiguous symbols do not navigate.

## Legal

GoLens is available under the [MIT License](LICENSE). See the
[privacy policy](PRIVACY.md), [security policy](SECURITY.md), and
[third-party notices](THIRD_PARTY_NOTICES.md) for more information.

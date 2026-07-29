# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`
- **Read an issue**: `gh issue view <number> --comments`, including labels.
- **List issues**: `gh issue list` with the appropriate state and label filters.
- **Comment / label / close**: use `gh issue comment`, `gh issue edit`, and `gh issue close`.

Infer the repository from `git remote -v`; `gh` does this automatically in this clone.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

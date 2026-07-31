# GoLens for GitLab

GoLens is a browser extension that adds safe, commit-pinned Go code intelligence to GitLab merge-request diffs.

## Language

**Review Session**:
The period in which GoLens is attached to one supported GitLab merge-request review. A Review Session ends when that review is left, replaced, disabled, or otherwise becomes unusable.
_Avoid_: page session, GoLens session

**Source identity**:
The immutable pair of a repository identity and commit SHA against which source and semantic knowledge are valid.
_Avoid_: project ref, current branch

**GitLab Host**:
The supported GitLab environment for a Review Session, including its observable review state, user intentions, and authenticated commit-pinned repository data.
_Avoid_: GitLab page, DOM layer

**Host revision**:
An opaque, monotonically increasing version of the rendered GitLab environment within one Review Session. A location observed at one host revision cannot be used to act on another.
_Avoid_: DOM revision, page version

**Diff target**:
A revision-bound location in the rendered merge-request diff with a normalized repository path, old/new side, source identity, line, and optional column. It denotes a user-visible review location without exposing GitLab DOM details.
_Avoid_: DOM target, line element

**Go Intelligence**:
Commit-pinned knowledge derived from Go source, including the proven coverage within which a semantic outcome is valid.
_Avoid_: language server, semantic worker

**Coverage**:
The explicit set and completeness of commit-pinned Go source from which a semantic outcome was derived. Coverage determines where absence can and cannot be claimed.
_Avoid_: cache scope, search scope

**Semantic snapshot**:
An immutable, revisioned view of Go Intelligence for one source identity and its proven coverage. A query observes exactly one semantic snapshot.
_Avoid_: index state, worker state

**Full type body**:
The complete source representation of a named multiline `struct` or `interface`, from its `type` declaration through the matching closing brace. It is distinct from a type signature, which is only the declaration headline.
_Avoid_: full signature, type snippet

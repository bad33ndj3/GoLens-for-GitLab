# Inventory the observable behaviour contract

Type: `task`
Status: resolved

## Question

What complete, evidence-backed catalogue of current user-visible behaviour, accessibility, storage, permissions, GitLab compatibility, safe semantic outcomes, packaging, and operational checks must define the rewrite's parity floor?

## Answer

The rewrite's parity floor is the
[Observable GoLens behaviour contract](../assets/observable-behaviour-contract.md).
It catalogues the current extension's observable outcomes and safety properties
across activation and page lifecycle, review and diff UI, Go inspection and
navigation, safe semantic outcomes, GitLab compatibility, bookmarks,
accessibility, settings and onboarding, storage and privacy, permissions,
packaging, CI, and release operations.

The catalogue treats implementation details as replaceable, but requires every
contract row to be retained, explicitly superseded, or approved as an
intentional product change. It also defines how the migration specification
must translate the catalogue into executable parity evidence.

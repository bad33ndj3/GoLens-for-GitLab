# Design the TypeScript build and package topology

Type: `grilling`
Status: resolved
Blocked by: 01

## Question

What exact TypeScript, esbuild, manifest, asset, source-map, development, packaging, and release topology produces reproducible uncommitted `dist/` artifacts while keeping every MV3 entry point explicit and framework-independent?

## Answer

Use a minimal TypeScript and esbuild toolchain with one canonical unpacked
artifact at `dist/extension/` and a deterministic release archive beside it at
`dist/golens-for-gitlab-v<manifest.version>.zip`. Browser tests and manual
testing load `dist/extension/`; packaging zips exactly that validated tree, so
the runtime bytes tested in production mode are the bytes released.

Keep `manifest.json` hand-authored and authoritative for extension metadata and
the release version. Keep `package.json` and the lockfile at the same version,
and fail validation on any mismatch. Use stable output names and four explicit
MV3 entry points:

- `content.ts` builds as the classic-IIFE `content.js`, used by both static and
  dynamically registered content scripts.
- `worker.ts` builds as the ESM `worker.js` service worker.
- `popup.ts` builds as the ESM `popup.js` extension popup.
- `settings.ts` builds as the ESM `settings.js` settings surface.

Disable code splitting so each entry point is self-contained. Accept modest
duplication instead of introducing shared runtime chunks. Target conservative
`es2020`, leave `minimum_chrome_version` absent to preserve current installation
compatibility, enable tree-shaking, and do not minify production bundles.

Use one strict `tsconfig.json`; `tsc --noEmit` is the type gate and esbuild alone
transpiles and bundles. Keep build and release tooling as directly runnable
`.mjs` files so the toolchain does not need to compile its own configuration.

Keep authored files in explicit source locations: TypeScript, HTML, and CSS in
`src/`; artwork in `assets/`; checked-in parser binaries in `vendor/`; and the
manifest and legal notices at the repository root. A declared copy map places
each static file in `dist/extension/`; there is no catch-all public directory.
Bundle the locked `web-tree-sitter` JavaScript dependency into `worker.js` and
ship only the two required checked-in WASM binaries as parser runtime assets.
The vendor-refresh command regenerates and verifies those binaries.

`npm run dev` watches and maintains `dist/extension/`, including copied assets,
with external source maps. It adds no reload client, HMR mechanism, or dev-only
extension permission; developers reload the unpacked extension and GitLab page.
Production and release builds contain no source maps.

Expose this command contract:

- `npm run dev`: watched development build.
- `npm run typecheck`: strict `tsc --noEmit`.
- `npm run build`: clean production build plus artifact validation.
- `npm run check`: typecheck, unit tests, production build, then browser tests
  against that build.
- `npm run package`: production build plus deterministic ZIP.
- `npm run release`: verify a clean, pushed `main` commit and create the
  annotated version tag; it does not upload a local artifact.

Production builds assemble and validate a temporary sibling directory, then
replace `dist/extension/` only after success. A failure leaves the last valid
artifact intact. Watch mode may update in place for speed but retains the last
successful output and reports subsequent errors.

Artifact validation must prove that every manifest and HTML reference exists,
static and dynamic content-script registrations name the same built JS and CSS,
only allowlisted runtime files ship, no TypeScript, tests, source maps, or build
metadata enter production, and `manifest.json` is at the ZIP root. ZIP entries
are sorted and have normalized timestamps and permissions. Use a small locked
development-only Node ZIP dependency rather than the platform `zip` command so
the same source and lockfile produce byte-identical archives.

The local release command only pushes the tag. The tag-triggered GitHub workflow
runs `npm ci`, the full checks, a clean production build, and reproducibility
verification before publishing the ZIP and its SHA-256 checksum. No locally
built artifact is uploaded.

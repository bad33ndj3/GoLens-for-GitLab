# Security Policy

## Supported versions

Security fixes are made for the latest released version of GoLens for GitLab.
Install the newest release before reporting an issue that may already have been
resolved.

## Reporting a vulnerability

Do not disclose a suspected vulnerability in a public issue. Use GitHub's
[private vulnerability reporting](https://github.com/bad33ndj3/GoLens-for-GitLab/security/advisories/new)
to share the report with the maintainer. If that channel is unavailable, email
`casper.spruit@gmail.com` with the subject `GoLens security report`.

Include, when possible:

- The affected GoLens and browser versions.
- The GitLab environment involved, without credentials, tokens, private source,
  or other sensitive repository information.
- Reproduction steps and the security impact.
- Any proof of concept, logs, or suggested remediation that can be shared
  safely.

Please allow time to investigate and coordinate a fix before public disclosure.
The maintainer will acknowledge the report and provide status updates as soon
as practical.

## Security boundaries

GoLens intentionally keeps semantic processing inside the extension, requests
repository data only from the GitLab origin in the active tab, and pins source
navigation to commits. Reports about cross-origin data access, permission abuse,
cache exposure, unsafe navigation, or bypasses of those boundaries are
especially useful.

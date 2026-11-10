# Security policy

## Supported versions

Security fixes target the current source on `main` and the latest npm release. Older mirror releases are not maintained separately.

The mirror installer and publishing scripts belong to this repository. Vulnerabilities in upstream plugin content should also be reported to [michael-denyer/pstack-claude](https://github.com/michael-denyer/pstack-claude).

## Report a vulnerability

Do not publish credentials, exploit details, or private file contents in a public issue.

Use GitHub's **Report a vulnerability** option on this repository's Security page if it is available. If private reporting is unavailable, open an issue requesting a private contact channel without describing the vulnerability. Wait for a maintainer to provide that channel before sharing details.

Include the affected package version, Node.js version, operating system, target CLI version, reproduction steps using disposable data, and expected impact. Remove tokens and private paths from logs.

## Publish safely

Keep npm credentials out of pull-request checks. Restrict a publishing token to the mirror package after the first publication, or configure npm trusted publishing.

The license check detects changes in supported upstream metadata. It is not a security audit of upstream code. Review upstream changes and provenance before trusting a release.

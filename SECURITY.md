# Security policy

## Supported versions

Only the latest release of `homebridge-ring-secure-video` on npm gets security fixes. Please update to it before reporting.

## Reporting a vulnerability

Please don't open a public issue. Report it privately on GitHub instead: the repository's
**Security** tab, then **Report a vulnerability**
(<https://github.com/zmanuel1234/homebridge-ring-secure-video/security/advisories/new>).

Say which version you use, what an attacker could do, and how to reproduce it. I aim to answer
within a week. A fix comes out as a new release, with a GitHub security advisory that credits you
unless you'd rather not be named.

## Scope

In scope: this plugin's code, its packaging and its release workflow. Out of scope: Homebridge
itself, Ring's cloud and the devices themselves. Please report those to their makers.

## How releases are made

Releases are built and published to npm by this repository's GitHub workflow
(`.github/workflows/publish.yml`), with npm trusted publishing: no npm token is stored anywhere.
Versions published this way carry a signed provenance statement on npm that links them to the
workflow run and commit they were built from.

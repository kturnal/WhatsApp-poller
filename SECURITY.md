# Security Policy

## Supported versions

This project currently supports the latest code on the default branch.

## Reporting a vulnerability

Please do not open public issues for sensitive vulnerabilities.

Report security issues by contacting the maintainer privately and include:

- Summary and impact
- Affected versions/commit
- Reproduction steps
- Suggested remediation (if available)

We will acknowledge reports as quickly as possible and coordinate disclosure once a fix is available.

## Security baseline

- Chromium sandbox is enabled by default.
- Runtime data permissions are hardened (`0700` dirs, `0600` files).
- Sensitive identifiers are redacted in logs by default.
- CI includes dependency audit, secret scanning, and CodeQL analysis.

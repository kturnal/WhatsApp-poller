# Security Policy

## Supported versions

This project currently supports the latest code on the default branch.

## Reporting a vulnerability

Please do not open public issues for sensitive vulnerabilities.

Report security issues using GitHub private vulnerability reporting:

- https://github.com/kturnal/WhatsApp-poller/security/advisories/new

Expected response time:

- Initial acknowledgement within 3 business days
- Ongoing updates until remediation and disclosure plan are agreed

Please include:

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

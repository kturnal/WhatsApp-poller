# Contributing

Thanks for contributing to `whatsapp-poller`.

## Prerequisites

- Node.js 20+
- npm

## Local setup

```bash
npm install
cp .env.example .env
npm run doctor
```

## Development workflow

1. Create a branch from `main`.
2. Implement changes with tests.
3. Run checks locally:

```bash
npm run lint
npm run format:check
npm run test
npm run test:integration
npm run security:audit
```

4. Open a pull request using the template.

## Commit conventions

Releases are created automatically with `release-please`, so use Conventional
Commit prefixes in PR commits:

- `feat:` for new features
- `fix:` for bug fixes
- `feat!:` or `BREAKING CHANGE:` for major/breaking changes
- `docs:`, `chore:`, `test:`, `refactor:` for non-release-impacting changes

## Pull request expectations

- Keep scope focused.
- Include tests for behavior changes.
- Update docs when configuration or runtime behavior changes (`.env.example` is the canonical env reference).
- Do not commit secrets, `.env`, or session/database files.

## Reporting bugs

Use the bug report issue template and include:

- Repro steps
- Expected vs actual behavior
- Logs (redacted)
- Environment details (Node version, OS)

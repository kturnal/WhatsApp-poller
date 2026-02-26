# Contributing

Thanks for contributing to `whatsapp-poller`.

## Prerequisites

- Node.js 18+
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

## Pull request expectations

- Keep scope focused.
- Include tests for behavior changes.
- Update docs when configuration or runtime behavior changes.
- Do not commit secrets, `.env`, or session/database files.

## Reporting bugs

Use the bug report issue template and include:

- Repro steps
- Expected vs actual behavior
- Logs (redacted)
- Environment details (Node version, OS)

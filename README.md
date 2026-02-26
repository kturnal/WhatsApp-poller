# WhatsApp Poller Bot

[![CI](https://github.com/kturnal/WhatsApp-poller/actions/workflows/ci.yml/badge.svg)](https://github.com/kturnal/WhatsApp-poller/actions/workflows/ci.yml)
[![Security](https://github.com/kturnal/WhatsApp-poller/actions/workflows/security.yml/badge.svg)](https://github.com/kturnal/WhatsApp-poller/actions/workflows/security.yml)

Single-group WhatsApp bot that creates a weekly poll for game-night planning.

## What it does

- Creates one weekly poll in a target group (`POLL_CRON`, default Monday 12:00).
- Uses fixed slot options:
  - Weekdays: Mon-Fri 20:00
  - Weekends: Sat/Sun 10:00, 15:00, 20:00
- Accepts multi-choice voting from an allowlist.
- Closes poll when either:
  - `REQUIRED_VOTERS` unique allowlisted voters have voted, or
  - `POLL_CLOSE_HOURS` has elapsed.
- Announces winner in group.
- Handles ties:
  - Owner can resolve via `!schedule pick <option_number>` within `TIE_OVERRIDE_HOURS`.
  - If no owner action, earliest tied option wins automatically.

## Requirements

- Node.js 20+
- npm
- A WhatsApp account available for QR login

## 15-minute quickstart

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create local config file:

   ```bash
   cp .env.example .env
   ```

3. Fill required fields in `.env`:
   - `GROUP_ID`: target WhatsApp group JID ending with `@g.us`
   - `OWNER_PHONE`: owner phone number (digits, with country code)
   - `ALLOWED_VOTERS`: comma-separated list of eligible voter numbers

4. Validate setup before starting:

   ```bash
   npm run doctor
   ```

5. Start the bot:

   ```bash
   npm start
   ```

6. Scan QR code from WhatsApp mobile app on first run.

7. In group chat, verify command handling:

   ```text
   !schedule status
   ```

## How to get `GROUP_ID`

Use one of these methods:

1. From WhatsApp Web URL:
   - Open the target group in WhatsApp Web.
   - In browser URL/query payloads you can find the group JID ending with `@g.us`.
2. From app logs/debugging:
   - Temporarily instrument your setup to print chat IDs from WhatsApp client and copy the group one.

`GROUP_ID` must look like `1234567890-123456789@g.us`.

## Commands

- `!schedule help`
- `!schedule status`
- `!schedule pick <option_number>` (owner-only, tie-only)

## Security defaults

- Chromium sandbox is enabled by default.
- Runtime data directory permissions are hardened at startup (`0700` dirs, `0600` files).
- Sensitive IDs (phone/JID-like values) are redacted from logs by default.
- Insecure Chromium mode is opt-in only (`ALLOW_INSECURE_CHROMIUM=true`).

## Configuration

See `.env.example` for the complete list. Most relevant settings:

- `POLL_CRON` - weekly schedule cron
- `TIMEZONE` - timezone used for scheduling and display
- `POLL_CLOSE_HOURS` - auto-close timeout
- `REQUIRED_VOTERS` - quorum threshold
- `ALLOW_INSECURE_CHROMIUM` - disable Chromium sandbox (not recommended)
- `COMMAND_RATE_LIMIT_COUNT`, `COMMAND_RATE_LIMIT_WINDOW_MS` - anti-flood controls
- `COMMAND_MAX_LENGTH` - max accepted command payload length

## Development

```bash
npm run lint
npm run test
npm run test:integration
npm run security:audit
```

## Troubleshooting

- `Authentication failure`:
  - Remove local session under `data/session` and restart, then rescan QR.
- `GROUP_ID must be ... @g.us`:
  - Ensure group JID format is correct and complete.
- `doctor` fails on env values:
  - Fix invalid/missing values exactly as reported.
- Bot runs but commands do not respond:
  - Confirm command is sent in the configured group and starts with `COMMAND_PREFIX`.

## Data and persistence

- SQLite DB and WhatsApp session files are stored under `DATA_DIR` (default `./data`).
- This directory should stay private and persistent across restarts.

## License

MIT

# WhatsApp Poller Bot

[![CI](https://github.com/kturnal/WhatsApp-poller/actions/workflows/ci.yml/badge.svg)](https://github.com/kturnal/WhatsApp-poller/actions/workflows/ci.yml)
[![Security](https://github.com/kturnal/WhatsApp-poller/actions/workflows/security.yml/badge.svg)](https://github.com/kturnal/WhatsApp-poller/actions/workflows/security.yml)
[![Release](https://github.com/kturnal/WhatsApp-poller/actions/workflows/release.yml/badge.svg)](https://github.com/kturnal/WhatsApp-poller/actions/workflows/release.yml)

Single-group WhatsApp bot that creates a weekly poll for game-night planning.

## What it does

- Creates one weekly poll in a target group.
  - Default startup mode (`WEEK_SELECTION_MODE=interactive`) asks which ISO week to run (for example `2026 W10 March 2 - March 8`).
  - Optional auto mode (`WEEK_SELECTION_MODE=auto`) uses `POLL_CRON` for both scheduled creation and startup catch-up.
  - `POLL_CRON` must be a fixed weekly schedule with a single day-of-week and fixed hour/minute (for example `0 12 * * 1` or `30 18 * * FRI`).
- Uses default slot options (customizable via env/file):
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

## Setup paths

Choose one setup path up front. Both start with the same first-run prep:

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create local config file:

   ```bash
   cp .env.example .env
   ```

3. Discover candidate group IDs by authenticating once with WhatsApp:

   ```bash
   npm run discover:groups
   ```

4. Fill required fields in `.env`:
   - `GROUP_ID`: copy the target group JID printed by the discovery helper
   - `OWNER_PHONE`: owner phone number (digits, with country code)
   - `ALLOWED_VOTERS`: comma-separated list of eligible voter numbers

### Path 1: Local interactive use

Use this when you start the bot manually in a terminal and want to choose the week at startup.

1. Keep `WEEK_SELECTION_MODE=interactive`.
2. Leave `TARGET_WEEK` empty unless you want to preselect a specific week.
3. Validate setup:

   ```bash
   npm run doctor
   ```

4. Start the bot:

   ```bash
   npm start
   ```

5. Scan the QR code from the WhatsApp mobile app on first run.
6. Enter the target ISO week in the terminal prompt.
7. In group chat, verify command handling:

   ```text
   !schedule status
   ```

### Path 2: Always-on deployment (recommended)

Use this for Docker, VPS, or home-server deployments that must survive restarts without a terminal attached.

1. Set `WEEK_SELECTION_MODE=auto` for unattended weekly operation.
   - If you intentionally keep `WEEK_SELECTION_MODE=interactive`, also set `TARGET_WEEK=YYYY-Www` so non-TTY restarts do not fail.
2. Validate setup and resolve any unattended-startup warnings:

   ```bash
   npm run doctor
   ```

3. Start the container in detached mode:

   ```bash
   docker compose up -d --build
   ```

### Why always-on

- Always-on hosting is the recommended production mode for weekly polls.
- Quorum-based closure depends on live `vote_update` events while the bot is connected.
- Running on a VPS/home server avoids missed activity when a personal laptop is offline.

### Docker Compose setup

After completing setup path 2, keep Docker volume persistence aligned with `DATA_DIR`. By default this repo uses `./data:/app/data`. If you change `DATA_DIR`, map that exact path into `/app/data` without prefixing it with `./` because `DATA_DIR` may already be absolute (for example, `${DATA_DIR}:/app/data` or `/var/lib/poller:/app/data`).

- Persistent `/app/data` stores:
  - WhatsApp session (`/app/data/session`)
  - SQLite poll state (`/app/data/polls.sqlite`)

### First-time QR login

1. Tail container logs:

   ```bash
   docker compose logs -f whatsapp-poller
   ```

2. Scan the QR code once from the WhatsApp mobile app.
3. Session credentials are saved under `./data/session` and reused on restarts.

### Restart behavior

- `restart: unless-stopped` restarts the service after container/host restarts unless manually stopped.
- On startup, the bot reads SQLite state and recovers pending close/tie timers.
- Weekly poll close/announce flow continues after restart as long as `./data` persists.

### Backup and recovery

- Back up `./data` regularly (it contains session + poll database state).
- Recovery flow:
  1. Stop the service (`docker compose down`).
  2. Restore `./data` from backup.
  3. Start again (`docker compose up -d`).

### Health checks, metrics, and logging basics

- Check container status:

  ```bash
  docker compose ps
  ```

- Follow logs:

  ```bash
  docker compose logs -f whatsapp-poller
  ```

- Healthy operation logs typically include:
  - client ready signal
  - weekly cron scheduled message (auto mode)
  - poll lifecycle events (created, closed, tie handling, winner announced)

- Optional health/metrics HTTP server:
  - Set `HEALTH_SERVER_PORT` in `.env` (for example `HEALTH_SERVER_PORT=8080`).
  - Exposes:
    - `GET /health/live`
    - `GET /health/ready`
    - `GET /metrics` (Prometheus text format)
  - When running in Docker, publish the same port in `docker-compose.yml` (for example `ports: ["8080:8080"]`).

- Example checks:

  ```bash
  curl -sS http://localhost:8080/health/live
  curl -sS http://localhost:8080/health/ready
  curl -sS http://localhost:8080/metrics
  ```

- Exposed metric names (stable):
  - `whatsapp_poller_polls_created_total`
  - `whatsapp_poller_polls_closed_total`
  - `whatsapp_poller_poll_closes_quorum_total`
  - `whatsapp_poller_poll_tie_flows_total`
  - `whatsapp_poller_outbox_send_failures_total`
  - `whatsapp_poller_outbox_send_retries_total`
  - `whatsapp_poller_client_disconnects_total`
  - `whatsapp_poller_client_reconnects_total`
  - `whatsapp_poller_process_healthy`
  - `whatsapp_poller_whatsapp_ready`
  - `whatsapp_poller_startup_complete`
  - `whatsapp_poller_ready`
  - `whatsapp_poller_active_polls`
  - `whatsapp_poller_outbox_retryable_messages`
  - `process_start_time_seconds`
  - `process_uptime_seconds`

## How to discover `GROUP_ID`

Preferred method:

```bash
npm run discover:groups
```

- The helper authenticates with WhatsApp Web, prints the QR code when needed, and lists your available groups with copyable `GROUP_ID=...` lines.
- Copy the correct group JID into `.env`.

Fallback method:

1. Open the target group in WhatsApp Web.
2. Inspect the browser URL/query payloads to find the JID ending with `@g.us`.

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

`.env.example` is the canonical configuration reference for all runtime environment variables, including defaults, valid values, constraints, and examples.

- Copy `.env.example` to `.env` and change required values (`GROUP_ID`, `OWNER_PHONE`, `ALLOWED_VOTERS`).
- Use `npm run doctor` after edits to validate your configuration before startup.

## Development

```bash
npm run lint
npm run test
npm run test:integration
npm run security:audit
```

## Releases

- Releases are automated with `release-please` on every push to `main`/`master`.
- Merged commits are parsed with Conventional Commits and grouped into a release PR.
- When the release PR is merged, automation updates:
  - `package.json` version
  - `CHANGELOG.md`
  - git tag (`vX.Y.Z`)
  - GitHub Release notes
- Recommended commit prefixes:
  - `feat:` for new features (minor bump)
  - `fix:` for bug fixes (patch bump)
  - `feat!:` or `BREAKING CHANGE:` for major bump

## Troubleshooting

- `Authentication failure`:
  - Remove local session under `data/session` and restart, then rescan QR.
- `GROUP_ID must be ... @g.us`:
  - Ensure group JID format is correct and complete.
- `doctor` fails on env values:
  - Fix invalid/missing values exactly as reported.
- Bot runs but commands do not respond:
  - Confirm command is sent in the configured group and starts with `COMMAND_PREFIX`.
- Poll quorum changed while bot was offline:
  - Restart the bot to trigger startup vote reconciliation from current WhatsApp poll state.

## Data and persistence

- SQLite DB and WhatsApp session files are stored under `DATA_DIR` (default `./data`).
- This directory should stay private and persistent across restarts.

## License

MIT

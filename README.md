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

## Always-on deployment (recommended)

### Why always-on

- Always-on hosting is the recommended production mode for weekly polls.
- Quorum-based closure depends on live `vote_update` events while the bot is connected.
- Running on a VPS/home server avoids missed activity when a personal laptop is offline.

### Docker Compose setup

1. Copy the example environment file:

   ```bash
   cp .env.example .env
   ```

2. Fill required values in `.env` (`GROUP_ID`, `OWNER_PHONE`, `ALLOWED_VOTERS`).

3. Start the container in detached mode:

   ```bash
   docker compose up -d --build
   ```

- Keep Docker volume persistence aligned with `DATA_DIR`. By default this repo uses
  `./data:/app/data`. If you change `DATA_DIR` from its default value, update the
  Compose host-path mapping to point to the same persistent directory (for example,
  `./${DATA_DIR}:/app/data`).
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
  - weekly cron scheduled message
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
- `HEALTH_SERVER_PORT` - optional HTTP port for `/health/live`, `/health/ready`, `/metrics`

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
- Poll quorum changed while bot was offline:
  - Restart the bot to trigger startup vote reconciliation from current WhatsApp poll state.

## Data and persistence

- SQLite DB and WhatsApp session files are stored under `DATA_DIR` (default `./data`).
- This directory should stay private and persistent across restarts.

## License

MIT

# WhatsApp Poller Bot

Single-group WhatsApp bot that creates a weekly poll for game-night planning.

## Features
- Weekly auto-poll (default: Monday 12:00, Europe/Istanbul)
- Fixed option template:
  - Weekdays: Mon-Fri 20:00
  - Weekends: Sat/Sun 10:00, 15:00, 20:00
- Multi-choice voting
- Poll closes when either:
  - 5 unique allowed voters have voted, or
  - 48 hours pass
- Winner announcement in group (`slot + vote count`)
- Tie handling:
  - Owner can resolve with `!schedule pick <option_number>` within 6 hours
  - If no manual pick, earliest tied slot is auto-selected

## Requirements
- Node.js 22+
- A WhatsApp account session (scan QR on first run)

## Setup
1. Install dependencies:
   ```bash
   npm install
   ```
2. Create env file:
   ```bash
   cp .env.example .env
   ```
3. Fill `.env` values (`GROUP_ID`, `OWNER_PHONE`, `ALLOWED_VOTERS`).
4. Start bot:
   ```bash
   npm start
   ```
5. On first run, scan the QR code shown in terminal.

## Commands
- `!schedule help`
- `!schedule status`
- `!schedule pick <option_number>` (owner-only, tie resolution)

## Notes
- Session and SQLite data are stored under `data/`.
- This project uses Node's built-in `node:sqlite` module (Node 22+).

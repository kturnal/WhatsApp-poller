const path = require('node:path');
const { DateTime } = require('luxon');

function mustReadEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function parseInteger(name, fallback) {
  const raw = process.env[name];
  if (!raw || !raw.trim()) {
    return fallback;
  }

  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) {
    throw new Error(`Environment variable ${name} must be an integer.`);
  }

  return value;
}

function parseBoolean(name, fallback) {
  const raw = process.env[name];
  if (!raw || !raw.trim()) {
    return fallback;
  }

  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  throw new Error(`Environment variable ${name} must be a boolean-like value.`);
}

function normalizeJid(input) {
  if (!input || !input.trim()) {
    throw new Error('Cannot normalize an empty phone/JID value.');
  }

  const value = input.trim().toLowerCase();

  if (value.includes('@')) {
    return value;
  }

  const digits = value.replace(/[^\d]/g, '');
  if (!digits) {
    throw new Error(`Invalid phone value: ${input}`);
  }

  return `${digits}@c.us`;
}

function parseVoterList(rawList) {
  const voters = rawList
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => normalizeJid(item));

  if (voters.length === 0) {
    throw new Error('ALLOWED_VOTERS cannot be empty.');
  }

  const unique = Array.from(new Set(voters));
  if (unique.length !== voters.length) {
    throw new Error('ALLOWED_VOTERS contains duplicate values after normalization.');
  }

  return unique;
}

function validateTimezone(timezone) {
  const candidate = DateTime.now().setZone(timezone);
  if (!candidate.isValid) {
    throw new Error(`Invalid TIMEZONE value: ${timezone}`);
  }
}

function loadConfig() {
  const groupId = mustReadEnv('GROUP_ID');
  if (!groupId.endsWith('@g.us')) {
    throw new Error('GROUP_ID must be a WhatsApp group JID ending with @g.us');
  }

  const ownerJid = normalizeJid(mustReadEnv('OWNER_PHONE'));
  const allowedVoters = parseVoterList(mustReadEnv('ALLOWED_VOTERS'));

  const requiredVoters = parseInteger('REQUIRED_VOTERS', 5);
  if (requiredVoters < 1) {
    throw new Error('REQUIRED_VOTERS must be >= 1.');
  }
  if (requiredVoters > allowedVoters.length) {
    throw new Error('REQUIRED_VOTERS cannot be greater than ALLOWED_VOTERS count.');
  }

  const timezone = process.env.TIMEZONE?.trim() || 'Europe/Istanbul';
  validateTimezone(timezone);

  const pollCloseHours = parseInteger('POLL_CLOSE_HOURS', 48);
  if (pollCloseHours < 1) {
    throw new Error('POLL_CLOSE_HOURS must be >= 1.');
  }

  const tieOverrideHours = parseInteger('TIE_OVERRIDE_HOURS', 6);
  if (tieOverrideHours < 1) {
    throw new Error('TIE_OVERRIDE_HOURS must be >= 1.');
  }

  const pollCron = process.env.POLL_CRON?.trim() || '0 12 * * 1';
  const pollQuestion =
    process.env.POLL_QUESTION?.trim() ||
    'Weekly game night - pick all slots you can join (Europe/Istanbul)';

  const clientId = process.env.CLIENT_ID?.trim() || 'game-scheduler';
  const dataDir = path.resolve(process.cwd(), process.env.DATA_DIR?.trim() || 'data');
  const headless = parseBoolean('HEADLESS', true);

  const commandPrefix = process.env.COMMAND_PREFIX?.trim() || '!schedule';

  return {
    groupId,
    ownerJid,
    allowedVoters,
    allowedVoterSet: new Set(allowedVoters),
    requiredVoters,
    timezone,
    pollCloseHours,
    tieOverrideHours,
    pollCron,
    pollQuestion,
    clientId,
    dataDir,
    headless,
    commandPrefix
  };
}

module.exports = {
  loadConfig,
  normalizeJid
};

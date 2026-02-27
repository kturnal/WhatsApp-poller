const path = require('node:path');
const { DateTime } = require('luxon');

/**
 * Retrieve and validate a required environment variable.
 * @param {string} name - Environment variable key to read.
 * @returns {string} The environment variable's value, trimmed.
 * @throws {Error} If the variable is missing or empty after trimming.
 */
function mustReadEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

/**
 * Parse an environment variable as a base-10 integer or return a fallback.
 * @param {string} name - Environment variable name to read.
 * @param {number} [fallback] - Value to return when the environment variable is missing or empty.
 * @returns {number} The parsed integer value from the environment variable, or the provided fallback.
 * @throws {Error} If the environment variable is present but cannot be parsed as a finite integer.
 */
function parseInteger(name, fallback) {
  const raw = process.env[name];
  if (!raw || !raw.trim()) {
    return fallback;
  }

  const normalized = raw.trim();
  if (!/^-?\d+$/.test(normalized)) {
    throw new Error(`Environment variable ${name} must be an integer.`);
  }

  const value = Number.parseInt(normalized, 10);

  return value;
}

/**
 * Determine whether an environment variable represents a boolean-like value.
 * @param {string} name - Environment variable name to read.
 * @param {boolean} fallback - Value to return when the variable is missing or empty.
 * @returns {boolean} `true` if the variable equals `1`, `true`, `yes`, or `on`; `false` if it equals `0`, `false`, `no`, or `off`.
 * @throws {Error} If the variable is present but not a recognized boolean-like string.
 */
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

/**
 * Normalize a phone number or JID into a WhatsApp contact JID.
 *
 * Trims and lowercases the input, extracts the local part (text before `@` if present),
 * and converts phone-like locals to digits only. Produces a JID using the `@c.us` domain.
 *
 * @param {string} input - Phone number or JID to normalize; may contain punctuation or a domain.
 * @returns {string} The normalized JID in the form `<local>@c.us`.
 * @throws {Error} If `input` is empty or does not yield a valid local part after normalization.
 */
function normalizeJid(input) {
  if (!input || !input.trim()) {
    throw new Error('Cannot normalize an empty phone/JID value.');
  }

  const value = input.trim().toLowerCase();
  const localPart = value.includes('@') ? value.split('@', 1)[0] : value;
  const digits = localPart.replace(/[^\d]/g, '');
  const isPhoneLike = /^[+\d().\-\s]+$/.test(localPart);
  const normalizedLocal = isPhoneLike ? digits : localPart;

  if (!normalizedLocal) {
    throw new Error(`Invalid phone/JID value: ${input}`);
  }

  return `${normalizedLocal}@c.us`;
}

/**
 * Parse a comma-separated list of JIDs or phone identifiers into a deduplicated array of normalized JIDs.
 *
 * @param {string} rawList - Comma-separated values representing JIDs or phone numbers.
 * @returns {string[]} Array of unique, normalized JIDs (each formatted like `<local>@c.us`).
 * @throws {Error} If the parsed list is empty.
 * @throws {Error} If duplicate values exist after normalization.
 */
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

/**
 * Validate that a timezone identifier is valid and supported.
 * @param {string} timezone - Timezone identifier to validate (e.g., "Europe/Istanbul").
 * @throws {Error} If `timezone` is not a valid/recognized timezone identifier.
 */
function validateTimezone(timezone) {
  const candidate = DateTime.now().setZone(timezone);
  if (!candidate.isValid) {
    throw new Error(`Invalid TIMEZONE value: ${timezone}`);
  }
}

/**
 * Load and validate runtime configuration from environment variables.
 *
 * Reads, normalizes, and validates required environment values (group and owner IDs, allowed voters,
 * numeric limits, timezone, scheduling, and I/O settings) and returns a consolidated configuration object.
 *
 * @returns {{groupId: string, ownerJid: string, allowedVoters: string[], allowedVoterSet: Set<string>, requiredVoters: number, timezone: string, pollCloseHours: number, tieOverrideHours: number, pollCron: string, pollQuestion: string, clientId: string, dataDir: string, headless: boolean, commandPrefix: string, allowInsecureChromium: boolean, logRedactSensitive: boolean, logIncludeStack: boolean, commandRateLimitCount: number, commandRateLimitWindowMs: number, commandMaxLength: number, healthServerPort: number|null}} Configuration object containing validated and derived settings:
 * - `groupId`: WhatsApp group JID ending with `@g.us`.
 * - `ownerJid`: Normalized owner JID in the form `<local>@c.us`.
 * - `allowedVoters`: Array of normalized voter JIDs.
 * - `allowedVoterSet`: Set of normalized voter JIDs.
 * - `requiredVoters`: Minimum required voters (>= 1 and <= allowedVoters.length).
 * - `timezone`: Valid IANA timezone string.
 * - `pollCloseHours`: Hours until poll closes (>= 1).
 * - `tieOverrideHours`: Hours after which a tie can be overridden (>= 1).
 * - `pollCron`: Cron expression for scheduled polls.
 * - `pollQuestion`: Default poll question text.
 * - `clientId`: Identifier for the client.
 * - `dataDir`: Absolute path to the data directory.
 * - `headless`: Whether client runs headless (`true` or `false`).
 * - `commandPrefix`: Prefix for commands.
 * - `allowInsecureChromium`: Allows Chromium to run without sandbox protections.
 * - `logRedactSensitive`: Redacts phone/JID-like values in logs.
 * - `logIncludeStack`: Includes stack traces in error logs.
 * - `commandRateLimitCount`: Maximum accepted command count per sender window.
 * - `commandRateLimitWindowMs`: Rate-limit window duration in milliseconds.
 * - `commandMaxLength`: Maximum accepted command text length.
 * - `healthServerPort`: Optional port for health/metrics HTTP server (`null` disables server).
 */
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

  const inferredTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const timezone = process.env.TIMEZONE?.trim() || inferredTimezone || 'Europe/Istanbul';
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
    `Weekly game night - pick all slots you can join (${timezone})`;

  const clientId = process.env.CLIENT_ID?.trim() || 'game-scheduler';
  const dataDir = path.resolve(process.cwd(), process.env.DATA_DIR?.trim() || 'data');
  const headless = parseBoolean('HEADLESS', true);
  const allowInsecureChromium = parseBoolean('ALLOW_INSECURE_CHROMIUM', false);
  const logRedactSensitive = parseBoolean('LOG_REDACT_SENSITIVE', true);
  const logIncludeStack = parseBoolean('LOG_INCLUDE_STACK', false);

  const rawCommandPrefix = process.env.COMMAND_PREFIX;
  if (rawCommandPrefix !== undefined && rawCommandPrefix.trim() === '') {
    throw new Error('COMMAND_PREFIX cannot be empty.');
  }
  const commandPrefix = rawCommandPrefix === undefined ? '!schedule' : rawCommandPrefix.trim();

  const commandRateLimitCount = parseInteger('COMMAND_RATE_LIMIT_COUNT', 8);
  if (commandRateLimitCount < 1) {
    throw new Error('COMMAND_RATE_LIMIT_COUNT must be >= 1.');
  }

  const commandRateLimitWindowMs = parseInteger('COMMAND_RATE_LIMIT_WINDOW_MS', 60000);
  if (commandRateLimitWindowMs < 1000) {
    throw new Error('COMMAND_RATE_LIMIT_WINDOW_MS must be >= 1000.');
  }

  const commandMaxLength = parseInteger('COMMAND_MAX_LENGTH', 256);
  if (commandMaxLength < 16) {
    throw new Error('COMMAND_MAX_LENGTH must be >= 16.');
  }

  const healthServerPort = parseInteger('HEALTH_SERVER_PORT', null);
  if (healthServerPort !== null && (healthServerPort < 1 || healthServerPort > 65535)) {
    throw new Error('HEALTH_SERVER_PORT must be between 1 and 65535.');
  }

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
    commandPrefix,
    allowInsecureChromium,
    logRedactSensitive,
    logIncludeStack,
    commandRateLimitCount,
    commandRateLimitWindowMs,
    commandMaxLength,
    healthServerPort
  };
}

module.exports = {
  loadConfig,
  normalizeJid
};

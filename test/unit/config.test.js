const test = require('node:test');
const assert = require('node:assert/strict');

const { loadConfig, normalizeJid } = require('../../src/config');

function withEnv(overrides, fn) {
  const previous = {};

  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  }
}

const baseEnv = {
  GROUP_ID: '1234567890-123456789@g.us',
  OWNER_PHONE: '+90 555 111 1111',
  ALLOWED_VOTERS: '905551111111,905552222222,905553333333,905554444444,905555555555',
  TIMEZONE: 'Europe/Istanbul',
  REQUIRED_VOTERS: '5'
};

test('normalizeJid converts phone-like values to contact JID', () => {
  assert.equal(normalizeJid('+90 (555) 111-22-33'), '905551112233@c.us');
  assert.equal(normalizeJid('905551112233@c.us'), '905551112233@c.us');
});

test('normalizeJid throws for empty input', () => {
  assert.throws(() => normalizeJid('   '), /Cannot normalize an empty phone\/JID value/);
});

test('loadConfig reads security defaults and validates command guardrails', () => {
  withEnv(
    {
      ...baseEnv,
      ALLOW_INSECURE_CHROMIUM: undefined,
      LOG_REDACT_SENSITIVE: undefined,
      LOG_INCLUDE_STACK: undefined,
      COMMAND_RATE_LIMIT_COUNT: undefined,
      COMMAND_RATE_LIMIT_WINDOW_MS: undefined,
      COMMAND_MAX_LENGTH: undefined
    },
    () => {
      const config = loadConfig();

      assert.equal(config.allowInsecureChromium, false);
      assert.equal(config.logRedactSensitive, true);
      assert.equal(config.logIncludeStack, false);
      assert.equal(config.commandRateLimitCount, 8);
      assert.equal(config.commandRateLimitWindowMs, 60000);
      assert.equal(config.commandMaxLength, 256);
    }
  );
});

test('loadConfig rejects non-integer values with trailing text', () => {
  withEnv(
    {
      ...baseEnv,
      REQUIRED_VOTERS: '5abc'
    },
    () => {
      assert.throws(() => loadConfig(), /must be an integer/);
    }
  );
});

test('loadConfig parses explicit security and command settings', () => {
  withEnv(
    {
      ...baseEnv,
      ALLOW_INSECURE_CHROMIUM: 'true',
      LOG_REDACT_SENSITIVE: 'false',
      LOG_INCLUDE_STACK: 'true',
      COMMAND_RATE_LIMIT_COUNT: '3',
      COMMAND_RATE_LIMIT_WINDOW_MS: '30000',
      COMMAND_MAX_LENGTH: '128'
    },
    () => {
      const config = loadConfig();

      assert.equal(config.allowInsecureChromium, true);
      assert.equal(config.logRedactSensitive, false);
      assert.equal(config.logIncludeStack, true);
      assert.equal(config.commandRateLimitCount, 3);
      assert.equal(config.commandRateLimitWindowMs, 30000);
      assert.equal(config.commandMaxLength, 128);
    }
  );
});

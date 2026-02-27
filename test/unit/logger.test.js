const test = require('node:test');
const assert = require('node:assert/strict');

const {
  errorMetadata,
  formatMode,
  log,
  redactSensitiveText,
  setLogOptions
} = require('../../src/logger');

test('redactSensitiveText masks WhatsApp JIDs and long phone numbers', () => {
  const input = 'owner=905551112233@c.us group=1234567890-123456@g.us phone +90 555 111 2233';
  const output = redactSensitiveText(input);

  assert.match(output, /90\*\*\*33@c\.us/);
  assert.match(output, /12\*\*\*56@g\.us/);
  assert.match(output, /\+90\s+\*{3}\s+\*{3}\s+\*{2}33/);
});

test('redactSensitiveText leaves non-string values unchanged', () => {
  assert.equal(redactSensitiveText(42), 42);
  assert.equal(redactSensitiveText(null), null);
});

test('formatMode returns zero-padded octal mode text', () => {
  assert.equal(formatMode(0o600), '0600');
  assert.equal(formatMode(0o755), '0755');
});

test('errorMetadata includes optional stack and merges extra metadata', () => {
  const error = new Error('boom');
  error.stack = 'STACK';

  setLogOptions({ includeStack: false });
  assert.deepEqual(errorMetadata(error, { operation: 'test' }), {
    error: 'boom',
    operation: 'test'
  });

  setLogOptions({ includeStack: true });
  assert.deepEqual(errorMetadata(error, { operation: 'test' }), {
    error: 'boom',
    stack: 'STACK',
    operation: 'test'
  });

  setLogOptions({ includeStack: false });
  assert.deepEqual(errorMetadata('plain-failure'), { error: 'plain-failure' });
});

test('log outputs plain and redacted metadata payloads', () => {
  const calls = [];
  const originalLog = console.log;
  console.log = (message) => {
    calls.push(String(message));
  };

  try {
    setLogOptions({ redactSensitive: false, includeStack: false });
    log('INFO', 'No metadata message');
    assert.match(calls[0], /\[INFO\] No metadata message$/);

    setLogOptions({ redactSensitive: true, includeStack: false });
    const metadata = {
      jid: '905551112233@c.us',
      phone: '+90 555 111 2233'
    };
    metadata.self = metadata;

    log('INFO', 'With metadata', metadata);
    assert.match(calls[1], /"jid":"90\*\*\*33@c\.us"/);
    assert.match(calls[1], /"phone":"\+90 \*\*\* \*\*\* \*\*33"/);
    assert.match(calls[1], /"self":"\[Circular\]"/);
  } finally {
    console.log = originalLog;
    setLogOptions({ redactSensitive: true, includeStack: false });
  }
});

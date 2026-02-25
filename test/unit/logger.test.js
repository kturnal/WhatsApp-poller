const test = require('node:test');
const assert = require('node:assert/strict');

const { redactSensitiveText } = require('../../src/logger');

test('redactSensitiveText masks WhatsApp JIDs and long phone numbers', () => {
  const input = 'owner=905551112233@c.us group=1234567890-123456@g.us phone +90 555 111 2233';
  const output = redactSensitiveText(input);

  assert.match(output, /90\*\*\*33@c\.us/);
  assert.match(output, /12\*\*\*56@g\.us/);
  assert.match(output, /\+90\s+\*{3}\s+\*{3}\s+\*{2}33/);
});

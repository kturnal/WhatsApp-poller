const test = require('node:test');
const assert = require('node:assert/strict');

const {
  collectGroupCandidates,
  getChatLabel,
  isGroupChat,
  printGroupCandidates,
  serializeChatId
} = require('../../src/group-discovery');

test('serializeChatId supports serialized object ids', () => {
  assert.equal(serializeChatId({ id: '123@g.us' }), '123@g.us');
  assert.equal(serializeChatId({ id: { _serialized: '456@g.us' } }), '456@g.us');
  assert.equal(serializeChatId({ id: {} }), null);
});

test('isGroupChat detects groups by flag or group jid suffix', () => {
  assert.equal(isGroupChat({ isGroup: true, id: '123@g.us' }), true);
  assert.equal(isGroupChat({ id: { _serialized: '123@g.us' } }), true);
  assert.equal(isGroupChat({ isGroup: false, id: '905551111111@c.us' }), false);
});

test('getChatLabel prefers explicit names and falls back to unnamed group label', () => {
  assert.equal(getChatLabel({ name: 'Friday Ball' }), 'Friday Ball');
  assert.equal(getChatLabel({ formattedTitle: 'Weekend Crew' }), 'Weekend Crew');
  assert.equal(getChatLabel({ id: { _serialized: '123@g.us' } }), 'Unnamed group (123@g.us)');
});

test('collectGroupCandidates filters non-groups and sorts group names', () => {
  assert.deepEqual(
    collectGroupCandidates([
      { name: 'zeta', id: { _serialized: '3@g.us' }, isGroup: true },
      { name: 'Alpha', id: { _serialized: '1@g.us' }, isGroup: true },
      { name: 'Direct chat', id: { _serialized: '905551111111@c.us' }, isGroup: false },
      { formattedTitle: 'beta', id: { _serialized: '2@g.us' } },
      { isGroup: true, id: {} }
    ]),
    [
      { id: '1@g.us', name: 'Alpha' },
      { id: '2@g.us', name: 'beta' },
      { id: '3@g.us', name: 'zeta' }
    ]
  );
});

test('printGroupCandidates renders copyable GROUP_ID lines', () => {
  let output = '';
  printGroupCandidates(
    {
      write(value) {
        output += String(value);
      }
    },
    [
      { id: '1@g.us', name: 'Alpha' },
      { id: '2@g.us', name: 'Beta' }
    ]
  );

  assert.match(output, /Available WhatsApp groups/);
  assert.match(output, /GROUP_ID=1@g\.us/);
  assert.match(output, /GROUP_ID=2@g\.us/);
});

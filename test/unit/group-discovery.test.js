const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  collectGroupCandidates,
  discoverGroupsWithClient,
  getChatLabel,
  isGroupChat,
  printDiscoverySummary,
  printGroupCandidates,
  resolveGroupDiscoveryClient,
  serializeChatId
} = require('../../src/group-discovery');

class FakeDiscoveryClient extends EventEmitter {
  constructor({ chats = [], initialize } = {}) {
    super();
    this.chats = chats;
    this.initializeImpl = initialize || (async () => {});
  }

  async getChats() {
    return this.chats;
  }

  async initialize() {
    return this.initializeImpl();
  }

  async destroy() {}
}

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

test('printDiscoverySummary omits copy instructions when no groups are available', () => {
  let output = '';
  printDiscoverySummary(
    {
      write(value) {
        output += String(value);
      }
    },
    []
  );

  assert.match(output, /No WhatsApp groups were found/);
  assert.doesNotMatch(output, /Copy the correct GROUP_ID/);
});

test('resolveGroupDiscoveryClient accepts a factory function or a client instance', () => {
  const client = new FakeDiscoveryClient();

  assert.equal(
    resolveGroupDiscoveryClient(() => client, {
      clientId: 'test-client',
      dataDir: '/tmp/discovery-test',
      headless: true,
      puppeteerArgs: []
    }),
    client
  );

  assert.equal(
    resolveGroupDiscoveryClient(client, {
      clientId: 'test-client',
      dataDir: '/tmp/discovery-test',
      headless: true,
      puppeteerArgs: []
    }),
    client
  );
});

test('discoverGroupsWithClient rejects when discovery times out', async () => {
  const client = new FakeDiscoveryClient();

  await assert.rejects(
    () =>
      discoverGroupsWithClient({
        client,
        output: { write() {} },
        discoveryTimeoutMs: 5
      }),
    /timed out after 5 ms/
  );
});

test('discoverGroupsWithClient resolves groups after ready event', async () => {
  const client = new FakeDiscoveryClient({
    chats: [{ name: 'Friday Ball', id: { _serialized: '123@g.us' }, isGroup: true }],
    initialize: async function initialize() {
      queueMicrotask(() => {
        this.emit('ready');
      });
    }
  });

  const groups = await discoverGroupsWithClient({
    client,
    output: { write() {} },
    discoveryTimeoutMs: 100
  });

  assert.deepEqual(groups, [{ id: '123@g.us', name: 'Friday Ball' }]);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const {
  GameSchedulerBot,
  extractParentMessageId,
  getMessageSenderJid,
  serializeMessageId,
  serializeMessageKey
} = require('../../src/index');

class FakeChat {
  constructor() {
    this.messages = [];
  }

  async sendMessage(payload) {
    this.messages.push(payload);
    return {
      id: { _serialized: `msg-${this.messages.length}` },
      pollOptions: [{ localId: 'opt-0' }, { localId: 'opt-1' }]
    };
  }
}

class FakeClient extends EventEmitter {
  constructor(groupId, chat) {
    super();
    this.groupId = groupId;
    this.chat = chat;
  }

  async initialize() {}

  async destroy() {}

  async getChatById(groupId) {
    if (groupId !== this.groupId) {
      throw new Error(`Unknown group id: ${groupId}`);
    }

    return this.chat;
  }

  async getPollVotes() {
    return [];
  }
}

function createConfig(dataDir, overrides = {}) {
  const allowedVoters = ['905551111111@c.us', '905552222222@c.us', '905553333333@c.us'];

  return {
    groupId: '1234567890-123456789@g.us',
    ownerJid: '905551111111@c.us',
    allowedVoters,
    allowedVoterSet: new Set(allowedVoters),
    requiredVoters: 2,
    timezone: 'Europe/Istanbul',
    pollCloseHours: 48,
    tieOverrideHours: 6,
    pollCron: '0 12 * * 1',
    pollQuestion: 'Weekly game night test poll',
    clientId: 'unit-test-client',
    dataDir,
    headless: true,
    commandPrefix: '!schedule',
    allowInsecureChromium: false,
    logRedactSensitive: false,
    logIncludeStack: false,
    commandRateLimitCount: 2,
    commandRateLimitWindowMs: 60000,
    commandMaxLength: 256,
    ...overrides
  };
}

function createBotHarness(configOverrides = {}, dependencies = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-poller-unit-index-'));
  const config = createConfig(tempDir, configOverrides);
  const chat = new FakeChat();
  const client = new FakeClient(config.groupId, chat);

  const bot = new GameSchedulerBot(config, {
    clientFactory: () => client,
    pollFactory: (question, optionLabels, options) => ({
      kind: 'poll',
      question,
      optionLabels,
      options
    }),
    ...dependencies
  });

  return {
    bot,
    chat,
    client,
    config,
    cleanup: async () => {
      await bot.shutdown('test');
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  };
}

test('serializeMessageKey supports multiple key shapes', () => {
  assert.equal(serializeMessageKey('abc'), 'abc');
  assert.equal(serializeMessageKey({ _serialized: 'def' }), 'def');
  assert.equal(serializeMessageKey({ id: 'ghi' }), 'ghi');
  assert.equal(serializeMessageKey({ id: { _serialized: 'jkl' } }), 'jkl');
  assert.equal(serializeMessageKey({ id: {} }), null);
  assert.equal(serializeMessageKey(null), null);
});

test('serializeMessageId reads serialized id from message object', () => {
  assert.equal(serializeMessageId({ id: { _serialized: 'msg-1' } }), 'msg-1');
  assert.equal(serializeMessageId({}), null);
  assert.equal(serializeMessageId(null), null);
});

test('extractParentMessageId prefers first valid key candidate', () => {
  const vote = {
    parentMessage: { id: { _serialized: 'parent-id' } },
    parentMsgKey: { _serialized: 'fallback-parent-msg-key' },
    msgKey: { _serialized: 'fallback-msg-key' }
  };

  assert.equal(extractParentMessageId(vote), 'parent-id');
  assert.equal(extractParentMessageId({ parentMsgKey: 'x' }), 'x');
  assert.equal(extractParentMessageId({}), null);
});

test('getMessageSenderJid normalizes author participant and from fields', () => {
  assert.equal(getMessageSenderJid({ author: '+90 555 111 1111' }), '905551111111@c.us');
  assert.equal(getMessageSenderJid({ id: { participant: '905552222222' } }), '905552222222@c.us');
  assert.equal(getMessageSenderJid({ from: '905553333333@c.us' }), '905553333333@c.us');
  assert.equal(getMessageSenderJid({ author: '   ' }), null);
});

test('isRateLimited enforces threshold and purges expired command windows', async (t) => {
  let nowMs = 1_700_000_000_000;
  const harness = createBotHarness(
    {
      commandRateLimitCount: 2,
      commandRateLimitWindowMs: 1000
    },
    { now: () => nowMs }
  );
  t.after(async () => {
    await harness.cleanup();
  });

  assert.equal(harness.bot.isRateLimited('905551111111@c.us'), false);
  assert.equal(harness.bot.isRateLimited('905551111111@c.us'), false);
  assert.equal(harness.bot.isRateLimited('905551111111@c.us'), true);

  nowMs += 2001;
  assert.equal(harness.bot.isRateLimited('905551111111@c.us'), false);
});

test('mapVoteSelectionsToOptionIndices deduplicates, sorts, and tracks discarded IDs', async (t) => {
  const harness = createBotHarness();
  t.after(async () => {
    await harness.cleanup();
  });

  const poll = {
    options: [{ localId: 'opt-0' }, { localId: 'opt-1' }, { localId: 'opt-2' }]
  };

  const mapped = harness.bot.mapVoteSelectionsToOptionIndices(poll, [
    { localId: 'opt-2' },
    { localId: 'opt-1' },
    { localId: 'opt-1' },
    { localId: 'missing' },
    {}
  ]);

  assert.deepEqual(mapped.selectedOptions, [1, 2]);
  assert.deepEqual(mapped.discardedLocalIds, ['missing', null]);
});

test('normalizeVoteUpdateForPoll returns skip reasons and normalized vote payload', async (t) => {
  const harness = createBotHarness();
  t.after(async () => {
    await harness.cleanup();
  });

  const poll = {
    options: [{ localId: 'opt-0' }, { localId: 'opt-1' }]
  };

  assert.deepEqual(harness.bot.normalizeVoteUpdateForPoll(poll, {}), {
    status: 'skip',
    reason: 'missing_voter'
  });

  assert.deepEqual(harness.bot.normalizeVoteUpdateForPoll(poll, { voter: '   ' }), {
    status: 'skip',
    reason: 'invalid_voter'
  });

  assert.deepEqual(
    harness.bot.normalizeVoteUpdateForPoll(poll, {
      voter: '905559999999',
      selectedOptions: [{ localId: 'opt-0' }]
    }),
    {
      status: 'skip',
      reason: 'not_allowlisted',
      voterJid: '905559999999@c.us'
    }
  );

  assert.deepEqual(
    harness.bot.normalizeVoteUpdateForPoll(poll, {
      voter: '905551111111',
      selectedOptions: [{ localId: 'opt-1' }]
    }),
    {
      status: 'ok',
      voterJid: '905551111111@c.us',
      selectedOptions: [1],
      discardedLocalIds: []
    }
  );
});

test('onVoteUpdate ignores invalid-only option selections', async (t) => {
  const harness = createBotHarness();
  t.after(async () => {
    await harness.cleanup();
  });

  const now = Date.now();
  const pollId = harness.bot.db.createPoll({
    groupId: harness.config.groupId,
    weekKey: '2026-W11',
    pollMessageId: 'poll-message-1',
    question: 'q',
    options: [
      { label: 'Mon', localId: 'opt-0' },
      { label: 'Tue', localId: 'opt-1' }
    ],
    createdAt: now,
    closesAt: now + 3600000
  });

  await harness.bot.onVoteUpdate({
    parentMessage: { id: 'poll-message-1' },
    voter: '905551111111',
    selectedOptions: [{ localId: 'not-in-poll' }]
  });

  const votes = harness.bot.db.getVotesByPollId(pollId);
  assert.equal(votes.length, 0);
});

test('startCronIfNeeded throws for invalid cron expression', async (t) => {
  const harness = createBotHarness({
    pollCron: 'not-a-cron-expression'
  });
  t.after(async () => {
    await harness.cleanup();
  });

  assert.throws(() => harness.bot.startCronIfNeeded(), /Invalid cron expression/);
});

test('sendOutboxPayload times out when sendGroupMessage stalls', async (t) => {
  const harness = createBotHarness({}, { outboxSendTimeoutMs: 25 });
  t.after(async () => {
    await harness.cleanup();
  });

  harness.bot.sendGroupMessage = async () => {
    await new Promise(() => {});
  };

  await assert.rejects(
    harness.bot.sendOutboxPayload({
      kind: 'group-text',
      text: 'hello'
    }),
    /Outbox payload send timed out after 25ms\./
  );
});

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
    this.lidAndPhoneByUserId = new Map();
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

  async getContactLidAndPhone(userIds) {
    const ids = Array.isArray(userIds) ? userIds : [userIds];

    return ids.map((id) => {
      return this.lidAndPhoneByUserId.get(id) || { lid: id, pn: null };
    });
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
    weekSelectionMode: 'auto',
    targetWeek: null,
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

  assert.deepEqual(await harness.bot.normalizeVoteUpdateForPoll(poll, {}), {
    status: 'skip',
    reason: 'missing_voter'
  });

  assert.deepEqual(await harness.bot.normalizeVoteUpdateForPoll(poll, { voter: '   ' }), {
    status: 'skip',
    reason: 'invalid_voter'
  });

  assert.deepEqual(
    await harness.bot.normalizeVoteUpdateForPoll(poll, {
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
    await harness.bot.normalizeVoteUpdateForPoll(poll, {
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

  harness.client.lidAndPhoneByUserId.set('owner-lid@lid', {
    lid: 'owner-lid@lid',
    pn: '905551111111@c.us'
  });
  assert.deepEqual(
    await harness.bot.normalizeVoteUpdateForPoll(poll, {
      voter: 'owner-lid@lid',
      selectedOptions: [{ localId: 'opt-0' }]
    }),
    {
      status: 'ok',
      voterJid: '905551111111@c.us',
      selectedOptions: [0],
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

test('onMessageCreate does not warn for non-command messages with many tokens', async (t) => {
  const harness = createBotHarness();
  t.after(async () => {
    await harness.cleanup();
  });

  const originalConsoleLog = console.log;
  const logs = [];
  console.log = (...args) => {
    logs.push(args.map((value) => String(value)).join(' '));
  };

  try {
    await harness.bot.onMessageCreate({
      body: 'hello this is a regular chat message with many words from a participant',
      from: harness.config.groupId,
      author: '905552222222@c.us'
    });
  } finally {
    console.log = originalConsoleLog;
  }

  assert.equal(
    logs.some((entry) => entry.includes('Ignoring command: too many tokens.')),
    false
  );
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

test('interactive startup mode skips selection when an active poll exists', async (t) => {
  let resolverCalled = false;
  const harness = createBotHarness(
    {
      weekSelectionMode: 'interactive'
    },
    {
      startupWeekSelectionResolver: async () => {
        resolverCalled = true;
        return {
          action: 'create',
          weekYear: 2026,
          weekNumber: 10,
          weekKey: '2026-W10',
          weekLabel: '2026 W10 March 2 - March 8',
          existingPollId: null
        };
      }
    }
  );
  t.after(async () => {
    await harness.cleanup();
  });

  const now = Date.now();
  harness.bot.db.createPoll({
    groupId: harness.config.groupId,
    weekKey: '2026-W09',
    pollMessageId: 'active-poll',
    question: 'q',
    options: [{ label: 'Mon', localId: 'opt-0' }],
    createdAt: now,
    closesAt: now + 3600000
  });

  await harness.bot.onReady();

  assert.equal(resolverCalled, false);
});

test('interactive startup mode creates selected week poll and does not start cron', async (t) => {
  let cronStarted = false;
  const harness = createBotHarness(
    {
      weekSelectionMode: 'interactive'
    },
    {
      startupWeekSelectionResolver: async () => ({
        action: 'create',
        weekYear: 2026,
        weekNumber: 10,
        weekKey: '2026-W10',
        weekLabel: '2026 W10 March 2 - March 8',
        existingPollId: null
      })
    }
  );
  t.after(async () => {
    await harness.cleanup();
  });

  harness.bot.startCronIfNeeded = () => {
    cronStarted = true;
  };

  await harness.bot.onReady();

  const poll = harness.bot.db.getPollByWeekKey(harness.config.groupId, '2026-W10');
  assert.ok(poll);
  assert.equal(cronStarted, false);
});

test('interactive startup mode respects skip action when selected week already exists', async (t) => {
  const harness = createBotHarness(
    {
      weekSelectionMode: 'interactive'
    },
    {
      startupWeekSelectionResolver: async () => ({
        action: 'skip',
        weekYear: 2026,
        weekNumber: 10,
        weekKey: '2026-W10',
        weekLabel: '2026 W10 March 2 - March 8',
        existingPollId: 1
      })
    }
  );
  t.after(async () => {
    await harness.cleanup();
  });

  await harness.bot.onReady();

  const poll = harness.bot.db.getPollByWeekKey(harness.config.groupId, '2026-W10');
  assert.equal(poll, null);
});

test('interactive startup mode replaces existing week poll in place and clears votes', async (t) => {
  let existingPollId = null;
  const harness = createBotHarness(
    {
      weekSelectionMode: 'interactive'
    },
    {
      startupWeekSelectionResolver: async () => ({
        action: 'replace',
        weekYear: 2026,
        weekNumber: 10,
        weekKey: '2026-W10',
        weekLabel: '2026 W10 March 2 - March 8',
        existingPollId
      })
    }
  );
  t.after(async () => {
    await harness.cleanup();
  });

  const now = Date.now();
  existingPollId = harness.bot.db.createPoll({
    groupId: harness.config.groupId,
    weekKey: '2026-W10',
    pollMessageId: 'old-message-id',
    question: 'old question',
    options: [{ label: 'Old', localId: 'old-opt' }],
    createdAt: now - 3600000,
    closesAt: now - 1800000
  });

  harness.bot.db.upsertVote({
    pollId: existingPollId,
    voterJid: '905551111111@c.us',
    selectedOptions: [0],
    updatedAt: now - 3500000
  });
  harness.bot.db.setAnnounced({
    pollId: existingPollId,
    closeReason: 'deadline',
    closedAt: now - 1700000,
    announcedAt: now - 1700000,
    winnerIdx: 0,
    winnerVotes: 1
  });

  await harness.bot.onReady();

  const replaced = harness.bot.db.getPollByWeekKey(harness.config.groupId, '2026-W10');
  assert.ok(replaced);
  assert.equal(replaced.id, existingPollId);
  assert.equal(replaced.status, 'OPEN');
  assert.equal(replaced.closeReason, null);
  assert.notEqual(replaced.pollMessageId, 'old-message-id');

  const votes = harness.bot.db.getVotesByPollId(existingPollId);
  assert.equal(votes.length, 0);
});

test('auto mode keeps cron/catch-up path and does not invoke startup week selector', async (t) => {
  let cronCalled = false;
  let catchupCalled = false;
  let selectorCalled = false;
  const harness = createBotHarness(
    {
      weekSelectionMode: 'auto'
    },
    {
      startupWeekSelectionResolver: async () => {
        selectorCalled = true;
        return null;
      }
    }
  );
  t.after(async () => {
    await harness.cleanup();
  });

  harness.bot.startCronIfNeeded = () => {
    cronCalled = true;
  };
  harness.bot.createCurrentWeekPollIfMissed = async () => {
    catchupCalled = true;
  };

  await harness.bot.onReady();

  assert.equal(cronCalled, true);
  assert.equal(catchupCalled, true);
  assert.equal(selectorCalled, false);
});

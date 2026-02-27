const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { GameSchedulerBot } = require('../../src/index');

class FakeChat {
  constructor() {
    this.messages = [];
    this.pollMessageCount = 0;
  }

  async sendMessage(payload) {
    this.messages.push(payload);

    if (payload && payload.kind === 'poll') {
      this.pollMessageCount += 1;
      return {
        id: { _serialized: `poll-msg-${this.pollMessageCount}` },
        pollOptions: payload.optionLabels.map((_, index) => ({ localId: `opt-${index}` }))
      };
    }

    return {
      id: { _serialized: `msg-${this.messages.length}` }
    };
  }
}

class FakeClient extends EventEmitter {
  constructor(groupId, chat) {
    super();
    this.groupId = groupId;
    this.chat = chat;
    this.initialized = false;
    this.destroyed = false;
    this.pollVotesByMessageId = new Map();
  }

  async initialize() {
    this.initialized = true;
  }

  async destroy() {
    this.destroyed = true;
  }

  async getChatById(groupId) {
    if (groupId !== this.groupId) {
      throw new Error(`Unknown group id requested: ${groupId}`);
    }

    return this.chat;
  }

  async getPollVotes(messageId) {
    return this.pollVotesByMessageId.get(messageId) || [];
  }
}

function createConfig(dataDir, overrides = {}) {
  const allowedVoters = [
    '905551111111@c.us',
    '905552222222@c.us',
    '905553333333@c.us',
    '905554444444@c.us',
    '905555555555@c.us'
  ];

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
    clientId: 'test-client',
    dataDir,
    headless: true,
    commandPrefix: '!schedule',
    allowInsecureChromium: false,
    logRedactSensitive: false,
    logIncludeStack: false,
    commandRateLimitCount: 8,
    commandRateLimitWindowMs: 60000,
    commandMaxLength: 256,
    ...overrides
  };
}

function createBotInstance(config, options = {}) {
  const chat = options.chat || new FakeChat();
  const client = new FakeClient(config.groupId, chat);

  const bot = new GameSchedulerBot(config, {
    now: options.now,
    clientFactory: () => client,
    pollFactory: (question, optionLabels, pollOptions) => ({
      kind: 'poll',
      question,
      optionLabels,
      options: pollOptions
    })
  });

  return { bot, chat, client };
}

function createHarness(overrides = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-poller-test-'));
  const baseConfig = createConfig(tempDir, overrides.config || {});
  const { bot, chat, client } = createBotInstance(baseConfig, {
    chat: overrides.chat,
    now: overrides.now
  });

  return {
    bot,
    chat,
    client,
    config: baseConfig,
    cleanup: async () => {
      let shutdownError;
      try {
        await bot.shutdown('test');
      } catch (error) {
        shutdownError = error;
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }

      if (shutdownError) {
        throw shutdownError;
      }
    }
  };
}

const testWaitMsFromEnv = Number.parseInt(process.env.TEST_WAIT_MS || '', 10);
const DEFAULT_WAIT_TIMEOUT_MS =
  Number.isInteger(testWaitMsFromEnv) && testWaitMsFromEnv > 0 ? testWaitMsFromEnv : 5000;

async function waitForCondition(condition, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, intervalMs);
    });
  }

  assert.fail('Condition was not met before timeout.');
}

test('quorum votes close poll and announce winner', async (t) => {
  const harness = createHarness();
  t.after(async () => {
    await harness.cleanup();
  });

  await harness.bot.createWeeklyPollIfNeeded('integration');
  const activePoll = harness.bot.db.getActivePoll(harness.config.groupId);

  assert.ok(activePoll);

  await harness.bot.onVoteUpdate({
    parentMessage: { id: activePoll.pollMessageId },
    voter: '905551111111',
    selectedOptions: [{ localId: 'opt-0' }]
  });

  await harness.bot.onVoteUpdate({
    parentMessage: { id: activePoll.pollMessageId },
    voter: '905552222222',
    selectedOptions: [{ localId: 'opt-0' }]
  });

  const latest = harness.bot.db.getPollByWeekKey(harness.config.groupId, activePoll.weekKey);
  assert.equal(latest.status, 'ANNOUNCED');
  assert.equal(latest.winningOptionIdx, 0);

  const textMessages = harness.chat.messages.filter((message) => typeof message === 'string');
  assert.ok(textMessages.some((message) => message.includes('Weekly game slot selected:')));
});

test('restart with persistent data closes poll on deadline and announces winner', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-poller-restart-test-'));
  const chat = new FakeChat();
  const managedBots = new Set();
  let clockNow = Date.now();

  t.after(async () => {
    for (const bot of managedBots) {
      await bot.shutdown('test');
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const firstConfig = createConfig(dataDir, {
    requiredVoters: 5,
    pollCloseHours: 1
  });

  const first = createBotInstance(firstConfig, {
    chat,
    now: () => clockNow
  });
  managedBots.add(first.bot);

  await first.bot.createWeeklyPollIfNeeded('integration');
  const activePoll = first.bot.db.getActivePoll(firstConfig.groupId);
  assert.ok(activePoll);

  await first.bot.onVoteUpdate({
    parentMessage: { id: activePoll.pollMessageId },
    voter: '905551111111',
    selectedOptions: [{ localId: 'opt-0' }]
  });

  const openPollBeforeRestart = first.bot.db.getPollById(activePoll.id);
  assert.equal(openPollBeforeRestart.status, 'OPEN');

  await first.bot.shutdown('test');
  managedBots.delete(first.bot);

  clockNow = activePoll.closesAt + 1000;

  const secondConfig = createConfig(dataDir, {
    requiredVoters: 5,
    pollCloseHours: 1
  });

  const second = createBotInstance(secondConfig, {
    chat,
    now: () => clockNow
  });
  managedBots.add(second.bot);

  second.bot.recoverPendingPolls();

  await waitForCondition(() => {
    const latest = second.bot.db.getPollById(activePoll.id);
    return latest && latest.status === 'ANNOUNCED';
  });

  const latest = second.bot.db.getPollById(activePoll.id);
  assert.equal(latest.status, 'ANNOUNCED');
  assert.equal(latest.closeReason, 'deadline');
  assert.equal(latest.winningOptionIdx, 0);
  assert.equal(latest.winnerVoteCount, 1);

  const textMessages = chat.messages.filter((message) => typeof message === 'string');
  assert.ok(textMessages.some((message) => message.includes('Weekly game slot selected:')));
});

test('restart reconciliation backfills missed votes before quorum closure', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-poller-reconcile-test-'));
  const chat = new FakeChat();
  const managedBots = new Set();

  t.after(async () => {
    for (const bot of managedBots) {
      await bot.shutdown('test');
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const firstConfig = createConfig(dataDir, {
    requiredVoters: 2,
    pollCloseHours: 24
  });

  const first = createBotInstance(firstConfig, {
    chat
  });
  managedBots.add(first.bot);

  await first.bot.createWeeklyPollIfNeeded('integration');
  const activePoll = first.bot.db.getActivePoll(firstConfig.groupId);
  assert.ok(activePoll);

  await first.bot.shutdown('test');
  managedBots.delete(first.bot);

  const secondConfig = createConfig(dataDir, {
    requiredVoters: 2,
    pollCloseHours: 24
  });

  const second = createBotInstance(secondConfig, {
    chat
  });
  managedBots.add(second.bot);

  second.client.pollVotesByMessageId.set(activePoll.pollMessageId, [
    {
      voter: '905551111111',
      selectedOptions: [{ localId: 'opt-1' }]
    },
    {
      voter: '905551111111',
      selectedOptions: [{ localId: 'opt-0' }]
    },
    {
      voter: '905552222222',
      selectedOptions: [{ localId: 'opt-0' }]
    },
    {
      voter: '905559999999',
      selectedOptions: [{ localId: 'opt-0' }]
    }
  ]);

  await second.bot.reconcilePendingPollVotes();
  second.bot.recoverPendingPolls();

  const latest = second.bot.db.getPollById(activePoll.id);
  assert.equal(latest.status, 'ANNOUNCED');
  assert.equal(latest.closeReason, 'quorum');
  assert.equal(latest.winningOptionIdx, 0);
  assert.equal(latest.winnerVoteCount, 2);

  const votes = second.bot.db.getVotesByPollId(activePoll.id);
  assert.equal(votes.length, 2);

  const firstVoterVote = votes.find((vote) => vote.voterJid === '905551111111@c.us');
  assert.deepEqual(firstVoterVote.selectedOptions, [0]);

  const textMessages = chat.messages.filter((message) => typeof message === 'string');
  assert.ok(textMessages.some((message) => message.includes('Weekly game slot selected:')));
});

test('tie can be resolved with owner manual pick', async (t) => {
  const harness = createHarness();
  t.after(async () => {
    await harness.cleanup();
  });

  await harness.bot.createWeeklyPollIfNeeded('integration');
  const activePoll = harness.bot.db.getActivePoll(harness.config.groupId);

  await harness.bot.onVoteUpdate({
    parentMessage: { id: activePoll.pollMessageId },
    voter: '905551111111',
    selectedOptions: [{ localId: 'opt-0' }]
  });

  await harness.bot.onVoteUpdate({
    parentMessage: { id: activePoll.pollMessageId },
    voter: '905552222222',
    selectedOptions: [{ localId: 'opt-1' }]
  });

  const tiePoll = harness.bot.db.getPollById(activePoll.id);
  assert.equal(tiePoll.status, 'TIE_PENDING');

  await harness.bot.handleManualPick(
    {
      body: '!schedule pick 2',
      from: harness.config.groupId,
      author: harness.config.ownerJid
    },
    '2'
  );

  const latest = harness.bot.db.getPollById(activePoll.id);
  assert.equal(latest.status, 'ANNOUNCED');
  assert.equal(latest.winningOptionIdx, 1);
});

test('command rate limiting drops excess commands from same sender', async (t) => {
  const harness = createHarness({
    config: {
      commandRateLimitCount: 1,
      commandRateLimitWindowMs: 60000
    }
  });
  t.after(async () => {
    await harness.cleanup();
  });

  await harness.bot.onMessageCreate({
    body: '!schedule help',
    from: harness.config.groupId,
    author: '905552222222@c.us'
  });

  await harness.bot.onMessageCreate({
    body: '!schedule help',
    from: harness.config.groupId,
    author: '905552222222@c.us'
  });

  const helpMessages = harness.chat.messages.filter((message) => {
    return typeof message === 'string' && message.includes('Commands:');
  });

  assert.equal(helpMessages.length, 1);
});

test('recoverPendingPolls schedules both close and tie timers', async (t) => {
  const harness = createHarness();
  t.after(async () => {
    await harness.cleanup();
  });

  const now = Date.now();

  const openPollId = harness.bot.db.createPoll({
    groupId: harness.config.groupId,
    weekKey: '2026-W01',
    pollMessageId: 'open-message-id',
    question: 'q1',
    options: [{ label: 'Mon', localId: 'opt-0' }],
    createdAt: now,
    closesAt: now + 3600000
  });

  const tiePollId = harness.bot.db.createPoll({
    groupId: harness.config.groupId,
    weekKey: '2026-W02',
    pollMessageId: 'tie-message-id',
    question: 'q2',
    options: [
      { label: 'Mon', localId: 'opt-0' },
      { label: 'Tue', localId: 'opt-1' }
    ],
    createdAt: now,
    closesAt: now + 3600000
  });

  harness.bot.db.setTiePending({
    pollId: tiePollId,
    closeReason: 'quorum',
    closedAt: now,
    tieDeadlineAt: now + 3600000,
    tieOptionIndices: [0, 1]
  });

  harness.bot.recoverPendingPolls();

  assert.ok(harness.bot.closeTimers.has(openPollId));
  assert.ok(harness.bot.tieTimers.has(tiePollId));
});

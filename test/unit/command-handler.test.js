const test = require('node:test');
const assert = require('node:assert/strict');

const { onMessageCreate } = require('../../src/services/command-handler');

function createBot(overrides = {}) {
  return {
    config: {
      groupId: '1234567890-123456789@g.us',
      commandPrefix: '!schedule',
      commandMaxLength: 256,
      commandRateLimitCount: 2,
      commandRateLimitWindowMs: 60000,
      ownerJid: '905551111111@c.us',
      requiredVoters: 2,
      timezone: 'Europe/Istanbul',
      ...overrides.config
    },
    isRateLimited: () => false,
    sendGroupMessage: async () => {},
    helpText: () => 'help-text',
    buildStatusText: () => 'status-text',
    handleManualPick: async () => {},
    ...overrides
  };
}

test('onMessageCreate routes commands through the command service boundary', async () => {
  const calls = [];
  const bot = createBot({
    sendGroupMessage: async (text) => {
      calls.push({ type: 'send', text });
    },
    handleManualPick: async (_message, optionRaw) => {
      calls.push({ type: 'pick', optionRaw });
    }
  });

  await onMessageCreate(bot, {
    body: '!schedule status',
    from: bot.config.groupId,
    author: '905551111111'
  });

  await onMessageCreate(bot, {
    body: '!schedule pick 2',
    from: bot.config.groupId,
    author: '905551111111'
  });

  await onMessageCreate(bot, {
    body: '!schedule unknown',
    from: bot.config.groupId,
    author: '905551111111'
  });

  assert.deepEqual(calls, [
    { type: 'send', text: 'status-text' },
    { type: 'pick', optionRaw: '2' },
    { type: 'send', text: 'help-text' }
  ]);
});

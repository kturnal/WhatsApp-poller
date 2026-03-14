const test = require('node:test');
const assert = require('node:assert/strict');

const { deliverOutboxMessage } = require('../../src/services/outbox-delivery');

test('deliverOutboxMessage records retry metadata for transient failures', async () => {
  const failedWrites = [];
  const retryableFlags = [];
  const bot = {
    now: () => 1_700_000_000_000,
    sendOutboxPayload: async () => {
      throw new Error('simulated send failure');
    },
    getOutboxRetryDelayMs: () => 5000,
    observability: {
      recordOutboxFailure: (retryable) => {
        retryableFlags.push(retryable);
      }
    },
    db: {
      markOutboxFailed: (payload) => {
        failedWrites.push(payload);
      },
      markOutboxSent: () => {
        throw new Error('markOutboxSent should not be called on failure');
      }
    }
  };

  await deliverOutboxMessage(bot, {
    id: 7,
    payload: {
      kind: 'group-text',
      text: 'hello'
    },
    attemptCount: 1,
    maxAttempts: 3
  });

  assert.deepEqual(retryableFlags, [true]);
  assert.deepEqual(failedWrites, [
    {
      outboxId: 7,
      attemptCount: 2,
      nextRetryAt: 1_700_000_005_000,
      lastError: 'simulated send failure'
    }
  ]);
});

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

test('deliverOutboxMessage marks timed out sends as ambiguous', async () => {
  const ambiguousWrites = [];
  const retryableFlags = [];
  const timeoutError = new Error('Outbox payload send timed out after 250ms.');
  timeoutError.code = 'OUTBOX_SEND_TIMEOUT';

  const bot = {
    now: () => 1_700_000_000_000,
    sendOutboxPayload: async () => {
      throw timeoutError;
    },
    observability: {
      recordOutboxFailure: (retryable) => {
        retryableFlags.push(retryable);
      }
    },
    db: {
      markOutboxAmbiguous: (payload) => {
        ambiguousWrites.push(payload);
      },
      markOutboxFailed: () => {
        throw new Error('markOutboxFailed should not be called for timed out sends');
      },
      markOutboxSent: () => {
        throw new Error('markOutboxSent should not be called for timed out sends');
      }
    }
  };

  await deliverOutboxMessage(bot, {
    id: 8,
    payload: {
      kind: 'group-text',
      text: 'hello'
    },
    attemptCount: 0,
    maxAttempts: 3
  });

  assert.deepEqual(retryableFlags, [false]);
  assert.deepEqual(ambiguousWrites, [
    {
      outboxId: 8,
      attemptCount: 1,
      lastError: 'Outbox payload send timed out after 250ms.'
    }
  ]);
});

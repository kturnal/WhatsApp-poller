const { errorMetadata, log } = require('../logger');

const MAX_TIMEOUT_MS = 2 ** 31 - 1;
const OUTBOX_BATCH_SIZE = 20;

class OutboxSendTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Outbox payload send timed out after ${timeoutMs}ms.`);
    this.name = 'OutboxSendTimeoutError';
    this.code = 'OUTBOX_SEND_TIMEOUT';
  }
}

function isOutboxSendTimeoutError(error) {
  return error instanceof OutboxSendTimeoutError || error?.code === 'OUTBOX_SEND_TIMEOUT';
}

function buildOutboxTextMessage(bot, text, createdAt = bot.now()) {
  return {
    groupId: bot.config.groupId,
    payload: {
      kind: 'group-text',
      text
    },
    status: 'PENDING',
    attemptCount: 0,
    maxAttempts: bot.outboxMaxAttempts,
    createdAt,
    nextRetryAt: createdAt,
    lastError: null
  };
}

function getOutboxRetryDelayMs(bot, attemptCount) {
  const growth = 2 ** Math.max(0, attemptCount - 1);
  return Math.min(bot.outboxRetryBaseMs * growth, bot.outboxRetryMaxMs);
}

function clearOutboxTimer(bot) {
  if (!bot.outboxTimer) {
    return;
  }

  clearTimeout(bot.outboxTimer);
  bot.outboxTimer = null;
}

function scheduleOutboxDrain(bot, nextRetryAt) {
  bot.clearOutboxTimer();

  const delay = nextRetryAt - bot.now();
  if (delay <= 0) {
    bot.runSafely('outbox_drain_immediate', async () => {
      await bot.drainOutboxQueue();
    });
    return;
  }

  const timeoutDelay = Math.min(delay, MAX_TIMEOUT_MS);
  bot.outboxTimer = setTimeout(() => {
    const remaining = nextRetryAt - bot.now();
    if (remaining > 0) {
      bot.scheduleOutboxDrain(nextRetryAt);
      return;
    }

    bot.runSafely('outbox_drain', async () => {
      await bot.drainOutboxQueue();
    });
  }, timeoutDelay);
}

function refreshOutboxSchedule(bot) {
  const nextRetryAt = bot.db.getNextOutboxRetryAt(bot.config.groupId);
  if (nextRetryAt === null) {
    bot.clearOutboxTimer();
    return;
  }

  bot.scheduleOutboxDrain(nextRetryAt);
}

async function recoverOutboxMessages(bot) {
  const retryableCount = bot.db.countRetryableOutboxMessages(bot.config.groupId);
  if (retryableCount <= 0) {
    return;
  }

  log('INFO', 'Recovering pending outbox messages from SQLite.', {
    count: retryableCount
  });

  await bot.drainOutboxQueue();
}

async function sendOutboxPayload(bot, payload) {
  if (!payload || payload.kind !== 'group-text' || typeof payload.text !== 'string') {
    throw new Error('Unsupported outbox payload.');
  }

  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new OutboxSendTimeoutError(bot.outboxSendTimeoutMs));
    }, bot.outboxSendTimeoutMs);
  });

  try {
    await Promise.race([bot.sendGroupMessage(payload.text), timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function deliverOutboxMessage(bot, outboxMessage) {
  const startedAt = bot.now();

  try {
    await bot.sendOutboxPayload(outboxMessage.payload);
    bot.db.markOutboxSent({
      outboxId: outboxMessage.id,
      sentAt: bot.now()
    });

    log('INFO', 'Outbox message delivered.', {
      outboxId: outboxMessage.id,
      attempts: outboxMessage.attemptCount + 1
    });
  } catch (error) {
    const attemptCount = outboxMessage.attemptCount + 1;
    if (isOutboxSendTimeoutError(error)) {
      bot.observability.recordOutboxFailure(false);
      bot.db.markOutboxAmbiguous({
        outboxId: outboxMessage.id,
        attemptCount,
        lastError: error.message
      });

      log(
        'ERROR',
        'Outbox delivery timed out; message state is ambiguous and will not be retried automatically.',
        errorMetadata(error, {
          outboxId: outboxMessage.id,
          attemptCount,
          maxAttempts: outboxMessage.maxAttempts
        })
      );
      return;
    }

    const exhausted = attemptCount >= outboxMessage.maxAttempts;
    const retryDelayMs = bot.getOutboxRetryDelayMs(attemptCount);
    const nextRetryAt = exhausted ? startedAt : startedAt + retryDelayMs;
    bot.observability.recordOutboxFailure(!exhausted);

    bot.db.markOutboxFailed({
      outboxId: outboxMessage.id,
      attemptCount,
      nextRetryAt,
      lastError: error instanceof Error ? error.message : String(error)
    });

    const level = exhausted ? 'ERROR' : 'WARN';
    const message = exhausted
      ? 'Outbox delivery exhausted max attempts.'
      : 'Outbox delivery failed; retry scheduled.';
    log(
      level,
      message,
      errorMetadata(error, {
        outboxId: outboxMessage.id,
        attemptCount,
        maxAttempts: outboxMessage.maxAttempts,
        nextRetryAt: exhausted ? null : nextRetryAt
      })
    );
  }
}

async function drainOutboxQueue(bot) {
  if (bot.outboxDrainInProgress) {
    return;
  }

  bot.outboxDrainInProgress = true;

  try {
    while (true) {
      const dueMessages = bot.db.listDueOutboxMessages(
        bot.config.groupId,
        bot.now(),
        OUTBOX_BATCH_SIZE
      );
      if (dueMessages.length === 0) {
        break;
      }

      for (const outboxMessage of dueMessages) {
        await bot.deliverOutboxMessage(outboxMessage);
      }
    }
  } finally {
    bot.outboxDrainInProgress = false;
    bot.refreshOutboxSchedule();
  }
}

module.exports = {
  buildOutboxTextMessage,
  clearOutboxTimer,
  deliverOutboxMessage,
  drainOutboxQueue,
  getOutboxRetryDelayMs,
  recoverOutboxMessages,
  refreshOutboxSchedule,
  scheduleOutboxDrain,
  sendOutboxPayload
};

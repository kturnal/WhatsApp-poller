const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { PollDatabase } = require('../../src/db');

test('outbox selectors omit exhausted and terminal rows', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-poller-outbox-selectors-'));
  const dbPath = path.join(tempDir, 'polls.sqlite');
  const groupId = '1234567890-123456789@g.us';
  const now = Date.now();

  const pollDb = new PollDatabase(dbPath);

  const duePendingId = pollDb.createOutboxMessage({
    groupId,
    payload: { kind: 'group-text', text: 'pending due' },
    maxAttempts: 3,
    createdAt: now - 1000,
    nextRetryAt: now - 500,
    status: 'PENDING',
    attemptCount: 0
  });

  const dueFailedRetryableId = pollDb.createOutboxMessage({
    groupId,
    payload: { kind: 'group-text', text: 'failed retryable due' },
    maxAttempts: 3,
    createdAt: now - 1000,
    nextRetryAt: now - 200,
    status: 'FAILED',
    attemptCount: 1
  });

  pollDb.createOutboxMessage({
    groupId,
    payload: { kind: 'group-text', text: 'failed exhausted due' },
    maxAttempts: 2,
    createdAt: now - 1000,
    nextRetryAt: now - 100,
    status: 'FAILED',
    attemptCount: 2
  });

  pollDb.createOutboxMessage({
    groupId,
    payload: { kind: 'group-text', text: 'sent terminal row' },
    maxAttempts: 3,
    createdAt: now - 1000,
    nextRetryAt: now - 50,
    status: 'SENT',
    attemptCount: 0,
    sentAt: now - 25
  });

  const dueRows = pollDb.listDueOutboxMessages(groupId, now, 10);
  assert.deepEqual(
    dueRows.map((row) => row.id),
    [duePendingId, dueFailedRetryableId]
  );

  const retryableCount = pollDb.countRetryableOutboxMessages(groupId);
  assert.equal(retryableCount, 2);

  pollDb.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

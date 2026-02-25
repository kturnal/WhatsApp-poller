const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { PollDatabase } = require('../../src/db');

function createLegacyDatabase(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE polls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id TEXT NOT NULL,
      week_key TEXT NOT NULL UNIQUE,
      poll_message_id TEXT NOT NULL UNIQUE,
      question TEXT NOT NULL,
      options_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      closes_at INTEGER NOT NULL,
      closed_at INTEGER,
      close_reason TEXT,
      tie_deadline_at INTEGER,
      tie_option_indices_json TEXT,
      winning_option_idx INTEGER,
      winner_vote_count INTEGER,
      announced_at INTEGER
    );

    CREATE TABLE poll_votes (
      poll_id INTEGER NOT NULL,
      voter_jid TEXT NOT NULL,
      selected_options_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (poll_id, voter_jid),
      FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE
    );
  `);

  db.prepare(
    `
      INSERT INTO polls (
        group_id,
        week_key,
        poll_message_id,
        question,
        options_json,
        status,
        created_at,
        closes_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `
  ).run(
    '1234567890-123456789@g.us',
    '2026-W08',
    'legacy-message-id',
    'legacy-question',
    JSON.stringify([{ label: 'Mon 20:00', localId: 'opt-0' }]),
    'OPEN',
    1700000000000,
    1700003600000
  );

  db.close();
}

test('legacy polls uniqueness migrates to group-scoped indexes', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-poller-migration-'));
  const dbPath = path.join(tempDir, 'polls.sqlite');

  createLegacyDatabase(dbPath);

  const pollDb = new PollDatabase(dbPath);

  const indexes = pollDb.db.prepare("PRAGMA index_list('polls')").all();
  const groupWeekIndex = indexes.find((index) => index.name === 'idx_polls_group_week_unique');
  const groupMessageIndex = indexes.find(
    (index) => index.name === 'idx_polls_group_message_unique'
  );

  assert.ok(groupWeekIndex, 'group/week unique index should exist');
  assert.ok(groupMessageIndex, 'group/message unique index should exist');

  const groupWeekColumns = pollDb.db
    .prepare("PRAGMA index_info('idx_polls_group_week_unique')")
    .all()
    .map((row) => row.name);

  const groupMessageColumns = pollDb.db
    .prepare("PRAGMA index_info('idx_polls_group_message_unique')")
    .all()
    .map((row) => row.name);

  assert.deepEqual(groupWeekColumns, ['group_id', 'week_key']);
  assert.deepEqual(groupMessageColumns, ['group_id', 'poll_message_id']);

  const poll = pollDb.getPollByWeekKey('1234567890-123456789@g.us', '2026-W08');
  assert.ok(poll);
  assert.equal(poll.pollMessageId, 'legacy-message-id');

  pollDb.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const POLLS_COLUMNS = `
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL,
  week_key TEXT NOT NULL,
  poll_message_id TEXT NOT NULL,
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
`;

class PollDatabase {
  constructor(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.#initSchema();
  }

  #pollTableSql(tableName = 'polls') {
    return `
      CREATE TABLE IF NOT EXISTS ${tableName} (
        ${POLLS_COLUMNS}
      );
    `;
  }

  #pollVotesTableSql(tableName = 'poll_votes') {
    return `
      CREATE TABLE IF NOT EXISTS ${tableName} (
        poll_id INTEGER NOT NULL,
        voter_jid TEXT NOT NULL,
        selected_options_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (poll_id, voter_jid),
        FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE
      );
    `;
  }

  #createIndexes() {
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_polls_group_week_unique
        ON polls(group_id, week_key);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_polls_group_message_unique
        ON polls(group_id, poll_message_id);
      CREATE INDEX IF NOT EXISTS idx_polls_group_status
        ON polls(group_id, status);
      CREATE INDEX IF NOT EXISTS idx_polls_group_closes_at
        ON polls(group_id, closes_at);
      CREATE INDEX IF NOT EXISTS idx_poll_votes_poll_id
        ON poll_votes(poll_id);
    `);
  }

  #tableExists(name) {
    const stmt = this.db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1`
    );
    return Boolean(stmt.get(name));
  }

  #isLegacyUniqueIndex(columns) {
    return (
      (columns.length === 1 && columns[0] === 'week_key') ||
      (columns.length === 1 && columns[0] === 'poll_message_id')
    );
  }

  #needsGroupScopedMigration() {
    if (!this.#tableExists('polls')) {
      return false;
    }

    const indexes = this.db.prepare("PRAGMA index_list('polls')").all();
    for (const index of indexes) {
      if (!index.unique) {
        continue;
      }

      const indexName = index.name.replace(/'/g, "''");
      const columns = this.db
        .prepare(`PRAGMA index_info('${indexName}')`)
        .all()
        .map((row) => row.name);

      if (this.#isLegacyUniqueIndex(columns)) {
        return true;
      }
    }

    return false;
  }

  #migrateToGroupScopedUniqueness() {
    this.db.exec('PRAGMA foreign_keys = OFF');
    this.db.exec('BEGIN IMMEDIATE');

    try {
      this.db.exec(`
        ALTER TABLE polls RENAME TO polls_legacy;
        ALTER TABLE poll_votes RENAME TO poll_votes_legacy;

        ${this.#pollTableSql('polls')}
        ${this.#pollVotesTableSql('poll_votes')}

        INSERT INTO polls (
          id,
          group_id,
          week_key,
          poll_message_id,
          question,
          options_json,
          status,
          created_at,
          closes_at,
          closed_at,
          close_reason,
          tie_deadline_at,
          tie_option_indices_json,
          winning_option_idx,
          winner_vote_count,
          announced_at
        )
        SELECT
          id,
          group_id,
          week_key,
          poll_message_id,
          question,
          options_json,
          status,
          created_at,
          closes_at,
          closed_at,
          close_reason,
          tie_deadline_at,
          tie_option_indices_json,
          winning_option_idx,
          winner_vote_count,
          announced_at
        FROM polls_legacy;

        INSERT INTO poll_votes (poll_id, voter_jid, selected_options_json, updated_at)
        SELECT poll_id, voter_jid, selected_options_json, updated_at
        FROM poll_votes_legacy;

        DROP TABLE poll_votes_legacy;
        DROP TABLE polls_legacy;
      `);

      this.db.exec('COMMIT');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Ignore rollback errors and rethrow original migration failure below.
      }
      throw error;
    } finally {
      this.db.exec('PRAGMA foreign_keys = ON');
    }
  }

  #initSchema() {
    if (!this.#tableExists('polls')) {
      this.db.exec(this.#pollTableSql('polls'));
      this.db.exec(this.#pollVotesTableSql('poll_votes'));
      this.#createIndexes();
      return;
    }

    if (!this.#tableExists('poll_votes')) {
      this.db.exec(this.#pollVotesTableSql('poll_votes'));
    }

    if (this.#needsGroupScopedMigration()) {
      this.#migrateToGroupScopedUniqueness();
    }

    this.#createIndexes();
  }

  #parseJsonField(raw, fieldName, rowIdentifier) {
    try {
      return JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `Failed to parse ${fieldName} for ${rowIdentifier}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  #mapPoll(row) {
    if (!row) {
      return null;
    }

    return {
      id: row.id,
      groupId: row.group_id,
      weekKey: row.week_key,
      pollMessageId: row.poll_message_id,
      question: row.question,
      options: this.#parseJsonField(row.options_json, 'options_json', `poll id=${row.id}`),
      status: row.status,
      createdAt: row.created_at,
      closesAt: row.closes_at,
      closedAt: row.closed_at,
      closeReason: row.close_reason,
      tieDeadlineAt: row.tie_deadline_at,
      tieOptionIndices: row.tie_option_indices_json
        ? this.#parseJsonField(
            row.tie_option_indices_json,
            'tie_option_indices_json',
            `poll id=${row.id}`
          )
        : [],
      winningOptionIdx: row.winning_option_idx,
      winnerVoteCount: row.winner_vote_count,
      announcedAt: row.announced_at
    };
  }

  #mapVote(row) {
    return {
      pollId: row.poll_id,
      voterJid: row.voter_jid,
      selectedOptions: this.#parseJsonField(
        row.selected_options_json,
        'selected_options_json',
        `vote poll_id=${row.poll_id}, voter_jid=${row.voter_jid}`
      ),
      updatedAt: row.updated_at
    };
  }

  createPoll({ groupId, weekKey, pollMessageId, question, options, createdAt, closesAt }) {
    const stmt = this.db.prepare(`
      INSERT INTO polls (
        group_id,
        week_key,
        poll_message_id,
        question,
        options_json,
        status,
        created_at,
        closes_at
      ) VALUES (?, ?, ?, ?, ?, 'OPEN', ?, ?)
    `);

    const result = stmt.run(
      groupId,
      weekKey,
      pollMessageId,
      question,
      JSON.stringify(options),
      createdAt,
      closesAt
    );

    return Number(result.lastInsertRowid);
  }

  getPollById(pollId) {
    const stmt = this.db.prepare('SELECT * FROM polls WHERE id = ? LIMIT 1');
    return this.#mapPoll(stmt.get(pollId));
  }

  getPollByWeekKey(groupId, weekKey) {
    const stmt = this.db.prepare('SELECT * FROM polls WHERE group_id = ? AND week_key = ? LIMIT 1');
    return this.#mapPoll(stmt.get(groupId, weekKey));
  }

  getPollByMessageId(groupId, messageId) {
    const stmt = this.db.prepare(
      'SELECT * FROM polls WHERE group_id = ? AND poll_message_id = ? LIMIT 1'
    );
    return this.#mapPoll(stmt.get(groupId, messageId));
  }

  getActivePoll(groupId) {
    const stmt = this.db.prepare(`
      SELECT *
      FROM polls
      WHERE group_id = ?
        AND status IN ('OPEN', 'TIE_PENDING')
      ORDER BY created_at DESC
      LIMIT 1
    `);

    return this.#mapPoll(stmt.get(groupId));
  }

  getLatestPoll(groupId) {
    const stmt = this.db.prepare(
      'SELECT * FROM polls WHERE group_id = ? ORDER BY created_at DESC LIMIT 1'
    );
    return this.#mapPoll(stmt.get(groupId));
  }

  listRecoverablePolls(groupId) {
    const stmt = this.db.prepare(`
      SELECT *
      FROM polls
      WHERE group_id = ?
        AND status IN ('OPEN', 'TIE_PENDING')
      ORDER BY created_at ASC
    `);

    return stmt.all(groupId).map((row) => this.#mapPoll(row));
  }

  upsertVote({ pollId, voterJid, selectedOptions, updatedAt }) {
    const stmt = this.db.prepare(`
      INSERT INTO poll_votes (poll_id, voter_jid, selected_options_json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(poll_id, voter_jid)
      DO UPDATE SET
        selected_options_json = excluded.selected_options_json,
        updated_at = excluded.updated_at
    `);

    stmt.run(pollId, voterJid, JSON.stringify(selectedOptions), updatedAt);
  }

  getVotesByPollId(pollId) {
    const stmt = this.db.prepare('SELECT * FROM poll_votes WHERE poll_id = ?');
    return stmt.all(pollId).map((row) => this.#mapVote(row));
  }

  setTiePending({ pollId, closeReason, closedAt, tieDeadlineAt, tieOptionIndices }) {
    const stmt = this.db.prepare(`
      UPDATE polls
      SET
        status = 'TIE_PENDING',
        closed_at = ?,
        close_reason = ?,
        tie_deadline_at = ?,
        tie_option_indices_json = ?,
        winning_option_idx = NULL,
        winner_vote_count = NULL,
        announced_at = NULL
      WHERE id = ?
    `);

    stmt.run(closedAt, closeReason, tieDeadlineAt, JSON.stringify(tieOptionIndices), pollId);
  }

  setAnnounced({ pollId, closeReason, closedAt = null, announcedAt, winnerIdx, winnerVotes }) {
    const stmt = this.db.prepare(`
      UPDATE polls
      SET
        status = 'ANNOUNCED',
        closed_at = COALESCE(closed_at, ?),
        close_reason = ?,
        tie_deadline_at = NULL,
        tie_option_indices_json = NULL,
        winning_option_idx = ?,
        winner_vote_count = ?,
        announced_at = ?
      WHERE id = ?
    `);

    stmt.run(closedAt, closeReason, winnerIdx, winnerVotes, announcedAt, pollId);
  }

  close() {
    if (!this.db) {
      return;
    }

    this.db.close();
    this.db = null;
  }
}

module.exports = {
  PollDatabase
};

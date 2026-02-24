const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

class PollDatabase {
  constructor(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.#initSchema();
  }

  #initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS polls (
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

      CREATE TABLE IF NOT EXISTS poll_votes (
        poll_id INTEGER NOT NULL,
        voter_jid TEXT NOT NULL,
        selected_options_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (poll_id, voter_jid),
        FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_polls_status ON polls(status);
      CREATE INDEX IF NOT EXISTS idx_polls_closes_at ON polls(closes_at);
      CREATE INDEX IF NOT EXISTS idx_poll_votes_poll_id ON poll_votes(poll_id);
    `);
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
      options: JSON.parse(row.options_json),
      status: row.status,
      createdAt: row.created_at,
      closesAt: row.closes_at,
      closedAt: row.closed_at,
      closeReason: row.close_reason,
      tieDeadlineAt: row.tie_deadline_at,
      tieOptionIndices: row.tie_option_indices_json ? JSON.parse(row.tie_option_indices_json) : [],
      winningOptionIdx: row.winning_option_idx,
      winnerVoteCount: row.winner_vote_count,
      announcedAt: row.announced_at
    };
  }

  #mapVote(row) {
    return {
      pollId: row.poll_id,
      voterJid: row.voter_jid,
      selectedOptions: JSON.parse(row.selected_options_json),
      updatedAt: row.updated_at
    };
  }

  createPoll({
    groupId,
    weekKey,
    pollMessageId,
    question,
    options,
    createdAt,
    closesAt
  }) {
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

  getPollByWeekKey(weekKey) {
    const stmt = this.db.prepare('SELECT * FROM polls WHERE week_key = ? LIMIT 1');
    return this.#mapPoll(stmt.get(weekKey));
  }

  getPollByMessageId(messageId) {
    const stmt = this.db.prepare('SELECT * FROM polls WHERE poll_message_id = ? LIMIT 1');
    return this.#mapPoll(stmt.get(messageId));
  }

  getActivePoll() {
    const stmt = this.db.prepare(`
      SELECT *
      FROM polls
      WHERE status IN ('OPEN', 'TIE_PENDING')
      ORDER BY created_at DESC
      LIMIT 1
    `);

    return this.#mapPoll(stmt.get());
  }

  getLatestPoll() {
    const stmt = this.db.prepare('SELECT * FROM polls ORDER BY created_at DESC LIMIT 1');
    return this.#mapPoll(stmt.get());
  }

  listRecoverablePolls() {
    const stmt = this.db.prepare(`
      SELECT *
      FROM polls
      WHERE status IN ('OPEN', 'TIE_PENDING')
      ORDER BY created_at ASC
    `);

    return stmt.all().map((row) => this.#mapPoll(row));
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

    stmt.run(
      closedAt,
      closeReason,
      tieDeadlineAt,
      JSON.stringify(tieOptionIndices),
      pollId
    );
  }

  setAnnounced({ pollId, closeReason, closedAt, announcedAt, winnerIdx, winnerVotes }) {
    const stmt = this.db.prepare(`
      UPDATE polls
      SET
        status = 'ANNOUNCED',
        closed_at = ?,
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
}

module.exports = {
  PollDatabase
};

require('dotenv').config();

const path = require('node:path');
const cron = require('node-cron');
const qrcodeTerminal = require('qrcode-terminal');
const { DateTime } = require('luxon');
const { Client, LocalAuth, Poll } = require('whatsapp-web.js');

const { loadConfig, normalizeJid } = require('./config');
const { PollDatabase } = require('./db');
const { errorMetadata, log, setLogOptions } = require('./logger');
const { BotObservability } = require('./observability');
const {
  buildOptionsForWeek,
  currentWeekContext,
  formatWeekDateRangeLabel,
  scheduledWeeklyRunForWeek
} = require('./poll-slots');
const { enforceSecureRuntimePermissions } = require('./runtime-security');
const { resolveStartupWeekSelection } = require('./startup-week-selector');

const MAX_TIMEOUT_MS = 2 ** 31 - 1;
const MAX_COMMAND_TOKENS = 6;
const OUTBOX_BATCH_SIZE = 20;
const DEFAULT_OUTBOX_MAX_ATTEMPTS = 5;
const DEFAULT_OUTBOX_RETRY_BASE_MS = 30 * 1000;
const DEFAULT_OUTBOX_RETRY_MAX_MS = 30 * 60 * 1000;
const DEFAULT_OUTBOX_SEND_TIMEOUT_MS = 30 * 1000;

/**
 * Extracts a normalized message identifier from a message object.
 * @param {object} message - Message object that may contain an `id` field.
 * @returns {string|null} A string identifier for the message if present, `null` otherwise.
 */
function serializeMessageId(message) {
  if (!message || !message.id) {
    return null;
  }

  return serializeMessageKey(message.id);
}

/**
 * Normalize various message-key shapes into a single serialized identifier.
 *
 * @param {*} key - The message key to normalize; may be a serialized string, an object with an `_serialized` property, an object with an `id` string, or an object whose `id` contains an `_serialized` string.
 * @returns {string|null} The serialized message key when present, otherwise `null`.
 */
function serializeMessageKey(key) {
  if (!key) {
    return null;
  }

  if (typeof key === 'string') {
    return key;
  }

  if (typeof key._serialized === 'string') {
    return key._serialized;
  }

  if (typeof key.id === 'string') {
    return key.id;
  }

  if (key.id && typeof key.id._serialized === 'string') {
    return key.id._serialized;
  }

  return null;
}

/**
 * Derives a normalized parent message identifier from a vote update object.
 * @param {Object} voteUpdate - Object containing one or more message key fields from a vote update event.
 * @returns {string|null} The serialized parent message id if found, or `null` when no valid id is present.
 */
function extractParentMessageId(voteUpdate) {
  const candidates = [
    voteUpdate?.parentMessage?.id,
    voteUpdate?.parentMsgKey,
    voteUpdate?.msgKey,
    voteUpdate?.id
  ];

  for (const candidate of candidates) {
    const serialized = serializeMessageKey(candidate);
    if (serialized) {
      return serialized;
    }
  }

  return null;
}

/**
 * Determine the normalized sender JID from a WhatsApp message object.
 * @param {object} message - The WhatsApp message object (may be partial); commonly checks `author`, `id.participant`, or `from` to locate the sender.
 * @returns {string|null} The normalized sender JID, or `null` if no valid sender is found.
 */
function getMessageSenderJid(message) {
  const sender = message?.author || message?.id?.participant || message?.from;
  if (!sender) {
    return null;
  }

  try {
    return normalizeJid(sender);
  } catch {
    return null;
  }
}

class GameSchedulerBot {
  constructor(config, dependencies = {}) {
    this.config = config;
    this.now = dependencies.now || (() => Date.now());
    this.outboxMaxAttempts =
      Number.isInteger(dependencies.outboxMaxAttempts) && dependencies.outboxMaxAttempts > 0
        ? dependencies.outboxMaxAttempts
        : DEFAULT_OUTBOX_MAX_ATTEMPTS;
    this.outboxRetryBaseMs =
      Number.isInteger(dependencies.outboxRetryBaseMs) && dependencies.outboxRetryBaseMs > 0
        ? dependencies.outboxRetryBaseMs
        : DEFAULT_OUTBOX_RETRY_BASE_MS;
    this.outboxRetryMaxMs =
      Number.isInteger(dependencies.outboxRetryMaxMs) && dependencies.outboxRetryMaxMs > 0
        ? dependencies.outboxRetryMaxMs
        : DEFAULT_OUTBOX_RETRY_MAX_MS;
    this.outboxSendTimeoutMs =
      Number.isInteger(dependencies.outboxSendTimeoutMs) && dependencies.outboxSendTimeoutMs > 0
        ? dependencies.outboxSendTimeoutMs
        : DEFAULT_OUTBOX_SEND_TIMEOUT_MS;

    setLogOptions({
      redactSensitive: this.config.logRedactSensitive,
      includeStack: this.config.logIncludeStack
    });

    this.hardenRuntimePermissions('startup');

    this.db = new PollDatabase(path.join(this.config.dataDir, 'polls.sqlite'));

    this.closeTimers = new Map();
    this.tieTimers = new Map();
    this.pollLocks = new Set();
    this.commandWindows = new Map();
    this.voterAliasMap = new Map();
    this.outboxTimer = null;
    this.outboxDrainInProgress = false;
    this.observability =
      dependencies.observability ||
      new BotObservability({
        port: Number.isInteger(this.config.healthServerPort) ? this.config.healthServerPort : null,
        now: this.now,
        collectRuntimeGauges: () => this.collectRuntimeGauges()
      });

    this.clientFactory =
      dependencies.clientFactory ||
      ((options) => {
        return new Client(options);
      });

    this.pollFactory =
      dependencies.pollFactory ||
      ((question, optionLabels, options) => {
        return new Poll(question, optionLabels, options);
      });
    this.startupWeekSelectionResolver =
      dependencies.startupWeekSelectionResolver || resolveStartupWeekSelection;

    const puppeteerArgs = [];
    if (this.config.allowInsecureChromium) {
      puppeteerArgs.push('--no-sandbox', '--disable-setuid-sandbox');
      log('WARN', 'Chromium sandbox is disabled by ALLOW_INSECURE_CHROMIUM=true.');
    }

    this.client = this.clientFactory({
      authStrategy: new LocalAuth({
        clientId: this.config.clientId,
        dataPath: path.join(this.config.dataDir, 'session')
      }),
      puppeteer: {
        headless: this.config.headless,
        args: puppeteerArgs
      }
    });

    this.cronTask = null;
    this.#bindHandlers();
  }

  hardenRuntimePermissions(context) {
    const remediations = enforceSecureRuntimePermissions(this.config.dataDir);
    if (remediations.length > 0) {
      log('WARN', 'Adjusted runtime file permissions.', {
        context,
        changes: remediations
      });
    }
  }

  #bindHandlers() {
    this.client.on('qr', (qr) => {
      log('INFO', 'QR received. Scan it from WhatsApp app.');
      qrcodeTerminal.generate(qr, { small: true });
    });

    this.client.on('ready', () => {
      this.observability.markClientReady();
      this.observability.markStartupPending();
      this.#safeRun('ready', async () => {
        await this.onReady();
      });
    });

    this.client.on('auth_failure', (message) => {
      this.observability.markClientNotReady();
      log('ERROR', 'Authentication failure.', { message });
    });

    this.client.on('disconnected', (reason) => {
      this.observability.markClientDisconnected();
      log('WARN', 'Client disconnected.', { reason });
    });

    this.client.on('vote_update', (voteUpdate) => {
      this.#safeRun('vote_update', async () => {
        await this.onVoteUpdate(voteUpdate);
      });
    });

    this.client.on('message_create', (message) => {
      this.#safeRun('message_create', async () => {
        await this.onMessageCreate(message);
      });
    });
  }

  #safeRun(source, fn) {
    fn().catch((error) => {
      log('ERROR', `Unhandled error in ${source}.`, errorMetadata(error));
    });
  }

  async withPollLock(pollId, callback) {
    if (this.pollLocks.has(pollId)) {
      return false;
    }

    this.pollLocks.add(pollId);

    try {
      return await callback();
    } finally {
      this.pollLocks.delete(pollId);
    }
  }

  isRateLimited(senderJid) {
    const now = this.now();
    const cutoff = now - this.config.commandRateLimitWindowMs;

    for (const [jid, timestamps] of this.commandWindows.entries()) {
      const filtered = timestamps.filter((timestamp) => timestamp > cutoff);
      if (filtered.length === 0) {
        this.commandWindows.delete(jid);
      } else {
        this.commandWindows.set(jid, filtered);
      }
    }

    const senderTimestamps = this.commandWindows.get(senderJid) || [];

    if (senderTimestamps.length >= this.config.commandRateLimitCount) {
      return true;
    }

    senderTimestamps.push(now);
    this.commandWindows.set(senderJid, senderTimestamps);

    return false;
  }

  collectRuntimeGauges() {
    if (!this.db) {
      return {
        activePolls: 0,
        outboxRetryableMessages: 0
      };
    }

    return {
      activePolls: this.db.getActivePoll(this.config.groupId) ? 1 : 0,
      outboxRetryableMessages: this.db.countRetryableOutboxMessages(this.config.groupId)
    };
  }

  async start() {
    log('INFO', 'Starting WhatsApp scheduler bot.');
    const observabilityPort = await this.observability.start();
    if (observabilityPort !== null) {
      log('INFO', 'Observability HTTP server started.', { port: observabilityPort });
    }

    await this.client.initialize();
  }

  async shutdown(signal) {
    log('INFO', 'Shutting down bot.', { signal });
    this.observability.markShutdownStarted();

    if (this.cronTask) {
      this.cronTask.stop();
      this.cronTask = null;
    }

    for (const timer of this.closeTimers.values()) {
      clearTimeout(timer);
    }
    for (const timer of this.tieTimers.values()) {
      clearTimeout(timer);
    }

    this.closeTimers.clear();
    this.tieTimers.clear();
    this.clearOutboxTimer();

    if (this.db && typeof this.db.close === 'function') {
      try {
        this.db.close();
      } catch (error) {
        log('ERROR', 'Failed to close SQLite database.', errorMetadata(error));
      }
    }

    let destroyError = null;
    try {
      await this.client.destroy();
    } catch (error) {
      destroyError = error;
    }

    try {
      await this.observability.stop();
    } catch (error) {
      log('ERROR', 'Failed to stop observability HTTP server.', errorMetadata(error));
      if (!destroyError) {
        destroyError = error;
      }
    }

    if (destroyError) {
      throw destroyError;
    }
  }

  async onReady() {
    await this.client.getChatById(this.config.groupId);
    this.hardenRuntimePermissions('post-ready');

    const weekSelectionMode = this.config.weekSelectionMode || 'auto';

    log('INFO', 'WhatsApp client is ready.', {
      groupId: this.config.groupId,
      timezone: this.config.timezone,
      weekSelectionMode
    });

    await this.reconcilePendingPollVotes();
    this.recoverPendingPolls();
    await this.recoverOutboxMessages();

    if (weekSelectionMode === 'auto') {
      this.startCronIfNeeded();
      await this.createCurrentWeekPollIfMissed();
    } else {
      await this.createStartupSelectedWeekPollIfNeeded();
    }

    this.observability.markStartupComplete();
  }

  startCronIfNeeded() {
    if (this.cronTask) {
      return;
    }

    if (!cron.validate(this.config.pollCron)) {
      throw new Error(`Invalid cron expression for POLL_CRON: ${this.config.pollCron}`);
    }

    this.cronTask = cron.schedule(
      this.config.pollCron,
      () => {
        this.#safeRun('weekly_cron', async () => {
          await this.createWeeklyPollIfNeeded('cron');
        });
      },
      { timezone: this.config.timezone }
    );

    log('INFO', 'Weekly cron scheduled.', {
      pollCron: this.config.pollCron,
      timezone: this.config.timezone
    });
  }

  recoverPendingPolls() {
    const pendingPolls = this.db.listRecoverablePolls(this.config.groupId);

    if (pendingPolls.length === 0) {
      return;
    }

    log('INFO', 'Recovering pending polls from SQLite.', { count: pendingPolls.length });

    for (const poll of pendingPolls) {
      if (poll.status === 'OPEN') {
        this.scheduleCloseTimer(poll.id, poll.closesAt);
      } else if (poll.status === 'TIE_PENDING') {
        this.scheduleTieTimer(poll.id, poll.tieDeadlineAt);
      }
    }
  }

  async reconcilePendingPollVotes() {
    if (typeof this.client.getPollVotes !== 'function') {
      log('WARN', 'Skipping startup vote reconciliation: client.getPollVotes is unavailable.');
      return;
    }

    const pendingPolls = this.db.listRecoverablePolls(this.config.groupId);
    if (pendingPolls.length === 0) {
      return;
    }

    log('INFO', 'Reconciling active poll votes from WhatsApp.', { count: pendingPolls.length });

    for (const poll of pendingPolls) {
      await this.reconcilePollVotes(poll);
    }
  }

  async reconcilePollVotes(poll) {
    let pollVotes;

    try {
      pollVotes = await this.client.getPollVotes(poll.pollMessageId);
    } catch (error) {
      log(
        'ERROR',
        'Failed to fetch poll votes during startup reconciliation.',
        errorMetadata(error, {
          pollId: poll.id,
          pollMessageId: poll.pollMessageId,
          pollStatus: poll.status
        })
      );
      return;
    }

    const stats = {
      fetchedVotes: pollVotes.length,
      upsertedVotes: 0,
      skippedMissingVoter: 0,
      skippedInvalidVoter: 0,
      skippedNotAllowlisted: 0,
      skippedInvalidSelectionOnly: 0,
      discardedSelectionIds: 0
    };

    for (const pollVote of pollVotes) {
      const normalized = await this.normalizeVoteUpdateForPoll(poll, pollVote);
      if (normalized.status !== 'ok') {
        if (normalized.reason === 'missing_voter') {
          stats.skippedMissingVoter += 1;
        } else if (normalized.reason === 'invalid_voter') {
          stats.skippedInvalidVoter += 1;
        } else if (normalized.reason === 'not_allowlisted') {
          stats.skippedNotAllowlisted += 1;
        }
        continue;
      }

      if (normalized.discardedLocalIds.length > 0) {
        stats.discardedSelectionIds += normalized.discardedLocalIds.length;
        log('WARN', 'Discarded unmatched vote selection localIds during reconciliation.', {
          pollId: poll.id,
          voterJid: normalized.voterJid,
          discardedLocalIds: normalized.discardedLocalIds
        });
      }

      if (normalized.selectedOptions.length === 0 && normalized.discardedLocalIds.length > 0) {
        stats.skippedInvalidSelectionOnly += 1;
        continue;
      }

      this.db.upsertVote({
        pollId: poll.id,
        voterJid: normalized.voterJid,
        selectedOptions: normalized.selectedOptions,
        updatedAt: this.now()
      });
      stats.upsertedVotes += 1;
    }

    const summary = this.summarizePoll(poll);
    log('INFO', 'Startup poll reconciliation complete.', {
      pollId: poll.id,
      pollStatus: poll.status,
      ...stats,
      uniqueVoterCount: summary.uniqueVoterCount,
      requiredVoters: this.config.requiredVoters,
      maxVotes: summary.maxVotes
    });

    if (poll.status === 'OPEN' && summary.uniqueVoterCount >= this.config.requiredVoters) {
      await this.closePoll(poll.id, 'quorum');
    }
  }

  async createCurrentWeekPollIfMissed() {
    const { now, weekYear, weekNumber, weekKey } = currentWeekContext(this.config.timezone);
    const scheduledTime = scheduledWeeklyRunForWeek(this.config.timezone, weekYear, weekNumber);

    if (now < scheduledTime) {
      return;
    }

    const existing = this.db.getPollByWeekKey(this.config.groupId, weekKey);
    if (existing) {
      return;
    }

    const active = this.db.getActivePoll(this.config.groupId);
    if (active) {
      log('INFO', 'Skipping catch-up poll creation because an active poll exists.', {
        activePollId: active.id,
        activeStatus: active.status
      });
      return;
    }

    await this.createWeeklyPollIfNeeded('startup-catchup');
  }

  async createStartupSelectedWeekPollIfNeeded() {
    const active = this.db.getActivePoll(this.config.groupId);
    if (active) {
      log('INFO', 'Skipping interactive startup week selection because an active poll exists.', {
        activePollId: active.id,
        activeStatus: active.status
      });
      return;
    }

    const selection = await this.startupWeekSelectionResolver({
      config: this.config,
      db: this.db,
      nowMillis: this.now()
    });

    if (!selection) {
      return;
    }

    const weekLabel =
      selection.weekLabel ||
      formatWeekDateRangeLabel(this.config.timezone, selection.weekYear, selection.weekNumber);

    if (selection.action === 'skip') {
      log('INFO', 'Startup week selection skipped poll creation for existing week.', {
        weekKey: selection.weekKey,
        weekLabel
      });
      return;
    }

    if (selection.action === 'replace' && Number.isInteger(selection.existingPollId)) {
      this.clearTimer(this.closeTimers, selection.existingPollId);
      this.clearTimer(this.tieTimers, selection.existingPollId);
    }

    await this.createPollForWeek({
      trigger:
        selection.action === 'replace' ? 'startup-interactive-replace' : 'startup-interactive',
      weekYear: selection.weekYear,
      weekNumber: selection.weekNumber,
      weekKey: selection.weekKey,
      replacePollId:
        selection.action === 'replace' && Number.isInteger(selection.existingPollId)
          ? selection.existingPollId
          : null
    });
  }

  async createWeeklyPollIfNeeded(trigger) {
    const active = this.db.getActivePoll(this.config.groupId);
    if (active) {
      log('INFO', 'Skipping weekly poll creation because an active poll exists.', {
        activePollId: active.id,
        activeStatus: active.status,
        trigger
      });
      return;
    }

    const { now, weekYear, weekNumber, weekKey } = currentWeekContext(this.config.timezone);
    const existingThisWeek = this.db.getPollByWeekKey(this.config.groupId, weekKey);

    if (existingThisWeek) {
      log('INFO', 'Weekly poll already exists for week key.', {
        weekKey,
        existingPollId: existingThisWeek.id,
        status: existingThisWeek.status,
        trigger
      });
      return;
    }

    await this.createPollForWeek({
      trigger,
      weekYear,
      weekNumber,
      weekKey,
      replacePollId: null,
      createdAt: now.toMillis()
    });
  }

  async createPollForWeek({
    trigger,
    weekYear,
    weekNumber,
    weekKey,
    replacePollId = null,
    createdAt
  }) {
    const options = buildOptionsForWeek(
      this.config.timezone,
      weekYear,
      weekNumber,
      this.config.slotTemplate
    );
    const optionLabels = options.map((option) => option.label);
    let pollMessageId = null;

    try {
      const chat = await this.client.getChatById(this.config.groupId);
      const sentMessage = await chat.sendMessage(
        this.pollFactory(this.config.pollQuestion, optionLabels, { allowMultipleAnswers: true })
      );

      pollMessageId = serializeMessageId(sentMessage);
      if (!pollMessageId) {
        throw new Error('Could not serialize poll message id from sent message.');
      }

      const optionsWithLocalIds = options.map((option, index) => {
        const sentOptionLocalId = sentMessage?.pollOptions?.[index]?.localId;
        return {
          ...option,
          localId: String(sentOptionLocalId ?? option.index ?? index)
        };
      });

      const createdAtMillis = Number.isInteger(createdAt) ? createdAt : this.now();
      const pollId = Number.isInteger(replacePollId) ? replacePollId : null;
      const closesAt = createdAtMillis + this.config.pollCloseHours * 60 * 60 * 1000;

      if (pollId === null) {
        const newPollId = this.db.createPoll({
          groupId: this.config.groupId,
          weekKey,
          pollMessageId,
          question: this.config.pollQuestion,
          options: optionsWithLocalIds,
          createdAt: createdAtMillis,
          closesAt
        });

        this.scheduleCloseTimer(newPollId, closesAt);
        this.observability.recordPollCreated();

        log('INFO', 'Weekly poll created.', {
          pollId: newPollId,
          pollMessageId,
          weekKey,
          closesAt,
          trigger
        });
      } else {
        this.db.replacePollInPlace({
          pollId,
          pollMessageId,
          question: this.config.pollQuestion,
          options: optionsWithLocalIds,
          createdAt: createdAtMillis,
          closesAt
        });

        this.scheduleCloseTimer(pollId, closesAt);
        this.observability.recordPollCreated();

        log('INFO', 'Weekly poll replaced in place.', {
          pollId,
          pollMessageId,
          weekKey,
          closesAt,
          trigger
        });
      }
    } catch (error) {
      if (pollMessageId) {
        log(
          'ERROR',
          'Poll was sent but failed to persist in SQLite.',
          errorMetadata(error, {
            weekKey,
            pollMessageId,
            replacePollId,
            trigger
          })
        );
      }
      throw error;
    }
  }

  scheduleCloseTimer(pollId, closesAt) {
    this.clearTimer(this.closeTimers, pollId);

    const delay = closesAt - this.now();

    if (delay <= 0) {
      this.#safeRun('close_timer_immediate', async () => {
        await this.closePoll(pollId, 'deadline');
      });
      return;
    }

    const timeoutDelay = Math.min(delay, MAX_TIMEOUT_MS);
    const timeout = setTimeout(() => {
      const remaining = closesAt - this.now();
      if (remaining > 0) {
        this.scheduleCloseTimer(pollId, closesAt);
        return;
      }

      this.#safeRun('close_timer', async () => {
        await this.closePoll(pollId, 'deadline');
      });
    }, timeoutDelay);

    this.closeTimers.set(pollId, timeout);
  }

  scheduleTieTimer(pollId, tieDeadlineAt) {
    this.clearTimer(this.tieTimers, pollId);

    const delay = tieDeadlineAt - this.now();

    if (delay <= 0) {
      this.#safeRun('tie_timer_immediate', async () => {
        await this.handleTieTimeout(pollId);
      });
      return;
    }

    const timeoutDelay = Math.min(delay, MAX_TIMEOUT_MS);
    const timeout = setTimeout(() => {
      const remaining = tieDeadlineAt - this.now();
      if (remaining > 0) {
        this.scheduleTieTimer(pollId, tieDeadlineAt);
        return;
      }

      this.#safeRun('tie_timer', async () => {
        await this.handleTieTimeout(pollId);
      });
    }, timeoutDelay);

    this.tieTimers.set(pollId, timeout);
  }

  clearTimer(timerMap, pollId) {
    const timer = timerMap.get(pollId);

    if (timer) {
      clearTimeout(timer);
      timerMap.delete(pollId);
    }
  }

  buildOutboxTextMessage(text, createdAt = this.now()) {
    return {
      groupId: this.config.groupId,
      payload: {
        kind: 'group-text',
        text
      },
      status: 'PENDING',
      attemptCount: 0,
      maxAttempts: this.outboxMaxAttempts,
      createdAt,
      nextRetryAt: createdAt,
      lastError: null
    };
  }

  getOutboxRetryDelayMs(attemptCount) {
    const growth = 2 ** Math.max(0, attemptCount - 1);
    return Math.min(this.outboxRetryBaseMs * growth, this.outboxRetryMaxMs);
  }

  clearOutboxTimer() {
    if (!this.outboxTimer) {
      return;
    }

    clearTimeout(this.outboxTimer);
    this.outboxTimer = null;
  }

  scheduleOutboxDrain(nextRetryAt) {
    this.clearOutboxTimer();

    const delay = nextRetryAt - this.now();
    if (delay <= 0) {
      this.#safeRun('outbox_drain_immediate', async () => {
        await this.drainOutboxQueue();
      });
      return;
    }

    const timeoutDelay = Math.min(delay, MAX_TIMEOUT_MS);
    this.outboxTimer = setTimeout(() => {
      const remaining = nextRetryAt - this.now();
      if (remaining > 0) {
        this.scheduleOutboxDrain(nextRetryAt);
        return;
      }

      this.#safeRun('outbox_drain', async () => {
        await this.drainOutboxQueue();
      });
    }, timeoutDelay);
  }

  refreshOutboxSchedule() {
    const nextRetryAt = this.db.getNextOutboxRetryAt(this.config.groupId);
    if (nextRetryAt === null) {
      this.clearOutboxTimer();
      return;
    }

    this.scheduleOutboxDrain(nextRetryAt);
  }

  async recoverOutboxMessages() {
    const retryableCount = this.db.countRetryableOutboxMessages(this.config.groupId);
    if (retryableCount <= 0) {
      return;
    }

    log('INFO', 'Recovering pending outbox messages from SQLite.', {
      count: retryableCount
    });

    await this.drainOutboxQueue();
  }

  async sendOutboxPayload(payload) {
    if (!payload || payload.kind !== 'group-text' || typeof payload.text !== 'string') {
      throw new Error('Unsupported outbox payload.');
    }

    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`Outbox payload send timed out after ${this.outboxSendTimeoutMs}ms.`));
      }, this.outboxSendTimeoutMs);
    });

    try {
      await Promise.race([this.sendGroupMessage(payload.text), timeoutPromise]);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async deliverOutboxMessage(outboxMessage) {
    const startedAt = this.now();

    try {
      await this.sendOutboxPayload(outboxMessage.payload);
      this.db.markOutboxSent({
        outboxId: outboxMessage.id,
        sentAt: this.now()
      });

      log('INFO', 'Outbox message delivered.', {
        outboxId: outboxMessage.id,
        attempts: outboxMessage.attemptCount + 1
      });
    } catch (error) {
      const attemptCount = outboxMessage.attemptCount + 1;
      const exhausted = attemptCount >= outboxMessage.maxAttempts;
      const retryDelayMs = this.getOutboxRetryDelayMs(attemptCount);
      const nextRetryAt = exhausted ? startedAt : startedAt + retryDelayMs;
      this.observability.recordOutboxFailure(!exhausted);

      this.db.markOutboxFailed({
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

  async drainOutboxQueue() {
    if (this.outboxDrainInProgress) {
      return;
    }

    this.outboxDrainInProgress = true;

    try {
      while (true) {
        const dueMessages = this.db.listDueOutboxMessages(
          this.config.groupId,
          this.now(),
          OUTBOX_BATCH_SIZE
        );
        if (dueMessages.length === 0) {
          break;
        }

        for (const outboxMessage of dueMessages) {
          await this.deliverOutboxMessage(outboxMessage);
        }
      }
    } finally {
      this.outboxDrainInProgress = false;
      this.refreshOutboxSchedule();
    }
  }

  summarizePoll(poll) {
    const votes = this.db.getVotesByPollId(poll.id);
    const counts = new Array(poll.options.length).fill(0);
    let uniqueVoterCount = 0;

    for (const vote of votes) {
      const selected = Array.from(new Set(vote.selectedOptions))
        .filter((value) => Number.isInteger(value))
        .filter((value) => value >= 0 && value < counts.length);

      if (selected.length === 0) {
        continue;
      }

      uniqueVoterCount += 1;
      for (const index of selected) {
        counts[index] += 1;
      }
    }

    const maxVotes = counts.length ? Math.max(...counts) : 0;
    const topIndices = [];

    if (maxVotes > 0) {
      counts.forEach((count, index) => {
        if (count === maxVotes) {
          topIndices.push(index);
        }
      });
    }

    return {
      counts,
      uniqueVoterCount,
      maxVotes,
      topIndices
    };
  }

  mapVoteSelectionsToOptionIndices(poll, selectedOptionsRaw) {
    const discardedLocalIds = [];
    const selectedOptions = Array.from(
      new Set(
        (selectedOptionsRaw || [])
          .map((selection) => {
            const selectedLocalId = selection?.localId;
            if (selectedLocalId === undefined || selectedLocalId === null) {
              discardedLocalIds.push(null);
              return -1;
            }

            const selectedLocalIdText = String(selectedLocalId);
            const optionIndex = poll.options.findIndex((option, index) => {
              const optionLocalId = option?.localId ?? option?.index ?? index;
              return String(optionLocalId) === selectedLocalIdText;
            });

            if (optionIndex === -1) {
              discardedLocalIds.push(selectedLocalIdText);
            }

            return optionIndex;
          })
          .filter((value) => value >= 0)
      )
    ).sort((a, b) => a - b);

    return {
      selectedOptions,
      discardedLocalIds
    };
  }

  async resolveAllowlistedVoterJid(voterRaw, normalizedVoterJid) {
    if (this.config.allowedVoterSet.has(normalizedVoterJid)) {
      return normalizedVoterJid;
    }

    if (typeof voterRaw !== 'string') {
      return null;
    }

    const voterText = voterRaw.trim().toLowerCase();
    if (!voterText.endsWith('@lid')) {
      return null;
    }

    const cached = this.voterAliasMap.get(voterText);
    if (cached && this.config.allowedVoterSet.has(cached)) {
      return cached;
    }

    if (typeof this.client.getContactLidAndPhone !== 'function') {
      return null;
    }

    let lookupRows;
    try {
      lookupRows = await this.client.getContactLidAndPhone([voterText]);
    } catch (error) {
      log(
        'WARN',
        'Failed to resolve @lid voter identity.',
        errorMetadata(error, {
          voterJid: voterText
        })
      );
      return null;
    }

    const lookup = Array.isArray(lookupRows) ? lookupRows[0] : null;
    if (!lookup?.pn) {
      return null;
    }

    let resolvedPhoneJid;
    try {
      resolvedPhoneJid = normalizeJid(lookup.pn);
    } catch {
      return null;
    }

    if (!this.config.allowedVoterSet.has(resolvedPhoneJid)) {
      return null;
    }

    this.voterAliasMap.set(voterText, resolvedPhoneJid);
    if (typeof lookup.lid === 'string' && lookup.lid.trim()) {
      this.voterAliasMap.set(lookup.lid.trim().toLowerCase(), resolvedPhoneJid);
    }

    return resolvedPhoneJid;
  }

  async normalizeVoteUpdateForPoll(poll, voteUpdate) {
    const voterRaw = voteUpdate?.voter;
    if (!voterRaw) {
      return { status: 'skip', reason: 'missing_voter' };
    }

    let voterJid;
    try {
      voterJid = normalizeJid(voterRaw);
    } catch {
      return { status: 'skip', reason: 'invalid_voter' };
    }

    const allowlistedVoterJid = await this.resolveAllowlistedVoterJid(voterRaw, voterJid);
    if (!allowlistedVoterJid) {
      return {
        status: 'skip',
        reason: 'not_allowlisted',
        voterJid
      };
    }

    const { selectedOptions, discardedLocalIds } = this.mapVoteSelectionsToOptionIndices(
      poll,
      voteUpdate.selectedOptions
    );

    return {
      status: 'ok',
      voterJid: allowlistedVoterJid,
      selectedOptions,
      discardedLocalIds
    };
  }

  async onVoteUpdate(voteUpdate) {
    const pollMessageId = extractParentMessageId(voteUpdate);
    if (!pollMessageId) {
      return;
    }

    const poll = this.db.getPollByMessageId(this.config.groupId, pollMessageId);
    if (!poll || poll.status !== 'OPEN') {
      return;
    }

    const normalized = await this.normalizeVoteUpdateForPoll(poll, voteUpdate);
    if (normalized.status !== 'ok') {
      if (normalized.reason === 'not_allowlisted') {
        log('INFO', 'Ignoring vote from non-allowlisted participant.', {
          voterJid: normalized.voterJid,
          pollId: poll.id
        });
      }
      return;
    }

    if (normalized.discardedLocalIds.length > 0) {
      log('WARN', 'Discarded unmatched vote selection localIds.', {
        pollId: poll.id,
        voterJid: normalized.voterJid,
        discardedLocalIds: normalized.discardedLocalIds
      });
    }

    if (normalized.selectedOptions.length === 0 && normalized.discardedLocalIds.length > 0) {
      return;
    }

    this.db.upsertVote({
      pollId: poll.id,
      voterJid: normalized.voterJid,
      selectedOptions: normalized.selectedOptions,
      updatedAt: this.now()
    });

    const summary = this.summarizePoll(poll);
    if (summary.uniqueVoterCount >= this.config.requiredVoters) {
      await this.closePoll(poll.id, 'quorum');
    }
  }

  async closePoll(pollId, closeReason) {
    await this.withPollLock(pollId, async () => {
      const poll = this.db.getPollById(pollId);
      if (!poll || poll.status !== 'OPEN') {
        return;
      }

      this.clearTimer(this.closeTimers, pollId);

      const summary = this.summarizePoll(poll);
      const closedAt = this.now();

      if (summary.maxVotes <= 0 || summary.topIndices.length === 0) {
        const messageText = 'Poll closed. No votes were recorded this week.';
        this.db.setAnnouncedWithOutbox({
          pollId,
          closeReason,
          closedAt,
          announcedAt: closedAt,
          winnerIdx: null,
          winnerVotes: 0,
          outboxMessage: this.buildOutboxTextMessage(messageText, closedAt)
        });
        this.observability.recordPollClosed(closeReason);

        await this.drainOutboxQueue();
        return;
      }

      if (summary.topIndices.length > 1) {
        this.observability.recordTieFlow();
        const tieDeadlineAt = closedAt + this.config.tieOverrideHours * 60 * 60 * 1000;
        const tiedDescriptions = summary.topIndices
          .map((index) => `${index + 1}) ${poll.options[index].label}`)
          .join(' | ');
        const tieMessage = `Tie detected. Use ${this.config.commandPrefix} pick <option_number> within ${this.config.tieOverrideHours}h. Tied options: ${tiedDescriptions}`;

        this.db.setTiePendingWithOutbox({
          pollId,
          closeReason,
          closedAt,
          tieDeadlineAt,
          tieOptionIndices: summary.topIndices,
          outboxMessage: this.buildOutboxTextMessage(tieMessage, closedAt)
        });
        this.observability.recordPollClosed(closeReason);

        this.scheduleTieTimer(pollId, tieDeadlineAt);

        await this.drainOutboxQueue();
        return;
      }

      this.finalizeWinner(poll, summary.topIndices[0], summary.maxVotes, closeReason);
      this.observability.recordPollClosed(closeReason);
      await this.drainOutboxQueue();
    });
  }

  async handleTieTimeout(pollId) {
    await this.withPollLock(pollId, async () => {
      const poll = this.db.getPollById(pollId);
      if (!poll || poll.status !== 'TIE_PENDING') {
        return;
      }

      this.clearTimer(this.tieTimers, pollId);

      const tieCandidates = Array.from(new Set(poll.tieOptionIndices)).sort((a, b) => a - b);
      if (tieCandidates.length === 0) {
        await this.sendGroupMessage('Tie resolution failed: no tie candidates found.');
        return;
      }

      const winnerIdx = tieCandidates[0];
      const summary = this.summarizePoll(poll);
      const winnerVotes = summary.counts[winnerIdx] || 0;

      await this.announceWinner(poll, winnerIdx, winnerVotes, 'tie-timeout');
    });
  }

  finalizeWinner(poll, winnerIdx, winnerVotes, closeReason) {
    const timestamp = this.now();
    const slotLabel = poll.options[winnerIdx]?.label || `Option ${winnerIdx + 1}`;
    const voteWord = winnerVotes === 1 ? 'vote' : 'votes';
    const announcementText = `Weekly game slot selected: ${slotLabel} (${winnerVotes} ${voteWord}).`;

    this.db.setAnnouncedWithOutbox({
      pollId: poll.id,
      closeReason,
      closedAt: poll.closedAt || timestamp,
      announcedAt: timestamp,
      winnerIdx,
      winnerVotes,
      outboxMessage: this.buildOutboxTextMessage(announcementText, timestamp)
    });

    this.clearTimer(this.closeTimers, poll.id);
    this.clearTimer(this.tieTimers, poll.id);

    log('INFO', 'Winner announced.', {
      pollId: poll.id,
      winnerIdx,
      winnerVotes,
      closeReason
    });

    return announcementText;
  }

  async announceWinner(poll, winnerIdx, winnerVotes, closeReason) {
    this.finalizeWinner(poll, winnerIdx, winnerVotes, closeReason);
    await this.drainOutboxQueue();
  }

  async onMessageCreate(message) {
    const body = message.body?.trim();
    if (!body) {
      return;
    }

    if (message.from !== this.config.groupId) {
      return;
    }

    const firstToken = body.split(/\s+/, 1)[0];
    if (!firstToken || firstToken.toLowerCase() !== this.config.commandPrefix.toLowerCase()) {
      return;
    }

    if (body.length > this.config.commandMaxLength) {
      log('WARN', 'Ignoring command: payload is too long.', {
        bodyLength: body.length,
        limit: this.config.commandMaxLength
      });
      return;
    }

    const parts = body.split(/\s+/).filter(Boolean);
    if (parts.length > MAX_COMMAND_TOKENS) {
      log('WARN', 'Ignoring command: too many tokens.', {
        tokenCount: parts.length,
        limit: MAX_COMMAND_TOKENS
      });
      return;
    }

    const senderJid = getMessageSenderJid(message);
    if (!senderJid) {
      return;
    }

    if (this.isRateLimited(senderJid)) {
      log('WARN', 'Rate-limited incoming command.', {
        senderJid,
        windowMs: this.config.commandRateLimitWindowMs,
        limit: this.config.commandRateLimitCount
      });
      return;
    }

    const subCommand = (parts[1] || 'help').toLowerCase();

    if (subCommand === 'help') {
      await this.sendGroupMessage(this.helpText());
      return;
    }

    if (subCommand === 'status') {
      await this.sendGroupMessage(this.buildStatusText());
      return;
    }

    if (subCommand === 'pick') {
      await this.handleManualPick(message, parts[2]);
      return;
    }

    await this.sendGroupMessage(this.helpText());
  }

  helpText() {
    return [
      'Commands:',
      `${this.config.commandPrefix} help`,
      `${this.config.commandPrefix} status`,
      `${this.config.commandPrefix} pick <option_number> (owner only, tie only)`
    ].join('\n');
  }

  buildStatusText() {
    const active = this.db.getActivePoll(this.config.groupId);

    if (!active) {
      const latest = this.db.getLatestPoll(this.config.groupId);
      if (!latest) {
        return 'No poll has been created yet.';
      }

      const announcedAt = latest.announcedAt
        ? DateTime.fromMillis(latest.announcedAt, { zone: this.config.timezone }).toFormat(
            'ccc LLL d HH:mm'
          )
        : 'n/a';

      if (Number.isInteger(latest.winningOptionIdx)) {
        return `No active poll. Last winner: ${latest.options[latest.winningOptionIdx].label} (${latest.winnerVoteCount} votes), announced ${announcedAt}.`;
      }

      return `No active poll. Last poll had no winner (announced ${announcedAt}).`;
    }

    const summary = this.summarizePoll(active);
    const topDescription = summary.topIndices.length
      ? summary.topIndices
          .map(
            (index) =>
              `${index + 1}) ${active.options[index].label} - ${summary.counts[index]} votes`
          )
          .join(' | ')
      : 'No votes yet';

    if (active.status === 'OPEN') {
      const closesAtText = DateTime.fromMillis(active.closesAt, {
        zone: this.config.timezone
      }).toFormat('ccc LLL d HH:mm');

      return `Active poll (${active.weekKey})\nVoters: ${summary.uniqueVoterCount}/${this.config.requiredVoters}\nTop: ${topDescription}\nCloses: ${closesAtText}`;
    }

    const tieDeadline = DateTime.fromMillis(active.tieDeadlineAt, {
      zone: this.config.timezone
    }).toFormat('ccc LLL d HH:mm');

    return `Tie pending (${active.weekKey})\nTop: ${topDescription}\nManual pick deadline: ${tieDeadline}`;
  }

  isOwnerMessage(message) {
    const senderJid = getMessageSenderJid(message);
    return senderJid === this.config.ownerJid;
  }

  async handleManualPick(message, optionRaw) {
    if (!this.isOwnerMessage(message)) {
      await this.sendGroupMessage('Only the owner can run tie-break pick.');
      return;
    }

    const active = this.db.getActivePoll(this.config.groupId);
    if (!active || active.status !== 'TIE_PENDING') {
      await this.sendGroupMessage('No tie is waiting for manual pick right now.');
      return;
    }

    if (!/^\d+$/.test(String(optionRaw || ''))) {
      await this.sendGroupMessage(`Usage: ${this.config.commandPrefix} pick <option_number>`);
      return;
    }

    const optionNumber = Number.parseInt(optionRaw, 10);
    if (!Number.isInteger(optionNumber) || optionNumber < 1) {
      await this.sendGroupMessage(`Usage: ${this.config.commandPrefix} pick <option_number>`);
      return;
    }

    const optionIdx = optionNumber - 1;

    const lockResult = await this.withPollLock(active.id, async () => {
      const latest = this.db.getPollById(active.id);
      if (!latest || latest.status !== 'TIE_PENDING') {
        return { status: 'no_tie' };
      }

      if (!latest.tieOptionIndices.includes(optionIdx)) {
        return {
          status: 'invalid_option',
          tied: latest.tieOptionIndices.map((index) => index + 1)
        };
      }

      this.clearTimer(this.tieTimers, latest.id);

      const summary = this.summarizePoll(latest);
      const winnerVotes = summary.counts[optionIdx] || 0;
      this.finalizeWinner(latest, optionIdx, winnerVotes, 'manual-override');

      return { status: 'ok' };
    });

    if (lockResult === false) {
      await this.sendGroupMessage(
        'Another tie operation is in progress. Please retry in a moment.'
      );
      return;
    }

    if (lockResult.status === 'no_tie') {
      await this.sendGroupMessage('No tie is waiting for manual pick right now.');
      return;
    }

    if (lockResult.status === 'invalid_option') {
      await this.sendGroupMessage(
        `Invalid option. Allowed tied option numbers: ${lockResult.tied.join(', ')}`
      );
      return;
    }

    if (lockResult.status === 'ok') {
      await this.drainOutboxQueue();
    }
  }

  async sendGroupMessage(text) {
    const chat = await this.client.getChatById(this.config.groupId);
    await chat.sendMessage(text);
  }
}

/**
 * Initialize and start the GameSchedulerBot and register graceful shutdown handlers.
 *
 * Sets up SIGINT and SIGTERM listeners and an uncaughtException handler to ensure the bot's
 * shutdown procedure runs at most once, preserves the highest exit code requested, and exits
 * the process after shutdown completes (or logs and exits with code 1 on shutdown failure).
 */
async function main() {
  const config = loadConfig();
  setLogOptions({
    redactSensitive: config.logRedactSensitive,
    includeStack: config.logIncludeStack
  });

  const bot = new GameSchedulerBot(config);
  let shutdownPromise = null;
  let finalExitCode = 0;

  const beginShutdown = (signal, requestedExitCode) => {
    if (shutdownPromise) {
      if (requestedExitCode > finalExitCode) {
        finalExitCode = requestedExitCode;
      }
      return;
    }

    finalExitCode = requestedExitCode;
    shutdownPromise = bot
      .shutdown(signal)
      .catch((error) => {
        log('ERROR', 'Shutdown failure.', errorMetadata(error, { signal }));
        finalExitCode = 1;
      })
      .finally(() => {
        process.exit(finalExitCode);
      });
  };

  const shutdownSignals = ['SIGINT', 'SIGTERM'];
  for (const signal of shutdownSignals) {
    process.on(signal, () => {
      beginShutdown(signal, 0);
    });
  }

  process.on('uncaughtException', (error) => {
    log('ERROR', 'Uncaught exception.', errorMetadata(error));
    beginShutdown('uncaughtException', 1);
  });

  process.on('unhandledRejection', (reason) => {
    log('ERROR', 'Unhandled promise rejection.', {
      reason: reason instanceof Error ? reason.message : String(reason)
    });
    beginShutdown('unhandledRejection', 1);
  });

  await bot.start();
}

if (require.main === module) {
  main().catch((error) => {
    log('ERROR', 'Fatal startup error.', errorMetadata(error));
    process.exit(1);
  });
}

module.exports = {
  GameSchedulerBot,
  extractParentMessageId,
  getMessageSenderJid,
  main,
  serializeMessageId,
  serializeMessageKey
};

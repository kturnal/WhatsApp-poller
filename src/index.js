require('dotenv').config();

const path = require('node:path');
const cron = require('node-cron');
const qrcodeTerminal = require('qrcode-terminal');
const { Client, LocalAuth, Poll } = require('whatsapp-web.js');

const { loadConfig } = require('./config');
const { PollDatabase } = require('./db');
const { errorMetadata, log, setLogOptions } = require('./logger');
const {
  extractParentMessageId,
  getMessageSenderJid,
  serializeMessageId,
  serializeMessageKey
} = require('./message-utils');
const { BotObservability } = require('./observability');
const { enforceSecureRuntimePermissions } = require('./runtime-security');
const { resolveStartupWeekSelection } = require('./startup-week-selector');
const {
  buildStatusText,
  handleManualPick,
  helpText,
  isOwnerMessage,
  isRateLimited,
  onMessageCreate
} = require('./services/command-handler');
const {
  buildOutboxTextMessage,
  clearOutboxTimer,
  deliverOutboxMessage,
  drainOutboxQueue,
  getOutboxRetryDelayMs,
  recoverOutboxMessages,
  refreshOutboxSchedule,
  scheduleOutboxDrain,
  sendOutboxPayload
} = require('./services/outbox-delivery');
const {
  announceWinner,
  clearTimer,
  closePoll,
  createCurrentWeekPollIfMissed,
  createPollForWeek,
  createStartupSelectedWeekPollIfNeeded,
  createWeeklyPollIfNeeded,
  finalizeExpiredAutomaticWinner,
  finalizeWinner,
  getExpiredAutoWinnerState,
  handleTieTimeout,
  mapVoteSelectionsToOptionIndices,
  maybeAnnounceAutomaticWinner,
  normalizeVoteUpdateForPoll,
  notifyOwnerExpiredWinner,
  onVoteUpdate,
  reconcilePendingPollVotes,
  reconcilePollVotes,
  recoverPendingPolls,
  resolveAllowlistedVoterJid,
  resolvePollOptionScheduledAt,
  scheduleCloseTimer,
  scheduleTieTimer,
  summarizePoll,
  withPollLock
} = require('./services/poll-lifecycle');
const { WhatsAppAdapter } = require('./whatsapp-adapter');

const DEFAULT_OUTBOX_MAX_ATTEMPTS = 5;
const DEFAULT_OUTBOX_RETRY_BASE_MS = 30 * 1000;
const DEFAULT_OUTBOX_RETRY_MAX_MS = 30 * 60 * 1000;
const DEFAULT_OUTBOX_SEND_TIMEOUT_MS = 30 * 1000;

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
    this.pendingTasks = new Set();
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
    this.adapter =
      dependencies.adapter ||
      new WhatsAppAdapter({
        client: this.client,
        groupId: this.config.groupId,
        ownerJid: this.config.ownerJid
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

  runSafely(source, fn) {
    const task = Promise.resolve()
      .then(fn)
      .catch((error) => {
        log('ERROR', `Unhandled error in ${source}.`, errorMetadata(error));
      })
      .finally(() => {
        this.pendingTasks.delete(task);
      });

    this.pendingTasks.add(task);
    return task;
  }

  #bindHandlers() {
    this.adapter.bindEventHandlers({
      qr: (qr) => {
        log('INFO', 'QR received. Scan it from WhatsApp app.');
        qrcodeTerminal.generate(qr, { small: true });
      },
      ready: () => {
        this.observability.markClientReady();
        this.observability.markStartupPending();
        this.runSafely('ready', async () => {
          await this.onReady();
        });
      },
      auth_failure: (message) => {
        this.observability.markClientNotReady();
        log('ERROR', 'Authentication failure.', { message });
      },
      disconnected: (reason) => {
        this.observability.markClientDisconnected();
        log('WARN', 'Client disconnected.', { reason });
      },
      vote_update: (voteUpdate) => {
        this.runSafely('vote_update', async () => {
          await this.onVoteUpdate(voteUpdate);
        });
      },
      message_create: (message) => {
        this.runSafely('message_create', async () => {
          await this.onMessageCreate(message);
        });
      }
    });
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

    await this.adapter.initialize();
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

    if (this.pendingTasks.size > 0) {
      await Promise.allSettled([...this.pendingTasks]);
    }

    if (this.db && typeof this.db.close === 'function') {
      try {
        this.db.close();
      } catch (error) {
        log('ERROR', 'Failed to close SQLite database.', errorMetadata(error));
      }
    }

    let destroyError = null;
    try {
      await this.adapter.destroy();
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
    await this.adapter.getGroupChat();
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
        this.runSafely('weekly_cron', async () => {
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

  async withPollLock(pollId, callback) {
    return withPollLock(this, pollId, callback);
  }

  isRateLimited(senderJid) {
    return isRateLimited(this, senderJid);
  }

  recoverPendingPolls() {
    return recoverPendingPolls(this);
  }

  async reconcilePendingPollVotes() {
    return reconcilePendingPollVotes(this);
  }

  async reconcilePollVotes(poll) {
    return reconcilePollVotes(this, poll);
  }

  async createCurrentWeekPollIfMissed() {
    return createCurrentWeekPollIfMissed(this);
  }

  async createStartupSelectedWeekPollIfNeeded() {
    return createStartupSelectedWeekPollIfNeeded(this);
  }

  async createWeeklyPollIfNeeded(trigger) {
    return createWeeklyPollIfNeeded(this, trigger);
  }

  async createPollForWeek(args) {
    return createPollForWeek(this, args);
  }

  scheduleCloseTimer(pollId, closesAt) {
    return scheduleCloseTimer(this, pollId, closesAt);
  }

  scheduleTieTimer(pollId, tieDeadlineAt) {
    return scheduleTieTimer(this, pollId, tieDeadlineAt);
  }

  clearTimer(timerMap, pollId) {
    return clearTimer(this, timerMap, pollId);
  }

  buildOutboxTextMessage(text, createdAt = this.now()) {
    return buildOutboxTextMessage(this, text, createdAt);
  }

  resolvePollOptionScheduledAt(poll, optionIdx) {
    return resolvePollOptionScheduledAt(this, poll, optionIdx);
  }

  getExpiredAutoWinnerState(poll, winnerIdx) {
    return getExpiredAutoWinnerState(this, poll, winnerIdx);
  }

  async notifyOwnerExpiredWinner(poll, winnerIdx, slotLabel, slotIso, closeReason) {
    return notifyOwnerExpiredWinner(this, poll, winnerIdx, slotLabel, slotIso, closeReason);
  }

  async finalizeExpiredAutomaticWinner(poll, winnerIdx, winnerVotes, closeReason) {
    return finalizeExpiredAutomaticWinner(this, poll, winnerIdx, winnerVotes, closeReason);
  }

  async maybeAnnounceAutomaticWinner(poll, winnerIdx, winnerVotes, closeReason) {
    return maybeAnnounceAutomaticWinner(this, poll, winnerIdx, winnerVotes, closeReason);
  }

  getOutboxRetryDelayMs(attemptCount) {
    return getOutboxRetryDelayMs(this, attemptCount);
  }

  clearOutboxTimer() {
    return clearOutboxTimer(this);
  }

  scheduleOutboxDrain(nextRetryAt) {
    return scheduleOutboxDrain(this, nextRetryAt);
  }

  refreshOutboxSchedule() {
    return refreshOutboxSchedule(this);
  }

  async recoverOutboxMessages() {
    return recoverOutboxMessages(this);
  }

  async sendOutboxPayload(payload) {
    return sendOutboxPayload(this, payload);
  }

  async deliverOutboxMessage(outboxMessage) {
    return deliverOutboxMessage(this, outboxMessage);
  }

  async drainOutboxQueue() {
    return drainOutboxQueue(this);
  }

  summarizePoll(poll) {
    return summarizePoll(this, poll);
  }

  mapVoteSelectionsToOptionIndices(poll, selectedOptionsRaw) {
    return mapVoteSelectionsToOptionIndices(this, poll, selectedOptionsRaw);
  }

  async resolveAllowlistedVoterJid(voterRaw, normalizedVoterJid) {
    return resolveAllowlistedVoterJid(this, voterRaw, normalizedVoterJid);
  }

  async normalizeVoteUpdateForPoll(poll, voteUpdate) {
    return normalizeVoteUpdateForPoll(this, poll, voteUpdate);
  }

  async onVoteUpdate(voteUpdate) {
    return onVoteUpdate(this, voteUpdate);
  }

  async closePoll(pollId, closeReason) {
    return closePoll(this, pollId, closeReason);
  }

  async handleTieTimeout(pollId) {
    return handleTieTimeout(this, pollId);
  }

  finalizeWinner(poll, winnerIdx, winnerVotes, closeReason) {
    return finalizeWinner(this, poll, winnerIdx, winnerVotes, closeReason);
  }

  async announceWinner(poll, winnerIdx, winnerVotes, closeReason) {
    return announceWinner(this, poll, winnerIdx, winnerVotes, closeReason);
  }

  async onMessageCreate(message) {
    return onMessageCreate(this, message);
  }

  helpText() {
    return helpText(this);
  }

  buildStatusText() {
    return buildStatusText(this);
  }

  isOwnerMessage(message) {
    return isOwnerMessage(this, message);
  }

  async handleManualPick(message, optionRaw) {
    return handleManualPick(this, message, optionRaw);
  }

  async sendGroupMessage(text) {
    return this.adapter.sendGroupMessage(text);
  }
}

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

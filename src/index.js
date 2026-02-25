require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const cron = require('node-cron');
const qrcodeTerminal = require('qrcode-terminal');
const { DateTime } = require('luxon');
const { Client, LocalAuth, Poll } = require('whatsapp-web.js');

const { loadConfig, normalizeJid } = require('./config');
const { PollDatabase } = require('./db');
const {
  buildOptionsForWeek,
  currentWeekContext,
  scheduledWeeklyRunForWeek
} = require('./poll-slots');

const MAX_TIMEOUT_MS = 2 ** 31 - 1;

function log(level, message, metadata = null) {
  const timestamp = DateTime.now().toISO();
  const prefix = `[${timestamp}] [${level}] ${message}`;

  if (!metadata) {
    console.log(prefix);
    return;
  }

  console.log(`${prefix} ${JSON.stringify(metadata)}`);
}

function serializeMessageId(message) {
  if (!message || !message.id) {
    return null;
  }

  return serializeMessageKey(message.id);
}

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
  constructor(config) {
    this.config = config;

    fs.mkdirSync(this.config.dataDir, { recursive: true });

    this.db = new PollDatabase(path.join(this.config.dataDir, 'polls.sqlite'));

    this.closeTimers = new Map();
    this.tieTimers = new Map();
    this.pollLocks = new Set();

    this.client = new Client({
      authStrategy: new LocalAuth({
        clientId: this.config.clientId,
        dataPath: path.join(this.config.dataDir, 'session')
      }),
      puppeteer: {
        headless: this.config.headless,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      }
    });

    this.cronTask = null;
    this.#bindHandlers();
  }

  #bindHandlers() {
    this.client.on('qr', (qr) => {
      log('INFO', 'QR received. Scan it from WhatsApp app.');
      qrcodeTerminal.generate(qr, { small: true });
    });

    this.client.on('ready', () => {
      this.#safeRun('ready', async () => {
        await this.onReady();
      });
    });

    this.client.on('auth_failure', (message) => {
      log('ERROR', 'Authentication failure.', { message });
    });

    this.client.on('disconnected', (reason) => {
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
      log('ERROR', `Unhandled error in ${source}.`, {
        error: error?.message,
        stack: error?.stack
      });
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

  async start() {
    log('INFO', 'Starting WhatsApp scheduler bot.');
    await this.client.initialize();
  }

  async shutdown(signal) {
    log('INFO', 'Shutting down bot.', { signal });

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

    if (this.db && typeof this.db.close === 'function') {
      try {
        this.db.close();
      } catch (error) {
        log('ERROR', 'Failed to close SQLite database.', {
          error: error?.message,
          stack: error?.stack
        });
      }
    }

    await this.client.destroy();
  }

  async onReady() {
    await this.client.getChatById(this.config.groupId);

    log('INFO', 'WhatsApp client is ready.', {
      groupId: this.config.groupId,
      timezone: this.config.timezone
    });

    this.startCronIfNeeded();
    this.recoverPendingPolls();
    await this.createCurrentWeekPollIfMissed();
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
    const pendingPolls = this.db.listRecoverablePolls();

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

  async createCurrentWeekPollIfMissed() {
    const { now, weekYear, weekNumber, weekKey } = currentWeekContext(this.config.timezone);
    const scheduledTime = scheduledWeeklyRunForWeek(this.config.timezone, weekYear, weekNumber);

    if (now < scheduledTime) {
      return;
    }

    const existing = this.db.getPollByWeekKey(weekKey);
    if (existing) {
      return;
    }

    const active = this.db.getActivePoll();
    if (active) {
      log('INFO', 'Skipping catch-up poll creation because an active poll exists.', {
        activePollId: active.id,
        activeStatus: active.status
      });
      return;
    }

    await this.createWeeklyPollIfNeeded('startup-catchup');
  }

  async createWeeklyPollIfNeeded(trigger) {
    const active = this.db.getActivePoll();
    if (active) {
      log('INFO', 'Skipping weekly poll creation because an active poll exists.', {
        activePollId: active.id,
        activeStatus: active.status,
        trigger
      });
      return;
    }

    const { now, weekYear, weekNumber, weekKey } = currentWeekContext(this.config.timezone);
    const existingThisWeek = this.db.getPollByWeekKey(weekKey);

    if (existingThisWeek) {
      log('INFO', 'Weekly poll already exists for week key.', {
        weekKey,
        existingPollId: existingThisWeek.id,
        status: existingThisWeek.status,
        trigger
      });
      return;
    }

    const options = buildOptionsForWeek(this.config.timezone, weekYear, weekNumber);
    const optionLabels = options.map((option) => option.label);
    let pollMessageId = null;

    try {
      const chat = await this.client.getChatById(this.config.groupId);
      const sentMessage = await chat.sendMessage(
        new Poll(this.config.pollQuestion, optionLabels, { allowMultipleAnswers: true })
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

      const createdAt = now.toMillis();
      const closesAt = createdAt + this.config.pollCloseHours * 60 * 60 * 1000;

      const pollId = this.db.createPoll({
        groupId: this.config.groupId,
        weekKey,
        pollMessageId,
        question: this.config.pollQuestion,
        options: optionsWithLocalIds,
        createdAt,
        closesAt
      });

      this.scheduleCloseTimer(pollId, closesAt);

      log('INFO', 'Weekly poll created.', {
        pollId,
        pollMessageId,
        weekKey,
        closesAt,
        trigger
      });
    } catch (error) {
      if (pollMessageId) {
        log('ERROR', 'Poll was sent but failed to persist in SQLite.', {
          weekKey,
          pollMessageId,
          trigger,
          error: error?.message,
          stack: error?.stack
        });
      }
      throw error;
    }
  }

  scheduleCloseTimer(pollId, closesAt) {
    this.clearTimer(this.closeTimers, pollId);

    const delay = closesAt - Date.now();

    if (delay <= 0) {
      this.#safeRun('close_timer_immediate', async () => {
        await this.closePoll(pollId, 'deadline');
      });
      return;
    }

    const timeoutDelay = Math.min(delay, MAX_TIMEOUT_MS);
    const timeout = setTimeout(() => {
      const remaining = closesAt - Date.now();
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

    const delay = tieDeadlineAt - Date.now();

    if (delay <= 0) {
      this.#safeRun('tie_timer_immediate', async () => {
        await this.handleTieTimeout(pollId);
      });
      return;
    }

    const timeoutDelay = Math.min(delay, MAX_TIMEOUT_MS);
    const timeout = setTimeout(() => {
      const remaining = tieDeadlineAt - Date.now();
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

  async onVoteUpdate(voteUpdate) {
    const pollMessageId = extractParentMessageId(voteUpdate);
    if (!pollMessageId) {
      return;
    }

    const poll = this.db.getPollByMessageId(pollMessageId);
    if (!poll || poll.status !== 'OPEN') {
      return;
    }

    const voterRaw = voteUpdate?.voter;
    if (!voterRaw) {
      return;
    }

    let voterJid;
    try {
      voterJid = normalizeJid(voterRaw);
    } catch {
      return;
    }

    if (!this.config.allowedVoterSet.has(voterJid)) {
      log('INFO', 'Ignoring vote from non-allowlisted participant.', {
        voterJid,
        pollId: poll.id
      });
      return;
    }

    const discardedLocalIds = [];
    const selectedOptions = Array.from(
      new Set(
        (voteUpdate.selectedOptions || [])
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

    if (discardedLocalIds.length > 0) {
      log('WARN', 'Discarded unmatched vote selection localIds.', {
        pollId: poll.id,
        voterJid,
        discardedLocalIds
      });
    }

    this.db.upsertVote({
      pollId: poll.id,
      voterJid,
      selectedOptions,
      updatedAt: Date.now()
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
      const closedAt = Date.now();

      if (summary.maxVotes <= 0 || summary.topIndices.length === 0) {
        this.db.setAnnounced({
          pollId,
          closeReason,
          closedAt,
          announcedAt: closedAt,
          winnerIdx: null,
          winnerVotes: 0
        });

        await this.sendGroupMessage('Poll closed. No votes were recorded this week.');
        return;
      }

      if (summary.topIndices.length > 1) {
        const tieDeadlineAt = closedAt + this.config.tieOverrideHours * 60 * 60 * 1000;

        this.db.setTiePending({
          pollId,
          closeReason,
          closedAt,
          tieDeadlineAt,
          tieOptionIndices: summary.topIndices
        });

        this.scheduleTieTimer(pollId, tieDeadlineAt);

        const tiedDescriptions = summary.topIndices
          .map((index) => `${index + 1}) ${poll.options[index].label}`)
          .join(' | ');

        await this.sendGroupMessage(
          `Tie detected. Use ${this.config.commandPrefix} pick <option_number> within ${this.config.tieOverrideHours}h. Tied options: ${tiedDescriptions}`
        );

        return;
      }

      await this.announceWinner(poll, summary.topIndices[0], summary.maxVotes, closeReason);
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
    const timestamp = Date.now();

    this.db.setAnnounced({
      pollId: poll.id,
      closeReason,
      closedAt: poll.closedAt || timestamp,
      announcedAt: timestamp,
      winnerIdx,
      winnerVotes
    });

    this.clearTimer(this.closeTimers, poll.id);
    this.clearTimer(this.tieTimers, poll.id);

    const slotLabel = poll.options[winnerIdx]?.label || `Option ${winnerIdx + 1}`;
    const voteWord = winnerVotes === 1 ? 'vote' : 'votes';
    const announcementText = `Weekly game slot selected: ${slotLabel} (${winnerVotes} ${voteWord}).`;

    log('INFO', 'Winner announced.', {
      pollId: poll.id,
      winnerIdx,
      winnerVotes,
      closeReason
    });

    return announcementText;
  }

  async announceWinner(poll, winnerIdx, winnerVotes, closeReason) {
    const announcementText = this.finalizeWinner(poll, winnerIdx, winnerVotes, closeReason);
    await this.sendGroupMessage(announcementText);
  }

  async onMessageCreate(message) {
    const body = message.body?.trim();
    if (!body) {
      return;
    }

    if (message.from !== this.config.groupId) {
      return;
    }

    if (!body.toLowerCase().startsWith(this.config.commandPrefix.toLowerCase())) {
      return;
    }

    const parts = body.split(/\s+/);
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
    const active = this.db.getActivePoll();

    if (!active) {
      const latest = this.db.getLatestPoll();
      if (!latest) {
        return 'No poll has been created yet.';
      }

      const announcedAt = latest.announcedAt
        ? DateTime.fromMillis(latest.announcedAt, { zone: this.config.timezone }).toFormat('ccc LLL d HH:mm')
        : 'n/a';

      if (Number.isInteger(latest.winningOptionIdx)) {
        return `No active poll. Last winner: ${latest.options[latest.winningOptionIdx].label} (${latest.winnerVoteCount} votes), announced ${announcedAt}.`;
      }

      return `No active poll. Last poll had no winner (announced ${announcedAt}).`;
    }

    const summary = this.summarizePoll(active);
    const topDescription = summary.topIndices.length
      ? summary.topIndices
          .map((index) => `${index + 1}) ${active.options[index].label} - ${summary.counts[index]} votes`)
          .join(' | ')
      : 'No votes yet';

    if (active.status === 'OPEN') {
      const closesAtText = DateTime.fromMillis(active.closesAt, { zone: this.config.timezone }).toFormat(
        'ccc LLL d HH:mm'
      );

      return `Active poll (${active.weekKey})\nVoters: ${summary.uniqueVoterCount}/${this.config.requiredVoters}\nTop: ${topDescription}\nCloses: ${closesAtText}`;
    }

    const tieDeadline = DateTime.fromMillis(active.tieDeadlineAt, { zone: this.config.timezone }).toFormat(
      'ccc LLL d HH:mm'
    );

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

    const active = this.db.getActivePoll();
    if (!active || active.status !== 'TIE_PENDING') {
      await this.sendGroupMessage('No tie is waiting for manual pick right now.');
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
      const announcementText = this.finalizeWinner(latest, optionIdx, winnerVotes, 'manual-override');

      return { status: 'ok', announcementText };
    });

    if (lockResult === false) {
      await this.sendGroupMessage('Another tie operation is in progress. Please retry in a moment.');
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
      await this.sendGroupMessage(lockResult.announcementText);
    }
  }

  async sendGroupMessage(text) {
    const chat = await this.client.getChatById(this.config.groupId);
    await chat.sendMessage(text);
  }
}

async function main() {
  const config = loadConfig();
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
        log('ERROR', 'Shutdown failure.', {
          signal,
          error: error?.message,
          stack: error?.stack
        });
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
    log('ERROR', 'Uncaught exception.', {
      error: error?.message,
      stack: error?.stack
    });
    beginShutdown('uncaughtException', 1);
  });

  await bot.start();
}

process.on('unhandledRejection', (reason) => {
  log('ERROR', 'Unhandled promise rejection.', {
    reason: reason instanceof Error ? reason.message : String(reason)
  });
});

main().catch((error) => {
  log('ERROR', 'Fatal startup error.', {
    error: error?.message,
    stack: error?.stack
  });
  process.exit(1);
});

const { DateTime } = require('luxon');

const { normalizeJid } = require('../config');
const { errorMetadata, log } = require('../logger');
const { extractParentMessageId, serializeMessageId } = require('../message-utils');
const {
  buildOptionsForWeek,
  currentWeekContext,
  formatWeekDateRangeLabel,
  scheduledWeeklyRunForWeek
} = require('../poll-slots');

const MAX_TIMEOUT_MS = 2 ** 31 - 1;

async function withPollLock(bot, pollId, callback) {
  if (bot.pollLocks.has(pollId)) {
    return false;
  }

  bot.pollLocks.add(pollId);

  try {
    return await callback();
  } finally {
    bot.pollLocks.delete(pollId);
  }
}

function recoverPendingPolls(bot) {
  const pendingPolls = bot.db.listRecoverablePolls(bot.config.groupId);

  if (pendingPolls.length === 0) {
    return;
  }

  log('INFO', 'Recovering pending polls from SQLite.', { count: pendingPolls.length });

  for (const poll of pendingPolls) {
    if (poll.status === 'OPEN') {
      bot.scheduleCloseTimer(poll.id, poll.closesAt);
    } else if (poll.status === 'TIE_PENDING') {
      bot.scheduleTieTimer(poll.id, poll.tieDeadlineAt);
    }
  }
}

async function reconcilePendingPollVotes(bot) {
  if (!bot.adapter.supportsPollVoteLookup()) {
    log('WARN', 'Skipping startup vote reconciliation: client.getPollVotes is unavailable.');
    return;
  }

  const pendingPolls = bot.db.listRecoverablePolls(bot.config.groupId);
  if (pendingPolls.length === 0) {
    return;
  }

  log('INFO', 'Reconciling active poll votes from WhatsApp.', { count: pendingPolls.length });

  for (const poll of pendingPolls) {
    await bot.reconcilePollVotes(poll);
  }
}

async function reconcilePollVotes(bot, poll) {
  let pollVotes;

  try {
    pollVotes = await bot.adapter.getPollVotes(poll.pollMessageId);
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
    const normalized = await bot.normalizeVoteUpdateForPoll(poll, pollVote);
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

    bot.db.upsertVote({
      pollId: poll.id,
      voterJid: normalized.voterJid,
      selectedOptions: normalized.selectedOptions,
      updatedAt: bot.now()
    });
    stats.upsertedVotes += 1;
  }

  const summary = bot.summarizePoll(poll);
  log('INFO', 'Startup poll reconciliation complete.', {
    pollId: poll.id,
    pollStatus: poll.status,
    ...stats,
    uniqueVoterCount: summary.uniqueVoterCount,
    requiredVoters: bot.config.requiredVoters,
    maxVotes: summary.maxVotes
  });

  if (poll.status === 'OPEN' && summary.uniqueVoterCount >= bot.config.requiredVoters) {
    await bot.closePoll(poll.id, 'quorum');
  }
}

async function createCurrentWeekPollIfMissed(bot) {
  const { now, weekYear, weekNumber, weekKey } = currentWeekContext(bot.config.timezone, bot.now());
  const scheduledTime = scheduledWeeklyRunForWeek(
    bot.config.timezone,
    weekYear,
    weekNumber,
    bot.config.pollCron
  );

  if (now < scheduledTime) {
    return;
  }

  const existing = bot.db.getPollByWeekKey(bot.config.groupId, weekKey);
  if (existing) {
    return;
  }

  const active = bot.db.getActivePoll(bot.config.groupId);
  if (active) {
    log('INFO', 'Skipping catch-up poll creation because an active poll exists.', {
      activePollId: active.id,
      activeStatus: active.status
    });
    return;
  }

  await bot.createWeeklyPollIfNeeded('startup-catchup');
}

async function createStartupSelectedWeekPollIfNeeded(bot) {
  const active = bot.db.getActivePoll(bot.config.groupId);
  if (active) {
    log('INFO', 'Skipping interactive startup week selection because an active poll exists.', {
      activePollId: active.id,
      activeStatus: active.status
    });
    return;
  }

  const selection = await bot.startupWeekSelectionResolver({
    config: bot.config,
    db: bot.db,
    nowMillis: bot.now()
  });

  if (!selection) {
    return;
  }

  const weekLabel =
    selection.weekLabel ||
    formatWeekDateRangeLabel(bot.config.timezone, selection.weekYear, selection.weekNumber);

  if (selection.action === 'skip') {
    log('INFO', 'Startup week selection skipped poll creation for existing week.', {
      weekKey: selection.weekKey,
      weekLabel
    });
    return;
  }

  if (selection.action === 'replace' && Number.isInteger(selection.existingPollId)) {
    bot.clearTimer(bot.closeTimers, selection.existingPollId);
    bot.clearTimer(bot.tieTimers, selection.existingPollId);
  }

  await bot.createPollForWeek({
    trigger: selection.action === 'replace' ? 'startup-interactive-replace' : 'startup-interactive',
    weekYear: selection.weekYear,
    weekNumber: selection.weekNumber,
    weekKey: selection.weekKey,
    replacePollId:
      selection.action === 'replace' && Number.isInteger(selection.existingPollId)
        ? selection.existingPollId
        : null
  });
}

async function createWeeklyPollIfNeeded(bot, trigger) {
  const active = bot.db.getActivePoll(bot.config.groupId);
  if (active) {
    log('INFO', 'Skipping weekly poll creation because an active poll exists.', {
      activePollId: active.id,
      activeStatus: active.status,
      trigger
    });
    return;
  }

  const { now, weekYear, weekNumber, weekKey } = currentWeekContext(bot.config.timezone, bot.now());
  const existingThisWeek = bot.db.getPollByWeekKey(bot.config.groupId, weekKey);

  if (existingThisWeek) {
    log('INFO', 'Weekly poll already exists for week key.', {
      weekKey,
      existingPollId: existingThisWeek.id,
      status: existingThisWeek.status,
      trigger
    });
    return;
  }

  await bot.createPollForWeek({
    trigger,
    weekYear,
    weekNumber,
    weekKey,
    replacePollId: null,
    createdAt: now.toMillis()
  });
}

async function createPollForWeek(
  bot,
  { trigger, weekYear, weekNumber, weekKey, replacePollId = null, createdAt }
) {
  const options = buildOptionsForWeek(
    bot.config.timezone,
    weekYear,
    weekNumber,
    bot.config.slotTemplate
  );
  const optionLabels = options.map((option) => option.label);
  let pollMessageId = null;

  try {
    const sentMessage = await bot.adapter.sendGroupPoll(
      bot.pollFactory(bot.config.pollQuestion, optionLabels, { allowMultipleAnswers: true })
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

    const createdAtMillis = Number.isInteger(createdAt) ? createdAt : bot.now();
    const pollId = Number.isInteger(replacePollId) ? replacePollId : null;
    const closesAt = createdAtMillis + bot.config.pollCloseHours * 60 * 60 * 1000;

    if (pollId === null) {
      const newPollId = bot.db.createPoll({
        groupId: bot.config.groupId,
        weekKey,
        pollMessageId,
        question: bot.config.pollQuestion,
        options: optionsWithLocalIds,
        createdAt: createdAtMillis,
        closesAt
      });

      bot.scheduleCloseTimer(newPollId, closesAt);
      bot.observability.recordPollCreated();

      log('INFO', 'Weekly poll created.', {
        pollId: newPollId,
        pollMessageId,
        weekKey,
        closesAt,
        trigger
      });
    } else {
      bot.db.replacePollInPlace({
        pollId,
        pollMessageId,
        question: bot.config.pollQuestion,
        options: optionsWithLocalIds,
        createdAt: createdAtMillis,
        closesAt
      });

      bot.scheduleCloseTimer(pollId, closesAt);
      bot.observability.recordPollCreated();

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

function scheduleCloseTimer(bot, pollId, closesAt) {
  bot.clearTimer(bot.closeTimers, pollId);

  const delay = closesAt - bot.now();

  if (delay <= 0) {
    bot.runSafely('close_timer_immediate', async () => {
      await bot.closePoll(pollId, 'deadline');
    });
    return;
  }

  const timeoutDelay = Math.min(delay, MAX_TIMEOUT_MS);
  const timeout = setTimeout(() => {
    const remaining = closesAt - bot.now();
    if (remaining > 0) {
      bot.scheduleCloseTimer(pollId, closesAt);
      return;
    }

    bot.runSafely('close_timer', async () => {
      await bot.closePoll(pollId, 'deadline');
    });
  }, timeoutDelay);

  bot.closeTimers.set(pollId, timeout);
}

function scheduleTieTimer(bot, pollId, tieDeadlineAt) {
  bot.clearTimer(bot.tieTimers, pollId);

  const delay = tieDeadlineAt - bot.now();

  if (delay <= 0) {
    bot.runSafely('tie_timer_immediate', async () => {
      await bot.handleTieTimeout(pollId);
    });
    return;
  }

  const timeoutDelay = Math.min(delay, MAX_TIMEOUT_MS);
  const timeout = setTimeout(() => {
    const remaining = tieDeadlineAt - bot.now();
    if (remaining > 0) {
      bot.scheduleTieTimer(pollId, tieDeadlineAt);
      return;
    }

    bot.runSafely('tie_timer', async () => {
      await bot.handleTieTimeout(pollId);
    });
  }, timeoutDelay);

  bot.tieTimers.set(pollId, timeout);
}

function clearTimer(bot, timerMap, pollId) {
  const timer = timerMap.get(pollId);

  if (timer) {
    clearTimeout(timer);
    timerMap.delete(pollId);
  }
}

function resolvePollOptionScheduledAt(bot, poll, optionIdx) {
  const slotIso = poll?.options?.[optionIdx]?.iso;
  if (typeof slotIso !== 'string' || !slotIso.trim()) {
    return {
      scheduledAt: null,
      slotIso: null
    };
  }

  const scheduledAt = DateTime.fromISO(slotIso, { setZone: true });
  if (!scheduledAt.isValid) {
    return {
      scheduledAt: null,
      slotIso
    };
  }

  return {
    scheduledAt,
    slotIso
  };
}

function getExpiredAutoWinnerState(bot, poll, winnerIdx) {
  const slotLabel = poll?.options?.[winnerIdx]?.label || `Option ${winnerIdx + 1}`;
  const { scheduledAt, slotIso } = bot.resolvePollOptionScheduledAt(poll, winnerIdx);

  if (!scheduledAt) {
    if (slotIso) {
      log('WARN', 'Automatic winner slot has invalid scheduled time; announcing winner.', {
        pollId: poll?.id ?? null,
        winnerIdx,
        slotIso
      });
    } else {
      log('WARN', 'Automatic winner slot has no scheduled time; announcing winner.', {
        pollId: poll?.id ?? null,
        winnerIdx
      });
    }

    return {
      expired: false,
      slotIso,
      slotLabel
    };
  }

  return {
    expired: bot.now() > scheduledAt.toMillis(),
    slotIso,
    slotLabel
  };
}

async function notifyOwnerExpiredWinner(bot, poll, winnerIdx, slotLabel, slotIso, closeReason) {
  const message = `Poll ${poll.weekKey} closed without a winner announcement because the selected slot time had already passed: ${slotLabel}.${slotIso ? ` Scheduled at ${slotIso}.` : ''} Close reason: ${closeReason}.`;

  try {
    await bot.adapter.sendOwnerMessage(message);
  } catch (error) {
    log(
      'WARN',
      'Failed to notify owner about expired winning slot.',
      errorMetadata(error, {
        pollId: poll.id,
        winnerIdx,
        slotIso,
        closeReason
      })
    );
  }
}

async function finalizeExpiredAutomaticWinner(bot, poll, winnerIdx, winnerVotes, closeReason) {
  const timestamp = bot.now();
  const { slotIso, slotLabel } = bot.getExpiredAutoWinnerState(poll, winnerIdx);

  bot.db.setAnnounced({
    pollId: poll.id,
    closeReason,
    closedAt: poll.closedAt || timestamp,
    announcedAt: timestamp,
    winnerIdx: null,
    winnerVotes: 0
  });

  bot.clearTimer(bot.closeTimers, poll.id);
  bot.clearTimer(bot.tieTimers, poll.id);

  log('WARN', 'Winner announcement skipped because the selected slot time already passed.', {
    pollId: poll.id,
    winnerIdx,
    winnerVotes,
    slotIso,
    closeReason
  });

  await bot.notifyOwnerExpiredWinner(poll, winnerIdx, slotLabel, slotIso, closeReason);
}

async function maybeAnnounceAutomaticWinner(bot, poll, winnerIdx, winnerVotes, closeReason) {
  const expiryState = bot.getExpiredAutoWinnerState(poll, winnerIdx);
  if (expiryState.expired) {
    await bot.finalizeExpiredAutomaticWinner(poll, winnerIdx, winnerVotes, closeReason);
    return false;
  }

  await bot.announceWinner(poll, winnerIdx, winnerVotes, closeReason);
  return true;
}

function summarizePoll(bot, poll) {
  const votes = bot.db.getVotesByPollId(poll.id);
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

function mapVoteSelectionsToOptionIndices(bot, poll, selectedOptionsRaw) {
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

async function resolveAllowlistedVoterJid(bot, voterRaw, normalizedVoterJid) {
  if (bot.config.allowedVoterSet.has(normalizedVoterJid)) {
    return normalizedVoterJid;
  }

  if (typeof voterRaw !== 'string') {
    return null;
  }

  const voterText = voterRaw.trim().toLowerCase();
  if (!voterText.endsWith('@lid')) {
    return null;
  }

  const cached = bot.voterAliasMap.get(voterText);
  if (cached && bot.config.allowedVoterSet.has(cached)) {
    return cached;
  }

  if (!bot.adapter.supportsContactLookup()) {
    return null;
  }

  let lookupRows;
  try {
    lookupRows = await bot.adapter.getContactLidAndPhone([voterText]);
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

  if (!bot.config.allowedVoterSet.has(resolvedPhoneJid)) {
    return null;
  }

  bot.voterAliasMap.set(voterText, resolvedPhoneJid);
  if (typeof lookup.lid === 'string' && lookup.lid.trim()) {
    bot.voterAliasMap.set(lookup.lid.trim().toLowerCase(), resolvedPhoneJid);
  }

  return resolvedPhoneJid;
}

async function normalizeVoteUpdateForPoll(bot, poll, voteUpdate) {
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

  const allowlistedVoterJid = await bot.resolveAllowlistedVoterJid(voterRaw, voterJid);
  if (!allowlistedVoterJid) {
    return {
      status: 'skip',
      reason: 'not_allowlisted',
      voterJid
    };
  }

  const { selectedOptions, discardedLocalIds } = bot.mapVoteSelectionsToOptionIndices(
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

async function onVoteUpdate(bot, voteUpdate) {
  const pollMessageId = extractParentMessageId(voteUpdate);
  if (!pollMessageId) {
    return;
  }

  const poll = bot.db.getPollByMessageId(bot.config.groupId, pollMessageId);
  if (!poll || poll.status !== 'OPEN') {
    return;
  }

  const normalized = await bot.normalizeVoteUpdateForPoll(poll, voteUpdate);
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

  bot.db.upsertVote({
    pollId: poll.id,
    voterJid: normalized.voterJid,
    selectedOptions: normalized.selectedOptions,
    updatedAt: bot.now()
  });

  const summary = bot.summarizePoll(poll);
  if (summary.uniqueVoterCount >= bot.config.requiredVoters) {
    await bot.closePoll(poll.id, 'quorum');
  }
}

async function closePoll(bot, pollId, closeReason) {
  await bot.withPollLock(pollId, async () => {
    const poll = bot.db.getPollById(pollId);
    if (!poll || poll.status !== 'OPEN') {
      return;
    }

    bot.clearTimer(bot.closeTimers, pollId);

    const summary = bot.summarizePoll(poll);
    const closedAt = bot.now();

    if (summary.maxVotes <= 0 || summary.topIndices.length === 0) {
      const messageText = 'Poll closed. No votes were recorded this week.';
      bot.db.setAnnouncedWithOutbox({
        pollId,
        closeReason,
        closedAt,
        announcedAt: closedAt,
        winnerIdx: null,
        winnerVotes: 0,
        outboxMessage: bot.buildOutboxTextMessage(messageText, closedAt)
      });
      bot.observability.recordPollClosed(closeReason);

      await bot.drainOutboxQueue();
      return;
    }

    if (summary.topIndices.length > 1) {
      bot.observability.recordTieFlow();
      const tieDeadlineAt = closedAt + bot.config.tieOverrideHours * 60 * 60 * 1000;
      const tiedDescriptions = summary.topIndices
        .map((index) => `${index + 1}) ${poll.options[index].label}`)
        .join(' | ');
      const tieMessage = `Tie detected. Use ${bot.config.commandPrefix} pick <option_number> within ${bot.config.tieOverrideHours}h. Tied options: ${tiedDescriptions}`;

      bot.db.setTiePendingWithOutbox({
        pollId,
        closeReason,
        closedAt,
        tieDeadlineAt,
        tieOptionIndices: summary.topIndices,
        outboxMessage: bot.buildOutboxTextMessage(tieMessage, closedAt)
      });
      bot.observability.recordPollClosed(closeReason);

      bot.scheduleTieTimer(pollId, tieDeadlineAt);

      await bot.drainOutboxQueue();
      return;
    }

    await bot.maybeAnnounceAutomaticWinner(
      poll,
      summary.topIndices[0],
      summary.maxVotes,
      closeReason
    );
    bot.observability.recordPollClosed(closeReason);
  });
}

async function handleTieTimeout(bot, pollId) {
  await bot.withPollLock(pollId, async () => {
    const poll = bot.db.getPollById(pollId);
    if (!poll || poll.status !== 'TIE_PENDING') {
      return;
    }

    bot.clearTimer(bot.tieTimers, pollId);

    const tieCandidates = Array.from(new Set(poll.tieOptionIndices)).sort((a, b) => a - b);
    if (tieCandidates.length === 0) {
      await bot.sendGroupMessage('Tie resolution failed: no tie candidates found.');
      return;
    }

    const winnerIdx = tieCandidates[0];
    const summary = bot.summarizePoll(poll);
    const winnerVotes = summary.counts[winnerIdx] || 0;

    const announced = await bot.maybeAnnounceAutomaticWinner(
      poll,
      winnerIdx,
      winnerVotes,
      'tie-timeout'
    );
    if (announced) {
      return;
    }
  });
}

function finalizeWinner(bot, poll, winnerIdx, winnerVotes, closeReason) {
  const timestamp = bot.now();
  const slotLabel = poll.options[winnerIdx]?.label || `Option ${winnerIdx + 1}`;
  const voteWord = winnerVotes === 1 ? 'vote' : 'votes';
  const announcementText = `Weekly game slot selected: ${slotLabel} (${winnerVotes} ${voteWord}).`;

  bot.db.setAnnouncedWithOutbox({
    pollId: poll.id,
    closeReason,
    closedAt: poll.closedAt || timestamp,
    announcedAt: timestamp,
    winnerIdx,
    winnerVotes,
    outboxMessage: bot.buildOutboxTextMessage(announcementText, timestamp)
  });

  bot.clearTimer(bot.closeTimers, poll.id);
  bot.clearTimer(bot.tieTimers, poll.id);

  log('INFO', 'Winner announced.', {
    pollId: poll.id,
    winnerIdx,
    winnerVotes,
    closeReason
  });

  return announcementText;
}

async function announceWinner(bot, poll, winnerIdx, winnerVotes, closeReason) {
  bot.finalizeWinner(poll, winnerIdx, winnerVotes, closeReason);
  await bot.drainOutboxQueue();
}

module.exports = {
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
};

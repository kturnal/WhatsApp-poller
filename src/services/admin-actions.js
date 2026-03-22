function getTargetPoll(bot, pollId = null) {
  if (Number.isInteger(pollId)) {
    return bot.db.getPollById(pollId);
  }

  return bot.db.getActivePoll(bot.config.groupId);
}

function getTieResolutionStatus(bot, pollId = null) {
  const poll = getTargetPoll(bot, pollId);
  if (!poll) {
    return {
      status: pollId === null ? 'no_active_poll' : 'poll_not_found'
    };
  }

  const summary = bot.summarizePoll(poll);

  return {
    status: poll.status === 'TIE_PENDING' ? 'ok' : 'not_tie',
    poll,
    summary
  };
}

async function resolveTiePollByOption(bot, { pollId = null, optionIdx, closeReason }) {
  const target = getTieResolutionStatus(bot, pollId);
  if (target.status !== 'ok') {
    return target;
  }

  const lockResult = await bot.withPollLock(target.poll.id, async () => {
    const latest = bot.db.getPollById(target.poll.id);
    if (!latest) {
      return { status: 'poll_not_found' };
    }

    if (latest.status !== 'TIE_PENDING') {
      return {
        status: 'not_tie',
        poll: latest,
        summary: bot.summarizePoll(latest)
      };
    }

    const tiedOptionIndices = Array.isArray(latest.tieOptionIndices) ? latest.tieOptionIndices : [];
    if (!tiedOptionIndices.includes(optionIdx)) {
      return {
        status: 'invalid_option',
        poll: latest,
        summary: bot.summarizePoll(latest),
        tiedOptionNumbers: tiedOptionIndices.map((index) => index + 1)
      };
    }

    bot.clearTimer(bot.tieTimers, latest.id);

    const summary = bot.summarizePoll(latest);
    const winnerVotes = summary.counts[optionIdx] || 0;
    bot.finalizeWinner(latest, optionIdx, winnerVotes, closeReason);

    return {
      status: 'ok',
      poll: bot.db.getPollById(latest.id),
      summary,
      winnerIdx: optionIdx,
      winnerVotes
    };
  });

  if (lockResult === false) {
    return { status: 'busy' };
  }

  return lockResult;
}

async function resolveTiePollByTimeout(bot, pollId = null) {
  const target = getTieResolutionStatus(bot, pollId);
  if (target.status !== 'ok') {
    return target;
  }

  const timeoutResult = await bot.handleTieTimeout(target.poll.id);
  if (timeoutResult === false || timeoutResult?.status === 'busy') {
    return { status: 'busy' };
  }

  const updated = bot.db.getPollById(target.poll.id);
  if (!updated) {
    return { status: 'poll_not_found' };
  }

  return {
    status: updated.status === 'ANNOUNCED' ? 'ok' : 'not_tie',
    poll: updated,
    summary: bot.summarizePoll(updated)
  };
}

module.exports = {
  getTieResolutionStatus,
  resolveTiePollByOption,
  resolveTiePollByTimeout
};

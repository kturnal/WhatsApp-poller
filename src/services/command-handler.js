const { DateTime } = require('luxon');

const { getMessageSenderJid } = require('../message-utils');
const { log } = require('../logger');

const MAX_COMMAND_TOKENS = 6;

function isRateLimited(bot, senderJid) {
  const now = bot.now();
  const cutoff = now - bot.config.commandRateLimitWindowMs;

  for (const [jid, timestamps] of bot.commandWindows.entries()) {
    const filtered = timestamps.filter((timestamp) => timestamp > cutoff);
    if (filtered.length === 0) {
      bot.commandWindows.delete(jid);
    } else {
      bot.commandWindows.set(jid, filtered);
    }
  }

  const senderTimestamps = bot.commandWindows.get(senderJid) || [];

  if (senderTimestamps.length >= bot.config.commandRateLimitCount) {
    return true;
  }

  senderTimestamps.push(now);
  bot.commandWindows.set(senderJid, senderTimestamps);

  return false;
}

async function onMessageCreate(bot, message) {
  const body = message.body?.trim();
  if (!body) {
    return;
  }

  if (message.from !== bot.config.groupId) {
    return;
  }

  const firstToken = body.split(/\s+/, 1)[0];
  if (!firstToken || firstToken.toLowerCase() !== bot.config.commandPrefix.toLowerCase()) {
    return;
  }

  if (body.length > bot.config.commandMaxLength) {
    log('WARN', 'Ignoring command: payload is too long.', {
      bodyLength: body.length,
      limit: bot.config.commandMaxLength
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

  if (bot.isRateLimited(senderJid)) {
    log('WARN', 'Rate-limited incoming command.', {
      senderJid,
      windowMs: bot.config.commandRateLimitWindowMs,
      limit: bot.config.commandRateLimitCount
    });
    return;
  }

  const subCommand = (parts[1] || 'help').toLowerCase();

  if (subCommand === 'help') {
    await bot.sendGroupMessage(bot.helpText());
    return;
  }

  if (subCommand === 'status') {
    await bot.sendGroupMessage(bot.buildStatusText());
    return;
  }

  if (subCommand === 'pick') {
    await bot.handleManualPick(message, parts[2]);
    return;
  }

  await bot.sendGroupMessage(bot.helpText());
}

function helpText(bot) {
  return [
    'Commands:',
    `${bot.config.commandPrefix} help`,
    `${bot.config.commandPrefix} status`,
    `${bot.config.commandPrefix} pick <option_number> (owner only, tie only)`
  ].join('\n');
}

function buildStatusText(bot) {
  const active = bot.db.getActivePoll(bot.config.groupId);

  if (!active) {
    const latest = bot.db.getLatestPoll(bot.config.groupId);
    if (!latest) {
      return 'No poll has been created yet.';
    }

    const announcedAt = latest.announcedAt
      ? DateTime.fromMillis(latest.announcedAt, { zone: bot.config.timezone }).toFormat(
          'ccc LLL d HH:mm'
        )
      : 'n/a';

    if (Number.isInteger(latest.winningOptionIdx)) {
      return `No active poll. Last winner: ${latest.options[latest.winningOptionIdx].label} (${latest.winnerVoteCount} votes), announced ${announcedAt}.`;
    }

    return `No active poll. Last poll had no winner (announced ${announcedAt}).`;
  }

  const summary = bot.summarizePoll(active);
  const topDescription = summary.topIndices.length
    ? summary.topIndices
        .map(
          (index) => `${index + 1}) ${active.options[index].label} - ${summary.counts[index]} votes`
        )
        .join(' | ')
    : 'No votes yet';

  if (active.status === 'OPEN') {
    const closesAtText = DateTime.fromMillis(active.closesAt, {
      zone: bot.config.timezone
    }).toFormat('ccc LLL d HH:mm');

    return `Active poll (${active.weekKey})\nVoters: ${summary.uniqueVoterCount}/${bot.config.requiredVoters}\nTop: ${topDescription}\nCloses: ${closesAtText}`;
  }

  const tieDeadline = DateTime.fromMillis(active.tieDeadlineAt, {
    zone: bot.config.timezone
  }).toFormat('ccc LLL d HH:mm');

  return `Tie pending (${active.weekKey})\nTop: ${topDescription}\nManual pick deadline: ${tieDeadline}`;
}

function isOwnerMessage(bot, message) {
  const senderJid = getMessageSenderJid(message);
  return senderJid === bot.config.ownerJid;
}

async function handleManualPick(bot, message, optionRaw) {
  if (!bot.isOwnerMessage(message)) {
    await bot.sendGroupMessage('Only the owner can run tie-break pick.');
    return;
  }

  const active = bot.db.getActivePoll(bot.config.groupId);
  if (!active || active.status !== 'TIE_PENDING') {
    await bot.sendGroupMessage('No tie is waiting for manual pick right now.');
    return;
  }

  if (!/^\d+$/.test(String(optionRaw || ''))) {
    await bot.sendGroupMessage(`Usage: ${bot.config.commandPrefix} pick <option_number>`);
    return;
  }

  const optionNumber = Number.parseInt(optionRaw, 10);
  if (!Number.isInteger(optionNumber) || optionNumber < 1) {
    await bot.sendGroupMessage(`Usage: ${bot.config.commandPrefix} pick <option_number>`);
    return;
  }

  const optionIdx = optionNumber - 1;

  const lockResult = await bot.withPollLock(active.id, async () => {
    const latest = bot.db.getPollById(active.id);
    if (!latest || latest.status !== 'TIE_PENDING') {
      return { status: 'no_tie' };
    }

    if (!latest.tieOptionIndices.includes(optionIdx)) {
      return {
        status: 'invalid_option',
        tied: latest.tieOptionIndices.map((index) => index + 1)
      };
    }

    bot.clearTimer(bot.tieTimers, latest.id);

    const summary = bot.summarizePoll(latest);
    const winnerVotes = summary.counts[optionIdx] || 0;
    bot.finalizeWinner(latest, optionIdx, winnerVotes, 'manual-override');

    return { status: 'ok' };
  });

  if (lockResult === false) {
    await bot.sendGroupMessage('Another tie operation is in progress. Please retry in a moment.');
    return;
  }

  if (lockResult.status === 'no_tie') {
    await bot.sendGroupMessage('No tie is waiting for manual pick right now.');
    return;
  }

  if (lockResult.status === 'invalid_option') {
    await bot.sendGroupMessage(
      `Invalid option. Allowed tied option numbers: ${lockResult.tied.join(', ')}`
    );
    return;
  }

  if (lockResult.status === 'ok') {
    await bot.drainOutboxQueue();
  }
}

module.exports = {
  buildStatusText,
  handleManualPick,
  helpText,
  isOwnerMessage,
  isRateLimited,
  onMessageCreate
};

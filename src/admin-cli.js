require('dotenv').config();

const { DateTime } = require('luxon');

const { loadConfig } = require('./config');
const { errorMetadata, log } = require('./logger');
const { GameSchedulerBot } = require('./index');
const {
  getTieResolutionStatus,
  resolveTiePollByOption,
  resolveTiePollByTimeout
} = require('./services/admin-actions');

const DEFAULT_STARTUP_TIMEOUT_MS = 90 * 1000;

function buildUsageText() {
  return [
    'Usage:',
    '  npm run admin:poll -- status [--poll-id <id>]',
    '  npm run admin:poll -- pick <option_number> [--poll-id <id>]',
    '  npm run admin:poll -- timeout [--poll-id <id>]',
    '',
    'Commands:',
    '  status   Show the active tie state or a specific poll.',
    '  pick     Resolve a tie by selecting one tied option number.',
    '  timeout  Apply the automatic tie-timeout rule immediately.'
  ].join('\n');
}

function parseInteger(value, label) {
  if (!/^\d+$/.test(String(value || ''))) {
    throw new Error(`${label} must be a positive integer.`);
  }

  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }

  return parsed;
}

function parseAdminCliArgs(argv) {
  const args = Array.isArray(argv) ? [...argv] : [];
  const filtered = [];
  let pollId = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      return { help: true };
    }

    if (arg === '--poll-id') {
      pollId = parseInteger(args[index + 1], 'poll id');
      index += 1;
      continue;
    }

    if (typeof arg === 'string' && arg.startsWith('--poll-id=')) {
      pollId = parseInteger(arg.slice('--poll-id='.length), 'poll id');
      continue;
    }

    filtered.push(arg);
  }

  const command = (filtered[0] || '').toLowerCase();
  if (!command) {
    throw new Error('Missing command.');
  }

  if (!['status', 'pick', 'timeout'].includes(command)) {
    throw new Error(`Unknown command: ${command}`);
  }

  if (command === 'pick') {
    if (filtered.length !== 2) {
      throw new Error('Command pick requires a single <option_number>.');
    }

    return {
      command,
      pollId,
      optionNumber: parseInteger(filtered[1], 'option number')
    };
  }

  if (filtered.length > 1) {
    throw new Error(`Command ${command} does not accept positional arguments.`);
  }

  return {
    command,
    pollId
  };
}

function formatTimestamp(timestamp, timezone) {
  if (!Number.isInteger(timestamp)) {
    return 'n/a';
  }

  return DateTime.fromMillis(timestamp, { zone: timezone }).toFormat('yyyy-LL-dd HH:mm:ss ZZZZ');
}

function buildTopDescription(poll, summary) {
  if (!summary.topIndices?.length) {
    return 'No votes yet';
  }

  return summary.topIndices
    .map((index) => {
      const label = poll.options?.[index]?.label || `Option ${index + 1}`;
      const voteCount = summary.counts?.[index] || 0;
      return `${index + 1}) ${label} (${voteCount} votes)`;
    })
    .join(' | ');
}

function buildStatusOutput(bot, result) {
  if (result.status === 'no_active_poll') {
    return 'No active poll.';
  }

  if (result.status === 'poll_not_found') {
    return 'Poll not found.';
  }

  const { poll, summary } = result;
  const lines = [
    `Poll ID: ${poll.id}`,
    `Status: ${poll.status}`,
    `Week: ${poll.weekKey}`,
    `Created: ${formatTimestamp(poll.createdAt, bot.config.timezone)}`,
    `Top: ${buildTopDescription(poll, summary)}`
  ];

  if (result.status === 'not_tie') {
    if (poll.status === 'OPEN') {
      lines.push(`Closes: ${formatTimestamp(poll.closesAt, bot.config.timezone)}`);
      lines.push(`Voters: ${summary.uniqueVoterCount}/${bot.config.requiredVoters}`);
    } else {
      lines.push(`Closed: ${formatTimestamp(poll.closedAt, bot.config.timezone)}`);
      lines.push(`Announced: ${formatTimestamp(poll.announcedAt, bot.config.timezone)}`);
    }
    return lines.join('\n');
  }

  lines.push(`Tie deadline: ${formatTimestamp(poll.tieDeadlineAt, bot.config.timezone)}`);
  lines.push('Tied options:');

  for (const optionIdx of poll.tieOptionIndices || []) {
    const option = poll.options?.[optionIdx];
    const voteCount = summary.counts?.[optionIdx] || 0;
    lines.push(
      `  ${optionIdx + 1}) ${option?.label || `Option ${optionIdx + 1}`} (${voteCount} votes)`
    );
  }

  return lines.join('\n');
}

async function createDefaultBot(config, startupTimeoutMs) {
  const bot = new GameSchedulerBot(config, { skipAutomatedStartup: true });
  await bot.start();
  await bot.waitForStartup(startupTimeoutMs);
  return bot;
}

async function runAdminCli(argv, options = {}) {
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  let parsedArgs;

  try {
    parsedArgs = parseAdminCliArgs(argv);
  } catch (error) {
    stderr.write(`${error.message}\n\n${buildUsageText()}\n`);
    return 1;
  }

  if (parsedArgs.help) {
    stdout.write(`${buildUsageText()}\n`);
    return 0;
  }

  let config;
  try {
    config = (options.loadConfigFn || loadConfig)();
  } catch (error) {
    stderr.write(
      `Failed to load configuration: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return 1;
  }

  const startupTimeoutMs =
    Number.isInteger(options.startupTimeoutMs) && options.startupTimeoutMs > 0
      ? options.startupTimeoutMs
      : DEFAULT_STARTUP_TIMEOUT_MS;

  let bot = null;
  try {
    bot = await (options.createBot || createDefaultBot)(config, startupTimeoutMs);

    if (parsedArgs.command === 'status') {
      const status = getTieResolutionStatus(bot, parsedArgs.pollId);
      stdout.write(`${buildStatusOutput(bot, status)}\n`);
      return 0;
    }

    if (parsedArgs.command === 'pick') {
      const result = await resolveTiePollByOption(bot, {
        pollId: parsedArgs.pollId,
        optionIdx: parsedArgs.optionNumber - 1,
        closeReason: 'manual-override-cli'
      });

      if (result.status === 'ok') {
        await bot.drainOutboxQueue();
        const winnerLabel =
          result.poll?.options?.[result.winnerIdx]?.label || `Option ${parsedArgs.optionNumber}`;
        stdout.write(
          `Resolved poll ${result.poll.id} with option ${parsedArgs.optionNumber}: ${winnerLabel}\n`
        );
        return 0;
      }

      if (result.status === 'invalid_option') {
        stderr.write(
          `Option ${parsedArgs.optionNumber} is not tied. Allowed tied options: ${result.tiedOptionNumbers.join(', ')}\n`
        );
        return 1;
      }

      if (result.status === 'busy') {
        stderr.write('Another tie operation is already in progress.\n');
        return 1;
      }

      if (result.status === 'not_tie') {
        stderr.write('Target poll is not waiting for tie resolution.\n');
        return 1;
      }

      const missingText =
        result.status === 'poll_not_found'
          ? 'Poll not found.\n'
          : 'No active poll is waiting for tie resolution.\n';
      stderr.write(missingText);
      return 1;
    }

    const result = await resolveTiePollByTimeout(bot, parsedArgs.pollId);
    if (result.status !== 'ok') {
      if (result.status === 'not_tie') {
        stderr.write('Target poll is not waiting for tie resolution.\n');
      } else {
        const missingText =
          result.status === 'poll_not_found'
            ? 'Poll not found.\n'
            : 'No active poll is waiting for tie resolution.\n';
        stderr.write(missingText);
      }
      return 1;
    }

    if (Number.isInteger(result.poll.winningOptionIdx)) {
      const winnerLabel =
        result.poll.options?.[result.poll.winningOptionIdx]?.label ||
        `Option ${result.poll.winningOptionIdx + 1}`;
      stdout.write(`Timed out poll ${result.poll.id}. Winner: ${winnerLabel}\n`);
      return 0;
    }

    stdout.write(`Timed out poll ${result.poll.id}. Poll closed without a winner announcement.\n`);
    return 0;
  } catch (error) {
    stderr.write(`Admin CLI failed: ${error instanceof Error ? error.message : String(error)}\n`);
    log('ERROR', 'Admin CLI failed.', errorMetadata(error));
    return 1;
  } finally {
    if (bot) {
      try {
        await bot.shutdown('admin-cli');
      } catch (error) {
        stderr.write(
          `Admin CLI shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`
        );
      }
    }
  }
}

if (require.main === module) {
  runAdminCli(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      log('ERROR', 'Fatal admin CLI error.', errorMetadata(error));
      process.exitCode = 1;
    });
}

module.exports = {
  buildStatusOutput,
  buildUsageText,
  parseAdminCliArgs,
  runAdminCli
};

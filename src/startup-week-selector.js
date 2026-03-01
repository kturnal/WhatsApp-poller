const readline = require('node:readline/promises');
const process = require('node:process');

const {
  formatWeekDateRangeLabel,
  isCurrentOrFutureWeek,
  parseWeekSpecifier
} = require('./poll-slots');

function parseYesNo(raw) {
  const value = String(raw || '')
    .trim()
    .toLowerCase();

  if (value === 'y' || value === 'yes') {
    return true;
  }

  if (value === 'n' || value === 'no') {
    return false;
  }

  return null;
}

async function promptForWeekSelection({ config, ask, output, nowMillis }) {
  while (true) {
    const rawWeek = await ask('Select target week (YYYY-Www or YYYY W##): ');
    const parsed = parseWeekSpecifier(rawWeek);
    if (!parsed) {
      output.write('Invalid week format. Use YYYY-Www (example: 2026-W10).\n');
      continue;
    }

    if (!isCurrentOrFutureWeek(config.timezone, parsed.weekYear, parsed.weekNumber, nowMillis)) {
      output.write('Past weeks are not allowed. Select the current or a future week.\n');
      continue;
    }

    const weekLabel = formatWeekDateRangeLabel(config.timezone, parsed.weekYear, parsed.weekNumber);
    const confirmation = parseYesNo(await ask(`Use ${weekLabel}? (y/n): `));
    if (confirmation === null) {
      output.write('Please answer y or n.\n');
      continue;
    }

    if (!confirmation) {
      output.write('Week selection canceled. Enter another week.\n');
      continue;
    }

    return {
      ...parsed,
      weekLabel
    };
  }
}

async function promptForReplacement({ ask, output, weekLabel }) {
  while (true) {
    const answer = parseYesNo(
      await ask(`A poll already exists for ${weekLabel}. Replace it with a new poll? (y/n): `)
    );
    if (answer === null) {
      output.write('Please answer y or n.\n');
      continue;
    }
    return answer;
  }
}

/**
 * Resolve startup week selection action for interactive week-selection mode.
 *
 * @param {{
 *   config: {timezone:string, targetWeek:string|null, groupId:string},
 *   db: {getPollByWeekKey:(groupId:string, weekKey:string) => object|null},
 *   nowMillis?: number,
 *   input?: import('node:stream').Readable,
 *   output?: import('node:stream').Writable,
 *   ask?: (question:string) => Promise<string>,
 *   hasTty?: boolean
 * }} params
 * @returns {Promise<{action:'create'|'replace'|'skip', weekYear:number, weekNumber:number, weekKey:string, weekLabel:string, existingPollId:number|null}>}
 */
async function resolveStartupWeekSelection(params) {
  const {
    config,
    db,
    nowMillis = Date.now(),
    input = process.stdin,
    output = process.stdout,
    ask: providedAsk,
    hasTty = Boolean(input?.isTTY && output?.isTTY)
  } = params;

  let closeReadline = () => {};
  let ask = providedAsk;

  if (!ask) {
    const rl = readline.createInterface({ input, output });
    ask = (question) => rl.question(question);
    closeReadline = () => {
      rl.close();
    };
  }

  try {
    let selection;
    if (config.targetWeek) {
      const parsed = parseWeekSpecifier(config.targetWeek);
      if (!parsed) {
        throw new Error('TARGET_WEEK must use format YYYY-Www (example: 2026-W10).');
      }

      if (!isCurrentOrFutureWeek(config.timezone, parsed.weekYear, parsed.weekNumber, nowMillis)) {
        throw new Error('TARGET_WEEK must be the current week or a future week.');
      }

      selection = {
        ...parsed,
        weekLabel: formatWeekDateRangeLabel(config.timezone, parsed.weekYear, parsed.weekNumber)
      };
    } else {
      if (!hasTty) {
        throw new Error(
          'WEEK_SELECTION_MODE=interactive requires a TTY prompt or TARGET_WEEK to run non-interactively.'
        );
      }
      selection = await promptForWeekSelection({ config, ask, output, nowMillis });
    }

    const existing = db.getPollByWeekKey(config.groupId, selection.weekKey);
    if (!existing) {
      return {
        action: 'create',
        ...selection,
        existingPollId: null
      };
    }

    if (!hasTty) {
      throw new Error(
        `A poll already exists for ${selection.weekLabel}. Re-run with TTY to confirm replacement.`
      );
    }

    const shouldReplace = await promptForReplacement({
      ask,
      output,
      weekLabel: selection.weekLabel
    });

    return {
      action: shouldReplace ? 'replace' : 'skip',
      ...selection,
      existingPollId: existing.id
    };
  } finally {
    closeReadline();
  }
}

module.exports = {
  resolveStartupWeekSelection
};

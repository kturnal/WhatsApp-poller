const { DateTime } = require('luxon');

const SLOT_TEMPLATE = [
  { weekday: 1, hour: 20, minute: 0 },
  { weekday: 2, hour: 20, minute: 0 },
  { weekday: 3, hour: 20, minute: 0 },
  { weekday: 4, hour: 20, minute: 0 },
  { weekday: 5, hour: 20, minute: 0 },
  { weekday: 6, hour: 10, minute: 0 },
  { weekday: 6, hour: 15, minute: 0 },
  { weekday: 6, hour: 20, minute: 0 },
  { weekday: 7, hour: 10, minute: 0 },
  { weekday: 7, hour: 15, minute: 0 },
  { weekday: 7, hour: 20, minute: 0 }
];

const CRON_WEEKDAY_TO_ISO = {
  SUN: 7,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6
};

function describeValue(value) {
  return typeof value === 'string' ? `"${value}"` : String(value);
}

function parseTemplateField(sourceName, index, fieldName, value, min, max) {
  if (!Number.isInteger(value)) {
    throw new Error(
      `${sourceName}[${index}].${fieldName} must be an integer between ${min} and ${max}; got ${describeValue(
        value
      )}.`
    );
  }

  if (value < min || value > max) {
    throw new Error(
      `${sourceName}[${index}].${fieldName} must be between ${min} and ${max}; got ${value}.`
    );
  }

  return value;
}

/**
 * Validate and normalize slot-template input.
 *
 * @param {*} template - Candidate template value.
 * @param {string} [sourceName='slot template'] - Source name used in error messages.
 * @returns {{weekday:number, hour:number, minute:number}[]} Normalized template.
 */
function validateSlotTemplate(template, sourceName = 'slot template') {
  if (!Array.isArray(template)) {
    throw new Error(`${sourceName} must be a JSON array.`);
  }

  if (template.length === 0) {
    throw new Error(`${sourceName} must contain at least one slot definition.`);
  }

  return template.map((slot, index) => {
    if (!slot || typeof slot !== 'object' || Array.isArray(slot)) {
      throw new Error(
        `${sourceName}[${index}] must be an object with weekday, hour, and minute fields.`
      );
    }

    return {
      weekday: parseTemplateField(sourceName, index, 'weekday', slot.weekday, 1, 7),
      hour: parseTemplateField(sourceName, index, 'hour', slot.hour, 0, 23),
      minute: parseTemplateField(sourceName, index, 'minute', slot.minute, 0, 59)
    };
  });
}

function parseFixedCronNumber(fieldName, rawValue, min, max) {
  if (!/^\d+$/.test(rawValue)) {
    throw new Error(
      `POLL_CRON must use a fixed ${fieldName} value between ${min} and ${max}; got "${rawValue}".`
    );
  }

  const value = Number.parseInt(rawValue, 10);
  if (value < min || value > max) {
    throw new Error(`POLL_CRON ${fieldName} must be between ${min} and ${max}; got ${value}.`);
  }

  return value;
}

function parseCronWeekday(rawValue) {
  const normalized = rawValue.trim().toUpperCase();

  if (/^\d+$/.test(normalized)) {
    const value = Number.parseInt(normalized, 10);
    if (value < 0 || value > 7) {
      throw new Error(
        `POLL_CRON day-of-week must be a single weekday value (0-7 or SUN-SAT); got "${rawValue}".`
      );
    }

    return value === 0 ? 7 : value;
  }

  const isoWeekday = CRON_WEEKDAY_TO_ISO[normalized];
  if (!isoWeekday) {
    throw new Error(
      `POLL_CRON day-of-week must be a single weekday value (0-7 or SUN-SAT); got "${rawValue}".`
    );
  }

  return isoWeekday;
}

/**
 * Parse the supported weekly POLL_CRON shape for startup catch-up.
 *
 * Supported shapes:
 * - `M H * * DOW`
 * - `S M H * * DOW`
 *
 * where second/minute/hour are fixed numeric values and DOW is a single weekday
 * expressed as 0-7 or SUN-SAT.
 *
 * @param {string} pollCron - Cron expression to parse.
 * @returns {{second:number, minute:number, hour:number, weekday:number}}
 */
function parseWeeklyPollCron(pollCron) {
  if (typeof pollCron !== 'string' || !pollCron.trim()) {
    throw new Error('POLL_CRON must be a non-empty string.');
  }

  const parts = pollCron.trim().split(/\s+/);
  if (parts.length !== 5 && parts.length !== 6) {
    throw new Error(
      'POLL_CRON must use 5 or 6 cron fields and represent a weekly schedule with a single day-of-week.'
    );
  }

  const hasSeconds = parts.length === 6;
  const second = hasSeconds ? parseFixedCronNumber('second', parts[0], 0, 59) : 0;
  const minute = parseFixedCronNumber('minute', parts[hasSeconds ? 1 : 0], 0, 59);
  const hour = parseFixedCronNumber('hour', parts[hasSeconds ? 2 : 1], 0, 23);
  const dayOfMonth = parts[hasSeconds ? 3 : 2];
  const month = parts[hasSeconds ? 4 : 3];
  const dayOfWeek = parts[hasSeconds ? 5 : 4];

  if (dayOfMonth !== '*') {
    throw new Error(
      'POLL_CRON must use "*" for day-of-month to keep weekly scheduling unambiguous.'
    );
  }

  if (month !== '*') {
    throw new Error('POLL_CRON must use "*" for month to keep weekly scheduling unambiguous.');
  }

  return {
    second,
    minute,
    hour,
    weekday: parseCronWeekday(dayOfWeek)
  };
}

/**
 * Builds a canonical week key from an ISO week-year and week number.
 * @param {number} weekYear - The ISO week-numbering year (e.g., 2024).
 * @param {number} weekNumber - The ISO week number (1–53).
 * @returns {string} The week key in the format "<weekYear>-W<WW>", where WW is the week number zero-padded to two digits (e.g., "2024-W05").
 */
function buildWeekKey(weekYear, weekNumber) {
  return `${weekYear}-W${String(weekNumber).padStart(2, '0')}`;
}

/**
 * Parse a week specifier from user/operator input.
 *
 * Supported input formats:
 * - `YYYY-Www` (e.g. `2026-W10`)
 * - `YYYY Www` (e.g. `2026 W10`)
 *
 * @param {string} raw - Raw input string.
 * @returns {{weekYear:number, weekNumber:number, weekKey:string}|null}
 */
function parseWeekSpecifier(raw) {
  if (typeof raw !== 'string') {
    return null;
  }

  const value = raw.trim();
  if (!value) {
    return null;
  }

  const match = value.match(/^(\d{4})\s*(?:-| )\s*[Ww](\d{1,2})$/);
  if (!match) {
    return null;
  }

  const weekYear = Number.parseInt(match[1], 10);
  const weekNumber = Number.parseInt(match[2], 10);

  if (!Number.isInteger(weekYear) || !Number.isInteger(weekNumber)) {
    return null;
  }

  if (weekNumber < 1 || weekNumber > 53) {
    return null;
  }

  const monday = DateTime.fromObject(
    {
      weekYear,
      weekNumber,
      weekday: 1,
      hour: 0,
      minute: 0,
      second: 0,
      millisecond: 0
    },
    { zone: 'UTC' }
  );

  if (!monday.isValid || monday.weekYear !== weekYear || monday.weekNumber !== weekNumber) {
    return null;
  }

  return {
    weekYear,
    weekNumber,
    weekKey: buildWeekKey(weekYear, weekNumber)
  };
}

/**
 * Produce week-related context for the current moment in a given timezone.
 *
 * @param {string} timezone - IANA timezone identifier used to construct the DateTime (e.g., "America/Los_Angeles").
 * @param {number} [nowMillis=Date.now()] - Epoch milliseconds representing the current instant; defaults to the current time.
 * @returns {{now: import("luxon").DateTime, weekYear: number, weekNumber: number, weekKey: string}} An object containing:
 *   - `now`: the Luxon DateTime for the provided instant in the given zone,
 *   - `weekYear`: the ISO week-numbering year for `now`,
 *   - `weekNumber`: the ISO week number for `now`,
 *   - `weekKey`: a canonical string key built from `weekYear` and `weekNumber` (e.g., "2024-W05").
 */
function currentWeekContext(timezone, nowMillis = Date.now()) {
  const now = DateTime.fromMillis(nowMillis, { zone: timezone });
  return {
    now,
    weekYear: now.weekYear,
    weekNumber: now.weekNumber,
    weekKey: buildWeekKey(now.weekYear, now.weekNumber)
  };
}

/**
 * Returns whether a target ISO week is the current week or in the future for a timezone.
 * @param {string} timezone - IANA timezone.
 * @param {number} weekYear - ISO week-numbering year.
 * @param {number} weekNumber - ISO week number (1-53).
 * @param {number} [nowMillis=Date.now()] - Epoch milliseconds for "now".
 * @returns {boolean}
 */
function isCurrentOrFutureWeek(timezone, weekYear, weekNumber, nowMillis = Date.now()) {
  const now = DateTime.fromMillis(nowMillis, { zone: timezone });
  const currentWeekStart = DateTime.fromObject(
    {
      weekYear: now.weekYear,
      weekNumber: now.weekNumber,
      weekday: 1,
      hour: 0,
      minute: 0,
      second: 0,
      millisecond: 0
    },
    { zone: timezone }
  );

  const targetWeekStart = DateTime.fromObject(
    {
      weekYear,
      weekNumber,
      weekday: 1,
      hour: 0,
      minute: 0,
      second: 0,
      millisecond: 0
    },
    { zone: timezone }
  );

  return targetWeekStart.isValid && targetWeekStart.toMillis() >= currentWeekStart.toMillis();
}

/**
 * Build an operator-facing week label with date range.
 * Example: `2026 W10 March 2 - March 8`.
 *
 * @param {string} timezone - IANA timezone.
 * @param {number} weekYear - ISO week-numbering year.
 * @param {number} weekNumber - ISO week number (1-53).
 * @returns {string}
 */
function formatWeekDateRangeLabel(timezone, weekYear, weekNumber) {
  const weekStart = DateTime.fromObject(
    {
      weekYear,
      weekNumber,
      weekday: 1,
      hour: 0,
      minute: 0,
      second: 0,
      millisecond: 0
    },
    { zone: timezone }
  );

  const weekEnd = weekStart.plus({ days: 6 });
  return `${weekYear} W${String(weekNumber).padStart(2, '0')} ${weekStart.toFormat(
    'LLLL d'
  )} - ${weekEnd.toFormat('LLLL d')}`;
}

/**
 * Build a list of scheduled slot option objects for a given ISO week in a timezone.
 *
 * @param {string} timezone - IANA timezone identifier (e.g., "America/Los_Angeles").
 * @param {number} weekYear - ISO week-numbering year.
 * @param {number} weekNumber - ISO week number (1–53).
 * @param {{weekday:number, hour:number, minute:number}[]} [slotTemplate=SLOT_TEMPLATE] - Slot template to use.
 * @returns {Array<Object>} An array of slot option objects. Each object contains:
 *   - index {number} : position of the slot in the template.
 *   - label {string} : human-readable weekday/time and abbreviated date (e.g., "Mon 12:00 (Feb 3)").
 *   - iso {string} : ISO-8601 timestamp for the slot in the given timezone.
 *   - weekday {number} : weekday number (1 = Monday … 7 = Sunday).
 *   - hour {number} : hour of day (0–23).
 *   - minute {number} : minute of hour (0–59).
 */
function buildOptionsForWeek(timezone, weekYear, weekNumber, slotTemplate = SLOT_TEMPLATE) {
  return slotTemplate.map((slot, index) => {
    const dt = DateTime.fromObject(
      {
        weekYear,
        weekNumber,
        weekday: slot.weekday,
        hour: slot.hour,
        minute: slot.minute
      },
      { zone: timezone }
    );

    return {
      index,
      label: `${dt.toFormat('ccc HH:mm')} (${dt.toFormat('LLL d')})`,
      iso: dt.toISO(),
      weekday: slot.weekday,
      hour: slot.hour,
      minute: slot.minute
    };
  });
}

/**
 * Create a Luxon DateTime for the configured weekly POLL_CRON occurrence in the specified ISO week.
 * @param {string} timezone - IANA timezone name to use for the DateTime.
 * @param {number} weekYear - ISO week-numbering year.
 * @param {number} weekNumber - ISO week number (1-53).
 * @param {string} [pollCron='0 12 * * 1'] - Weekly cron expression used to anchor startup catch-up.
 * @returns {import('luxon').DateTime} DateTime representing the configured weekly run in the specified ISO week in the given zone.
 */
function scheduledWeeklyRunForWeek(timezone, weekYear, weekNumber, pollCron = '0 12 * * 1') {
  const schedule = parseWeeklyPollCron(pollCron);

  return DateTime.fromObject(
    {
      weekYear,
      weekNumber,
      weekday: schedule.weekday,
      hour: schedule.hour,
      minute: schedule.minute,
      second: schedule.second,
      millisecond: 0
    },
    { zone: timezone }
  );
}

module.exports = {
  SLOT_TEMPLATE,
  validateSlotTemplate,
  parseWeeklyPollCron,
  buildWeekKey,
  parseWeekSpecifier,
  currentWeekContext,
  isCurrentOrFutureWeek,
  formatWeekDateRangeLabel,
  buildOptionsForWeek,
  scheduledWeeklyRunForWeek
};

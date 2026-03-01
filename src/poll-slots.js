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
 * Create a Luxon DateTime for Monday at 12:00:00 of the specified ISO week in the given timezone.
 * @param {string} timezone - IANA timezone name to use for the DateTime.
 * @param {number} weekYear - ISO week-numbering year.
 * @param {number} weekNumber - ISO week number (1-53).
 * @returns {import('luxon').DateTime} DateTime representing Monday at 12:00:00 of the specified ISO week in the given zone.
 */
function scheduledWeeklyRunForWeek(timezone, weekYear, weekNumber) {
  return DateTime.fromObject(
    {
      weekYear,
      weekNumber,
      weekday: 1,
      hour: 12,
      minute: 0,
      second: 0,
      millisecond: 0
    },
    { zone: timezone }
  );
}

module.exports = {
  SLOT_TEMPLATE,
  validateSlotTemplate,
  buildWeekKey,
  parseWeekSpecifier,
  currentWeekContext,
  isCurrentOrFutureWeek,
  formatWeekDateRangeLabel,
  buildOptionsForWeek,
  scheduledWeeklyRunForWeek
};

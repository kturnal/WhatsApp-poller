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
 * Build a list of scheduled slot option objects for a given ISO week in a timezone.
 *
 * @param {string} timezone - IANA timezone identifier (e.g., "America/Los_Angeles").
 * @param {number} weekYear - ISO week-numbering year.
 * @param {number} weekNumber - ISO week number (1–53).
 * @returns {Array<Object>} An array of slot option objects. Each object contains:
 *   - index {number} : position of the slot in the template.
 *   - label {string} : human-readable weekday/time and abbreviated date (e.g., "Mon 12:00 (Feb 3)").
 *   - iso {string} : ISO-8601 timestamp for the slot in the given timezone.
 *   - weekday {number} : weekday number (1 = Monday … 7 = Sunday).
 *   - hour {number} : hour of day (0–23).
 *   - minute {number} : minute of hour (0–59).
 */
function buildOptionsForWeek(timezone, weekYear, weekNumber) {
  return SLOT_TEMPLATE.map((slot, index) => {
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
  buildWeekKey,
  currentWeekContext,
  buildOptionsForWeek,
  scheduledWeeklyRunForWeek
};

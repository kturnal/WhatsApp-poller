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

function buildWeekKey(weekYear, weekNumber) {
  return `${weekYear}-W${String(weekNumber).padStart(2, '0')}`;
}

function currentWeekContext(timezone, nowMillis = Date.now()) {
  const now = DateTime.fromMillis(nowMillis, { zone: timezone });
  return {
    now,
    weekYear: now.weekYear,
    weekNumber: now.weekNumber,
    weekKey: buildWeekKey(now.weekYear, now.weekNumber)
  };
}

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

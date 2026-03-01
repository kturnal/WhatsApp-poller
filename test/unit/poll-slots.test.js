const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SLOT_TEMPLATE,
  buildOptionsForWeek,
  buildWeekKey,
  currentWeekContext,
  formatWeekDateRangeLabel,
  isCurrentOrFutureWeek,
  parseWeekSpecifier,
  scheduledWeeklyRunForWeek
} = require('../../src/poll-slots');

test('buildWeekKey formats week identifiers', () => {
  assert.equal(buildWeekKey(2026, 3), '2026-W03');
});

test('buildOptionsForWeek returns all template slots for given ISO week', () => {
  const options = buildOptionsForWeek('Europe/Istanbul', 2026, 8);

  assert.equal(options.length, SLOT_TEMPLATE.length);
  assert.match(options[0].label, /Mon 20:00/);
  assert.equal(options[0].weekday, 1);
  assert.equal(options[options.length - 1].weekday, 7);
});

test('currentWeekContext includes ISO week key and timezone aware date', () => {
  const context = currentWeekContext('Europe/Istanbul', Date.UTC(2026, 1, 25, 12, 0, 0));

  assert.match(context.weekKey, /^\d{4}-W\d{2}$/);
  assert.equal(context.now.zoneName, 'Europe/Istanbul');
});

test('scheduledWeeklyRunForWeek points to Monday 12:00 in configured timezone', () => {
  const scheduled = scheduledWeeklyRunForWeek('Europe/Istanbul', 2026, 8);

  assert.equal(scheduled.weekday, 1);
  assert.equal(scheduled.hour, 12);
  assert.equal(scheduled.minute, 0);
  assert.equal(scheduled.zoneName, 'Europe/Istanbul');
});

test('parseWeekSpecifier parses supported formats and rejects invalid values', () => {
  assert.deepEqual(parseWeekSpecifier('2026-W10'), {
    weekYear: 2026,
    weekNumber: 10,
    weekKey: '2026-W10'
  });
  assert.deepEqual(parseWeekSpecifier('2026 W9'), {
    weekYear: 2026,
    weekNumber: 9,
    weekKey: '2026-W09'
  });
  assert.equal(parseWeekSpecifier('2026-W54'), null);
  assert.equal(parseWeekSpecifier('2026-W00'), null);
  assert.equal(parseWeekSpecifier('bad-input'), null);
});

test('formatWeekDateRangeLabel renders long month names', () => {
  const label = formatWeekDateRangeLabel('Europe/Istanbul', 2026, 10);
  assert.equal(label, '2026 W10 March 2 - March 8');
});

test('isCurrentOrFutureWeek allows current/future and rejects past week', () => {
  const nowMillis = Date.UTC(2026, 2, 1, 9, 0, 0); // Sunday, Mar 1 2026 -> ISO week 9
  assert.equal(isCurrentOrFutureWeek('Europe/Istanbul', 2026, 9, nowMillis), true);
  assert.equal(isCurrentOrFutureWeek('Europe/Istanbul', 2026, 10, nowMillis), true);
  assert.equal(isCurrentOrFutureWeek('Europe/Istanbul', 2026, 8, nowMillis), false);
});

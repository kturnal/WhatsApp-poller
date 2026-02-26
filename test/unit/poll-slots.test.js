const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SLOT_TEMPLATE,
  buildOptionsForWeek,
  buildWeekKey,
  currentWeekContext,
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

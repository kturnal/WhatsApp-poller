const test = require('node:test');
const assert = require('node:assert/strict');

const {
  describeInteractiveStartupMode,
  resolveStartupWeekSelection
} = require('../../src/startup-week-selector');

function createDbStub(existingByWeekKey = new Map()) {
  return {
    getPollByWeekKey(_groupId, weekKey) {
      return existingByWeekKey.get(weekKey) || null;
    }
  };
}

function createOutputCapture() {
  const lines = [];
  return {
    output: {
      write(value) {
        lines.push(String(value));
      }
    },
    lines
  };
}

test('resolveStartupWeekSelection prompts until valid current/future week is confirmed', async () => {
  const answers = ['invalid', '2026-W08', '2026-W10', 'y'];
  const { output, lines } = createOutputCapture();

  const selection = await resolveStartupWeekSelection({
    config: {
      timezone: 'Europe/Istanbul',
      targetWeek: null,
      groupId: '1234567890-123456789@g.us'
    },
    db: createDbStub(),
    nowMillis: Date.UTC(2026, 2, 1, 12, 0, 0),
    ask: async () => answers.shift(),
    output,
    hasTty: true
  });

  assert.equal(selection.action, 'create');
  assert.equal(selection.weekKey, '2026-W10');
  assert.equal(selection.weekLabel, '2026 W10 March 2 - March 8');
  assert.ok(lines.some((line) => line.includes('Invalid week format')));
  assert.ok(lines.some((line) => line.includes('Past weeks are not allowed')));
});

test('describeInteractiveStartupMode warns when interactive mode depends on TTY prompt', () => {
  assert.deepEqual(
    describeInteractiveStartupMode({
      weekSelectionMode: 'interactive',
      targetWeek: null
    }),
    {
      requiresPrompt: true,
      doctorStatus: 'WARN',
      doctorMessage:
        'WEEK_SELECTION_MODE=interactive without TARGET_WEEK depends on a TTY prompt and is unsafe for unattended restarts. Set TARGET_WEEK or switch to auto mode for always-on deployments.',
      nonInteractiveError:
        'WEEK_SELECTION_MODE=interactive requires a TTY prompt or TARGET_WEEK to run non-interactively.'
    }
  );
});

test('describeInteractiveStartupMode passes when interactive mode provides TARGET_WEEK', () => {
  assert.deepEqual(
    describeInteractiveStartupMode({
      weekSelectionMode: 'interactive',
      targetWeek: '2026-W10'
    }),
    {
      requiresPrompt: false,
      doctorStatus: 'PASS',
      doctorMessage:
        'Interactive startup will use TARGET_WEEK=2026-W10 when no TTY prompt is available.',
      nonInteractiveError: null
    }
  );
});

test('describeInteractiveStartupMode does not treat missing mode as auto', () => {
  assert.deepEqual(
    describeInteractiveStartupMode({
      targetWeek: null
    }),
    {
      requiresPrompt: true,
      doctorStatus: 'WARN',
      doctorMessage:
        'WEEK_SELECTION_MODE=interactive without TARGET_WEEK depends on a TTY prompt and is unsafe for unattended restarts. Set TARGET_WEEK or switch to auto mode for always-on deployments.',
      nonInteractiveError:
        'WEEK_SELECTION_MODE=interactive requires a TTY prompt or TARGET_WEEK to run non-interactively.'
    }
  );
});

test('resolveStartupWeekSelection returns replace when existing week is confirmed', async () => {
  const answers = ['2026-W10', 'y', 'y'];
  const existing = new Map([['2026-W10', { id: 42 }]]);

  const selection = await resolveStartupWeekSelection({
    config: {
      timezone: 'Europe/Istanbul',
      targetWeek: null,
      groupId: '1234567890-123456789@g.us'
    },
    db: createDbStub(existing),
    nowMillis: Date.UTC(2026, 2, 1, 12, 0, 0),
    ask: async () => answers.shift(),
    output: { write() {} },
    hasTty: true
  });

  assert.equal(selection.action, 'replace');
  assert.equal(selection.existingPollId, 42);
});

test('resolveStartupWeekSelection returns skip when existing week replacement is declined', async () => {
  const answers = ['2026-W10', 'y', 'n'];
  const existing = new Map([['2026-W10', { id: 51 }]]);

  const selection = await resolveStartupWeekSelection({
    config: {
      timezone: 'Europe/Istanbul',
      targetWeek: null,
      groupId: '1234567890-123456789@g.us'
    },
    db: createDbStub(existing),
    nowMillis: Date.UTC(2026, 2, 1, 12, 0, 0),
    ask: async () => answers.shift(),
    output: { write() {} },
    hasTty: true
  });

  assert.equal(selection.action, 'skip');
  assert.equal(selection.existingPollId, 51);
});

test('resolveStartupWeekSelection fails fast in interactive mode without tty and TARGET_WEEK', async () => {
  await assert.rejects(
    () =>
      resolveStartupWeekSelection({
        config: {
          timezone: 'Europe/Istanbul',
          targetWeek: null,
          groupId: '1234567890-123456789@g.us'
        },
        db: createDbStub(),
        nowMillis: Date.UTC(2026, 2, 1, 12, 0, 0),
        ask: async () => '2026-W10',
        output: { write() {} },
        hasTty: false
      }),
    /requires a TTY prompt or TARGET_WEEK/
  );
});

test('resolveStartupWeekSelection accepts TARGET_WEEK for non-interactive startup', async () => {
  const selection = await resolveStartupWeekSelection({
    config: {
      timezone: 'Europe/Istanbul',
      targetWeek: '2026-W10',
      groupId: '1234567890-123456789@g.us'
    },
    db: createDbStub(),
    nowMillis: Date.UTC(2026, 2, 1, 12, 0, 0),
    output: { write() {} },
    hasTty: false
  });

  assert.equal(selection.action, 'create');
  assert.equal(selection.weekLabel, '2026 W10 March 2 - March 8');
});

test('resolveStartupWeekSelection fails non-interactive replacement when selected week already exists', async () => {
  const existing = new Map([['2026-W10', { id: 7 }]]);

  await assert.rejects(
    () =>
      resolveStartupWeekSelection({
        config: {
          timezone: 'Europe/Istanbul',
          targetWeek: '2026-W10',
          groupId: '1234567890-123456789@g.us'
        },
        db: createDbStub(existing),
        nowMillis: Date.UTC(2026, 2, 1, 12, 0, 0),
        output: { write() {} },
        hasTty: false
      }),
    /already exists/
  );
});

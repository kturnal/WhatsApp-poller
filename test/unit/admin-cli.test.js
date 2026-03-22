const test = require('node:test');
const assert = require('node:assert/strict');

const { parseAdminCliArgs, runAdminCli } = require('../../src/admin-cli');
const { resolveTiePollByTimeout } = require('../../src/services/admin-actions');

test('parseAdminCliArgs parses pick command with poll id', () => {
  assert.deepEqual(parseAdminCliArgs(['pick', '11', '--poll-id', '4']), {
    command: 'pick',
    optionNumber: 11,
    pollId: 4
  });
});

test('parseAdminCliArgs rejects unknown commands', () => {
  assert.throws(() => {
    parseAdminCliArgs(['close']);
  }, /Unknown command: close/);
});

test('parseAdminCliArgs rejects pick with trailing positional arguments', () => {
  assert.throws(() => {
    parseAdminCliArgs(['pick', '11', 'extra']);
  }, /Command pick requires a single <option_number>\./);
});

test('runAdminCli prints tie status for active poll', async () => {
  let stdout = '';
  let stderr = '';
  const fakePoll = {
    id: 4,
    status: 'TIE_PENDING',
    weekKey: '2026-W12',
    createdAt: 1773653644849,
    tieDeadlineAt: 1774205501191,
    tieOptionIndices: [9, 10],
    options: Array.from({ length: 11 }, (_, index) => ({
      label: `Option ${index + 1}`
    }))
  };
  const fakeBot = {
    config: {
      groupId: 'group@g.us',
      timezone: 'Europe/Istanbul',
      requiredVoters: 5
    },
    db: {
      getActivePoll: () => fakePoll
    },
    summarizePoll: () => ({
      counts: Array.from({ length: 11 }, (_, index) => (index >= 9 ? 3 : 0)),
      topIndices: [9, 10],
      uniqueVoterCount: 3
    }),
    start: async () => {},
    waitForStartup: async () => {},
    shutdown: async () => {}
  };

  const exitCode = await runAdminCli(['status'], {
    stdout: {
      write: (chunk) => {
        stdout += chunk;
      }
    },
    stderr: {
      write: (chunk) => {
        stderr += chunk;
      }
    },
    loadConfigFn: () => ({
      groupId: 'group@g.us'
    }),
    createBot: async () => fakeBot
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr, '');
  assert.match(stdout, /Poll ID: 4/);
  assert.match(stdout, /Status: TIE_PENDING/);
  assert.match(stdout, /10\) Option 10 \(3 votes\)/);
  assert.match(stdout, /11\) Option 11 \(3 votes\)/);
});

test('resolveTiePollByTimeout returns busy when handleTieTimeout loses the lock', async () => {
  const fakePoll = {
    id: 4,
    status: 'TIE_PENDING',
    weekKey: '2026-W12'
  };
  const fakeBot = {
    config: {
      groupId: 'group@g.us'
    },
    db: {
      getActivePoll: () => fakePoll,
      getPollById: () => fakePoll
    },
    summarizePoll: () => ({
      counts: [],
      topIndices: [],
      uniqueVoterCount: 0
    }),
    handleTieTimeout: async () => false
  };

  const result = await resolveTiePollByTimeout(fakeBot);
  assert.deepEqual(result, { status: 'busy' });
});

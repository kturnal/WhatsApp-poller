const test = require('node:test');
const assert = require('node:assert/strict');

const { BotObservability } = require('../../src/observability');

test('health endpoints expose liveness and readiness transitions', async (t) => {
  const observability = new BotObservability({
    host: '127.0.0.1',
    port: 0
  });

  await observability.start();
  const port = observability.getListeningPort();

  t.after(async () => {
    await observability.stop();
  });

  const liveResponse = await fetch(`http://127.0.0.1:${port}/health/live`);
  assert.equal(liveResponse.status, 200);
  const livePayload = await liveResponse.json();
  assert.equal(livePayload.status, 'alive');
  assert.equal(livePayload.processHealthy, true);

  const notReadyResponse = await fetch(`http://127.0.0.1:${port}/health/ready`);
  assert.equal(notReadyResponse.status, 503);
  const notReadyPayload = await notReadyResponse.json();
  assert.equal(notReadyPayload.ready, false);

  observability.markClientReady();
  observability.markStartupComplete();

  const readyResponse = await fetch(`http://127.0.0.1:${port}/health/ready`);
  assert.equal(readyResponse.status, 200);
  const readyPayload = await readyResponse.json();
  assert.equal(readyPayload.ready, true);

  observability.markClientDisconnected();

  const disconnectedResponse = await fetch(`http://127.0.0.1:${port}/health/ready`);
  assert.equal(disconnectedResponse.status, 503);
  const disconnectedPayload = await disconnectedResponse.json();
  assert.equal(disconnectedPayload.ready, false);
  assert.equal(disconnectedPayload.checks.whatsappReady, false);
});

test('metrics endpoint exposes counters and runtime gauges', async (t) => {
  const observability = new BotObservability({
    host: '127.0.0.1',
    port: 0,
    collectRuntimeGauges: () => ({
      activePolls: 1,
      outboxRetryableMessages: 2
    })
  });

  await observability.start();
  const port = observability.getListeningPort();

  t.after(async () => {
    await observability.stop();
  });

  observability.markClientReady();
  observability.markStartupComplete();
  observability.recordPollCreated();
  observability.recordPollClosed('quorum');
  observability.recordTieFlow();
  observability.recordOutboxFailure(true);
  observability.recordOutboxFailure(false);
  observability.markClientDisconnected();
  observability.markClientReady();
  observability.markStartupComplete();

  const metricsResponse = await fetch(`http://127.0.0.1:${port}/metrics`);
  assert.equal(metricsResponse.status, 200);
  const body = await metricsResponse.text();

  assert.match(body, /whatsapp_poller_polls_created_total 1/);
  assert.match(body, /whatsapp_poller_polls_closed_total 1/);
  assert.match(body, /whatsapp_poller_poll_closes_quorum_total 1/);
  assert.match(body, /whatsapp_poller_poll_tie_flows_total 1/);
  assert.match(body, /whatsapp_poller_outbox_send_failures_total 2/);
  assert.match(body, /whatsapp_poller_outbox_send_retries_total 1/);
  assert.match(body, /whatsapp_poller_client_disconnects_total 1/);
  assert.match(body, /whatsapp_poller_client_reconnects_total 1/);
  assert.match(body, /whatsapp_poller_active_polls 1/);
  assert.match(body, /whatsapp_poller_outbox_retryable_messages 2/);
});

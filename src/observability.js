const http = require('node:http');

function toNonNegativeNumber(value, fallback = 0) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  return value >= 0 ? value : fallback;
}

class BotObservability {
  constructor(options = {}) {
    this.port = Number.isInteger(options.port) ? options.port : null;
    this.host =
      typeof options.host === 'string' && options.host.trim() ? options.host.trim() : '0.0.0.0';
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.collectRuntimeGauges =
      typeof options.collectRuntimeGauges === 'function'
        ? options.collectRuntimeGauges
        : () => ({});

    this.server = null;
    this.listeningPort = null;
    this.startedAtMs = this.now();
    this.processHealthy = true;
    this.whatsappReady = false;
    this.startupComplete = false;
    this.hasEverBeenReady = false;

    this.counters = {
      pollsCreatedTotal: 0,
      pollsClosedTotal: 0,
      quorumClosesTotal: 0,
      tieFlowsTotal: 0,
      outboxSendFailuresTotal: 0,
      outboxSendRetriesTotal: 0,
      clientDisconnectsTotal: 0,
      clientReconnectsTotal: 0
    };
  }

  async start() {
    if (this.server) {
      return this.listeningPort;
    }

    if (this.port === null) {
      return null;
    }

    if (!Number.isInteger(this.port) || this.port < 0 || this.port > 65535) {
      throw new Error(`Invalid observability port: ${this.port}`);
    }

    this.server = http.createServer((request, response) => {
      this.handleHttpRequest(request, response);
    });

    return new Promise((resolve, reject) => {
      const server = this.server;
      const cleanupListeners = () => {
        server.off('error', onError);
        server.off('listening', onListening);
      };

      const rejectWithCleanup = (error) => {
        cleanupListeners();
        if (this.server === server) {
          this.server = null;
          this.listeningPort = null;
        }
        reject(error);
      };

      const onError = (error) => {
        rejectWithCleanup(error);
      };

      const onListening = () => {
        cleanupListeners();
        if (this.server !== server) {
          server.close(() => {});
          rejectWithCleanup(new Error('Observability server instance changed during startup.'));
          return;
        }

        const address = server.address();
        this.listeningPort =
          address && typeof address === 'object' && Number.isInteger(address.port)
            ? address.port
            : this.port;
        resolve(this.listeningPort);
      };

      server.once('error', onError);
      server.once('listening', onListening);
      try {
        server.listen({ host: this.host, port: this.port });
      } catch (error) {
        rejectWithCleanup(error);
      }
    });
  }

  async stop() {
    if (!this.server) {
      return;
    }

    const server = this.server;
    this.server = null;
    this.listeningPort = null;

    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  getListeningPort() {
    return this.listeningPort;
  }

  markStartupPending() {
    this.startupComplete = false;
  }

  markStartupComplete() {
    this.startupComplete = true;
  }

  markShutdownStarted() {
    this.processHealthy = false;
    this.whatsappReady = false;
    this.startupComplete = false;
  }

  markClientReady() {
    const reconnect = this.hasEverBeenReady && !this.whatsappReady;
    this.whatsappReady = true;
    this.hasEverBeenReady = true;

    if (reconnect) {
      this.counters.clientReconnectsTotal += 1;
    }
  }

  markClientNotReady() {
    this.whatsappReady = false;
    this.startupComplete = false;
  }

  markClientDisconnected() {
    this.counters.clientDisconnectsTotal += 1;
    this.markClientNotReady();
  }

  recordPollCreated() {
    this.counters.pollsCreatedTotal += 1;
  }

  recordPollClosed(closeReason) {
    this.counters.pollsClosedTotal += 1;
    if (closeReason === 'quorum') {
      this.counters.quorumClosesTotal += 1;
    }
  }

  recordTieFlow() {
    this.counters.tieFlowsTotal += 1;
  }

  recordOutboxFailure(willRetry) {
    this.counters.outboxSendFailuresTotal += 1;
    if (willRetry) {
      this.counters.outboxSendRetriesTotal += 1;
    }
  }

  isReady() {
    return this.processHealthy && this.whatsappReady && this.startupComplete;
  }

  handleHttpRequest(request, response) {
    const method = request.method || 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      this.sendJson(
        response,
        method,
        405,
        { error: 'Method not allowed. Use GET /health/live, /health/ready, or /metrics.' },
        { Allow: 'GET, HEAD' }
      );
      return;
    }

    let pathname;
    try {
      pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
    } catch {
      this.sendJson(response, method, 400, { error: 'Invalid request URL.' });
      return;
    }

    if (pathname === '/health/live') {
      const healthy = this.processHealthy;
      this.sendJson(response, method, healthy ? 200 : 503, {
        status: healthy ? 'alive' : 'stopping',
        processHealthy: healthy,
        uptimeSeconds: this.getUptimeSeconds()
      });
      return;
    }

    if (pathname === '/health/ready') {
      const ready = this.isReady();
      this.sendJson(response, method, ready ? 200 : 503, {
        status: ready ? 'ready' : 'not_ready',
        ready,
        checks: {
          processHealthy: this.processHealthy,
          whatsappReady: this.whatsappReady,
          startupComplete: this.startupComplete
        }
      });
      return;
    }

    if (pathname === '/metrics') {
      const body = this.renderPrometheusMetrics();
      this.sendText(response, method, 200, body, {
        'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      return;
    }

    this.sendJson(response, method, 404, { error: 'Not found.' });
  }

  getUptimeSeconds() {
    const uptimeMs = Math.max(0, this.now() - this.startedAtMs);
    return Number((uptimeMs / 1000).toFixed(3));
  }

  sendJson(response, method, statusCode, payload, headers = {}) {
    this.sendText(response, method, statusCode, JSON.stringify(payload), {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers
    });
  }

  sendText(response, method, statusCode, body, headers = {}) {
    response.statusCode = statusCode;
    for (const [key, value] of Object.entries(headers)) {
      response.setHeader(key, value);
    }

    if (method === 'HEAD') {
      response.end();
      return;
    }

    response.end(body);
  }

  readRuntimeGauges() {
    let values;
    try {
      values = this.collectRuntimeGauges();
    } catch {
      values = null;
    }

    const gauges = values && typeof values === 'object' ? values : {};

    return {
      activePolls: toNonNegativeNumber(gauges.activePolls, 0),
      outboxRetryableMessages: toNonNegativeNumber(gauges.outboxRetryableMessages, 0)
    };
  }

  metricLine(name, value) {
    const safeValue = Number.isFinite(value) ? value : 0;
    return `${name} ${safeValue}`;
  }

  renderPrometheusMetrics() {
    const runtime = this.readRuntimeGauges();
    const nowMs = this.now();
    const metrics = [
      {
        name: 'whatsapp_poller_polls_created_total',
        help: 'Total number of polls created.',
        type: 'counter',
        value: this.counters.pollsCreatedTotal
      },
      {
        name: 'whatsapp_poller_polls_closed_total',
        help: 'Total number of polls closed.',
        type: 'counter',
        value: this.counters.pollsClosedTotal
      },
      {
        name: 'whatsapp_poller_poll_closes_quorum_total',
        help: 'Total number of polls closed by quorum.',
        type: 'counter',
        value: this.counters.quorumClosesTotal
      },
      {
        name: 'whatsapp_poller_poll_tie_flows_total',
        help: 'Total number of tie flows entered.',
        type: 'counter',
        value: this.counters.tieFlowsTotal
      },
      {
        name: 'whatsapp_poller_outbox_send_failures_total',
        help: 'Total number of outbox send failures.',
        type: 'counter',
        value: this.counters.outboxSendFailuresTotal
      },
      {
        name: 'whatsapp_poller_outbox_send_retries_total',
        help: 'Total number of retry attempts scheduled after outbox send failures.',
        type: 'counter',
        value: this.counters.outboxSendRetriesTotal
      },
      {
        name: 'whatsapp_poller_client_disconnects_total',
        help: 'Total number of WhatsApp client disconnect events.',
        type: 'counter',
        value: this.counters.clientDisconnectsTotal
      },
      {
        name: 'whatsapp_poller_client_reconnects_total',
        help: 'Total number of WhatsApp client reconnect events.',
        type: 'counter',
        value: this.counters.clientReconnectsTotal
      },
      {
        name: 'whatsapp_poller_process_healthy',
        help: 'Whether the bot process is healthy (1) or shutting down (0).',
        type: 'gauge',
        value: this.processHealthy ? 1 : 0
      },
      {
        name: 'whatsapp_poller_whatsapp_ready',
        help: 'Whether the WhatsApp client is currently ready (1) or not (0).',
        type: 'gauge',
        value: this.whatsappReady ? 1 : 0
      },
      {
        name: 'whatsapp_poller_startup_complete',
        help: 'Whether startup synchronization finished successfully (1) or not (0).',
        type: 'gauge',
        value: this.startupComplete ? 1 : 0
      },
      {
        name: 'whatsapp_poller_ready',
        help: 'Whether readiness checks pass (1) or fail (0).',
        type: 'gauge',
        value: this.isReady() ? 1 : 0
      },
      {
        name: 'whatsapp_poller_active_polls',
        help: 'Current number of active polls (OPEN or TIE_PENDING).',
        type: 'gauge',
        value: runtime.activePolls
      },
      {
        name: 'whatsapp_poller_outbox_retryable_messages',
        help: 'Current number of retryable outbox messages.',
        type: 'gauge',
        value: runtime.outboxRetryableMessages
      },
      {
        name: 'process_start_time_seconds',
        help: 'Unix time of process start.',
        type: 'gauge',
        value: this.startedAtMs / 1000
      },
      {
        name: 'process_uptime_seconds',
        help: 'Process uptime in seconds.',
        type: 'gauge',
        value: Math.max(0, nowMs - this.startedAtMs) / 1000
      }
    ];

    const lines = [];
    for (const metric of metrics) {
      lines.push(`# HELP ${metric.name} ${metric.help}`);
      lines.push(`# TYPE ${metric.name} ${metric.type}`);
      lines.push(this.metricLine(metric.name, metric.value));
    }

    return `${lines.join('\n')}\n`;
  }
}

module.exports = {
  BotObservability
};

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { createHub } = require('../../src/hub/server');
const { createSidePulseSink } = require('../../src/electron/sidepulseSink');
const { agentSessionKey } = require('../../src/shared/agentActivity');

const BASE_MS = Date.parse('2026-08-31T12:00:00.000Z');
const ACTIVE_OBSERVED = new Date(BASE_MS - 59_000).toISOString();
const COMPLETED_OBSERVED = new Date(BASE_MS).toISOString();

function tempDataFile() {
  return path.join(os.tmpdir(), `tm-agent-lifecycle-e2e-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
}

function fakeNet() {
  const messages = [];
  return {
    messages,
    createConnection() {
      const socket = new EventEmitter();
      socket.destroy = () => {};
      socket.end = (payload) => {
        messages.push(JSON.parse(String(payload).trim()));
        process.nextTick(() => socket.emit('close'));
      };
      process.nextTick(() => socket.emit('connect'));
      return socket;
    }
  };
}

async function flushTransport(transport, expectedCount) {
  for (let attempt = 0; attempt < 20 && transport.messages.length < expectedCount; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(transport.messages.length, expectedCount);
}

function period(totalTokens, costUsd, client) {
  return {
    totalTokens,
    costUsd,
    clients: { [client]: totalTokens },
    clientCosts: { [client]: costUsd },
    models: { synthetic: totalTokens },
    modelCosts: { synthetic: costUsd }
  };
}

function limits(provider, at) {
  return {
    updatedAt: at,
    refreshMs: 300_000,
    providers: [{
      provider,
      accountKey: `sha256:${provider}-account`,
      status: 'ok',
      source: 'synthetic',
      updatedAt: at,
      windows: [{ kind: 'billing', label: 'Synthetic', usedPercent: 25 }]
    }]
  };
}

function agentState({ harness, profile = 'default', rawSession, event, observedAt = ACTIVE_OBSERVED, toolName }) {
  return {
    schemaVersion: 1,
    harness,
    profile,
    sessionId: agentSessionKey(harness, profile, rawSession),
    event,
    observedAt,
    fidelity: 'exact',
    ...(toolName ? { toolName } : {})
  };
}

function deviceRecord({ deviceId, hostname, platform, harness, event, rawSession, totalTokens, costUsd, observedAt, toolName }) {
  const client = harness === 'hermes' ? 'hermes' : harness;
  return {
    deviceId,
    hostname,
    platform,
    agentVersion: 'test',
    updatedAt: new Date(BASE_MS).toISOString(),
    today: period(totalTokens, costUsd, client),
    month: period(totalTokens * 10, costUsd * 10, client),
    allTime: period(totalTokens * 100, costUsd * 100, client),
    limits: limits(client, new Date(BASE_MS).toISOString()),
    agentStates: [agentState({ harness, rawSession, event, observedAt, toolName })]
  };
}

function totals(stats) {
  return {
    today: stats.periods.today.totalTokens,
    month: stats.periods.month.totalTokens,
    allTime: stats.periods.allTime.totalTokens,
    limits: stats.limits.providers.map((provider) => ({
      provider: provider.provider,
      status: provider.status,
      windows: provider.windows
    }))
  };
}

function origins(messages) {
  return messages.map((message) => `${message.provider}:${message.line.agent_origin}:${message.line.hook_event_name}`);
}

test('hub lifecycle stats drive SidePulse transitions without conflating devices or usage', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(BASE_MS) });

  const dataFile = tempDataFile();
  const hub = createHub({
    port: 0,
    host: '127.0.0.1',
    secret: 'test-secret',
    staleAfterMs: 600_000,
    dataFile,
    logger: { error() {}, warn() {} }
  });
  const transport = fakeNet();
  const sink = createSidePulseSink({ enabled: true, net: transport, now: () => Date.now() });

  try {
    hub.ingest(deviceRecord({
      deviceId: 'jarl-boat',
      hostname: 'jarl-boat.local',
      platform: 'darwin',
      harness: 'opencode',
      event: 'turn_started',
      rawSession: 'opencode-session',
      totalTokens: 10,
      costUsd: 0.01
    }));
    hub.ingest(deviceRecord({
      deviceId: 'eletive-dev',
      hostname: 'eletive-dev.local',
      platform: 'linux',
      harness: 'hermes',
      event: 'tool_started',
      rawSession: 'hermes-session',
      totalTokens: 20,
      costUsd: 0.02,
      toolName: 'edit'
    }));
    hub.ingest(deviceRecord({
      deviceId: 'hermes-agent',
      hostname: 'hermes-agent.local',
      platform: 'linux',
      harness: 'reachy',
      event: 'approval_requested',
      rawSession: 'reachy-session',
      totalTokens: 30,
      costUsd: 0.03
    }));
    hub.ingest(deviceRecord({
      deviceId: 'hulk-air',
      hostname: 'hulk-air.local',
      platform: 'darwin',
      harness: 'claude',
      event: 'turn_completed',
      rawSession: 'claude-session',
      totalTokens: 40,
      costUsd: 0.04,
      observedAt: COMPLETED_OBSERVED
    }));

    const initialStats = hub.getStats();
    assert.equal(initialStats.agentActivity.mode, 'waiting_for_input');
    assert.deepEqual(
      initialStats.agentActivity.states.map((state) => `${state.deviceId}:${state.harness}:${state.mode}`).sort(),
      [
        'eletive-dev:hermes:tool_running',
        'hermes-agent:reachy:waiting_for_input',
        'hulk-air:claude:completed',
        'jarl-boat:opencode:working'
      ]
    );
    assert.equal(new Set(initialStats.agentActivity.states.map((state) => `${state.deviceId}:${state.sessionId}`)).size, 4);
    for (const device of initialStats.devices) {
      assert.equal(Object.hasOwn(device.agentStates[0], 'deviceId'), false);
      assert.match(device.agentStates[0].sessionId, /^sha256:[a-f0-9]{64}$/);
      assert.ok(!JSON.stringify(device.agentStates).includes('opencode-session'));
      assert.ok(!JSON.stringify(device.agentStates).includes('hermes-session'));
      assert.ok(!JSON.stringify(device.agentStates).includes('reachy-session'));
      assert.ok(!JSON.stringify(device.agentStates).includes('claude-session'));
    }

    const initialTotals = totals(initialStats);
    sink.ingestStats(initialStats);
    await flushTransport(transport, 4);
    assert.deepEqual(origins(transport.messages), [
      'reachy:reachy:hermes-agent:default:PermissionRequest',
      'hermes:hermes:eletive-dev:default:PreToolUse',
      'opencode:opencode:jarl-boat:default:UserPromptSubmit',
      'claude:claude:hulk-air:default:Stop'
    ]);
    assert.equal(new Set(transport.messages.map((message) => message.line.session_id)).size, 4);
    assert.ok(transport.messages.every((message) => message.line.session_id.startsWith('tm:')));
    assert.ok(!JSON.stringify(transport.messages).includes('opencode-session'));
    assert.ok(!JSON.stringify(transport.messages).includes('hermes-session'));
    assert.ok(!JSON.stringify(transport.messages).includes('reachy-session'));
    assert.ok(!JSON.stringify(transport.messages).includes('claude-session'));

    sink.ingestStats({});
    sink.ingestStats({ agentActivity: { states: 'bad' } });
    await flushTransport(transport, 4);

    hub.ingest({ deviceId: 'hermes-agent', agentStates: [], updatedAt: new Date().toISOString() });
    const withoutWaiting = hub.getStats();
    assert.equal(withoutWaiting.agentActivity.mode, 'tool_running');
    assert.deepEqual(totals(withoutWaiting), initialTotals);
    sink.ingestStats(withoutWaiting);
    await flushTransport(transport, 5);
    assert.equal(transport.messages[4].provider, 'reachy');
    assert.equal(transport.messages[4].line.agent_origin, 'reachy:hermes-agent:default');
    assert.equal(transport.messages[4].line.hook_event_name, 'SessionEnd');

    t.mock.timers.setTime(BASE_MS + 2_000);
    const activeExpired = hub.getStats();
    assert.equal(activeExpired.agentActivity.mode, 'completed');
    assert.deepEqual(
      activeExpired.agentActivity.states.map((state) => `${state.deviceId}:${state.harness}:${state.mode}`),
      ['hulk-air:claude:completed']
    );
    assert.deepEqual(totals(activeExpired), initialTotals);
    sink.ingestStats(activeExpired);
    await flushTransport(transport, 7);
    assert.deepEqual(origins(transport.messages.slice(5)).sort(), [
      'hermes:hermes:eletive-dev:default:SessionEnd',
      'opencode:opencode:jarl-boat:default:SessionEnd'
    ]);

    t.mock.timers.setTime(BASE_MS + 16_000);
    const allExpired = hub.getStats();
    assert.equal(allExpired.agentActivity.mode, 'idle_ready');
    assert.deepEqual(allExpired.agentActivity.states, []);
    assert.deepEqual(totals(allExpired), initialTotals);
    sink.ingestStats(allExpired);
    await flushTransport(transport, 8);
    assert.equal(transport.messages[7].provider, 'claude');
    assert.equal(transport.messages[7].line.agent_origin, 'claude:hulk-air:default');
    assert.equal(transport.messages[7].line.hook_event_name, 'SessionEnd');
  } finally {
    sink.stop();
    fs.rmSync(dataFile, { force: true });
  }
});

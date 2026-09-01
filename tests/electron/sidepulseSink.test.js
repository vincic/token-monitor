'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { createSidePulseSink, lineForState, normalizeSidePulseSocketPath } = require('../../src/electron/sidepulseSink');

const NOW = Date.parse('2026-08-31T12:00:00.000Z');
const OBSERVED = '2026-08-31T11:59:59.000Z';

function state(overrides = {}) {
  return {
    deviceId: 'macbook-pro',
    harness: 'claude',
    profile: 'default',
    sessionId: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    event: 'turn_started',
    mode: 'working',
    fidelity: 'exact',
    observedAt: OBSERVED,
    ...overrides
  };
}

function stats(states) {
  return { agentActivity: { updatedAt: OBSERVED, mode: 'working', states } };
}

function sleep(ms = 15) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fakeNet(options = {}) {
  const messages = [];
  let calls = 0;
  return {
    messages,
    createConnection() {
      calls += 1;
      const socket = new EventEmitter();
      socket.removeAllListeners = socket.removeAllListeners.bind(socket);
      socket.destroy = () => {
        if (options.closeOnDestroy) setImmediate(() => socket.emit('close'));
      };
      socket.end = (payload) => {
        messages.push(JSON.parse(String(payload).trim()));
        setImmediate(() => socket.emit('close'));
      };
      if (options.timeoutFirst && calls === 1) return socket;
      if (options.errorFirst && calls === 1) setImmediate(() => socket.emit('error', new Error('offline')));
      else setImmediate(() => socket.emit('connect'));
      return socket;
    }
  };
}

test('does not write when disabled', async () => {
  const transport = fakeNet();
  const sink = createSidePulseSink({ enabled: false, net: transport, now: () => NOW });
  sink.ingestStats(stats([state()]));
  await sleep();
  assert.equal(transport.messages.length, 0);
});

test('maps lifecycle modes to SidePulse hook events', () => {
  const cases = [
    ['working', 'UserPromptSubmit'],
    ['tool_running', 'PreToolUse'],
    ['waiting_for_input', 'PermissionRequest'],
    ['blocked_error', 'StopFailure'],
    ['completed', 'Stop'],
    ['idle_ready', 'SessionEnd']
  ];
  for (const [mode, expected] of cases) {
    const record = lineForState(state({ mode }), { now: () => NOW });
    assert.equal(record.message.provider, 'claude');
    assert.equal(record.message.line.hook_event_name, expected);
    assert.equal(record.message.line.sidepulse_status, expected);
    assert.equal(record.message.line.logged_at, OBSERVED);
  }
  assert.equal(lineForState(state({ mode: 'working', sidepulse_status: 'CustomStatus' }), { now: () => NOW }).message.line.sidepulse_status, 'CustomStatus');
});

test('keeps device and profile identities separated', async () => {
  const transport = fakeNet();
  const sink = createSidePulseSink({ enabled: true, net: transport, now: () => NOW });
  sink.ingestStats(stats([
    state({ deviceId: 'laptop', profile: 'default' }),
    state({ deviceId: 'desktop', profile: 'default' }),
    state({ deviceId: 'laptop', profile: 'research' })
  ]));
  await sleep();
  assert.equal(transport.messages.length, 3);
  assert.equal(new Set(transport.messages.map((m) => m.line.session_id)).size, 3);
});

test('dedupes unchanged frames', async () => {
  const transport = fakeNet();
  const sink = createSidePulseSink({ enabled: true, net: transport, now: () => NOW });
  sink.ingestStats(stats([state()]));
  sink.ingestStats(stats([state()]));
  await sleep();
  assert.equal(transport.messages.length, 1);
});

test('emits one disappearance clear for previously emitted identities', async () => {
  const transport = fakeNet();
  const sink = createSidePulseSink({ enabled: true, net: transport, now: () => NOW });
  sink.ingestStats(stats([state()]));
  await sleep();
  sink.ingestStats(stats([]));
  await sleep();
  sink.ingestStats(stats([]));
  await sleep();
  assert.deepEqual(transport.messages.map((m) => m.line.hook_event_name), ['UserPromptSubmit', 'SessionEnd']);
});

test('missing or malformed agentActivity does not mass clear', async () => {
  const transport = fakeNet();
  const sink = createSidePulseSink({ enabled: true, net: transport, now: () => NOW });
  sink.ingestStats(stats([state()]));
  await sleep();
  sink.ingestStats({});
  sink.ingestStats({ agentActivity: { states: 'bad' } });
  await sleep();
  assert.equal(transport.messages.length, 1);
});

test('bounded queue coalesces and recovers after timeout', async () => {
  const transport = fakeNet({ timeoutFirst: true });
  const sink = createSidePulseSink({
    enabled: true,
    net: transport,
    now: () => NOW,
    connectTimeoutMs: 5,
    maxQueue: 1,
    logger: { warn() {} }
  });
  sink.ingestStats(stats([
    state({ deviceId: 'one' }),
    state({ deviceId: 'two' }),
    state({ deviceId: 'three' })
  ]));
  await sleep(40);
  assert.deepEqual(transport.messages.map((m) => m.line.agent_origin), ['claude:three:default']);
});

test('failed sends retry without blocking newer records', async () => {
  const transport = fakeNet({ errorFirst: true });
  const sink = createSidePulseSink({
    enabled: true,
    net: transport,
    now: () => NOW,
    retryDelayMs: 5,
    logger: { warn() {} }
  });
  sink.ingestStats(stats([state()]));
  sink.ingestStats(stats([state({ deviceId: 'next' })]));
  await sleep(40);
  assert.deepEqual(transport.messages.map((m) => m.line.agent_origin), ['claude:next:default', 'claude:macbook-pro:default']);
});


test('temporary Unix socket receives one JSON message and EOF', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-sidepulse-'));
  const socketPath = path.join(dir, 'events.sock');
  const server = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
  } catch (error) {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
    if (error?.code === 'EPERM') {
      t.skip('Unix socket bind is not permitted in this sandbox');
      return;
    }
    throw error;
  }
  const received = new Promise((resolve) => {
    server.once('connection', (socket) => {
      let data = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => { data += chunk; });
      socket.on('end', () => {
        server.close();
        resolve(JSON.parse(data.trim()));
      });
    });
  });
  const sink = createSidePulseSink({ enabled: true, socketPath, now: () => NOW });
  sink.ingestStats(stats([state({ harness: 'opencode', toolName: 'edit' })]));
  const message = await received;
  assert.equal(message.provider, 'opencode');
  assert.equal(message.line.tool_name, 'edit');
  assert.equal(message.line.hook_event_name, 'UserPromptSubmit');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('stop and reconfigure disable clear tracked sessions', async () => {
  const transport = fakeNet();
  const sink = createSidePulseSink({ enabled: true, net: transport, now: () => NOW });
  sink.ingestStats(stats([state()]));
  await sleep();
  sink.reconfigure({ enabled: false });
  await sleep();
  sink.ingestStats(stats([state({ mode: 'tool_running' })]));
  await sleep();
  assert.deepEqual(transport.messages.map((m) => m.line.hook_event_name), ['UserPromptSubmit', 'SessionEnd']);
  sink.stop();
  assert.equal(sink.status().tracked, 0);
});

test('payload omits forbidden private keys and raw identities', () => {
  const raw = state({
    deviceId: 'raw/device@example.test',
    profile: 'work/profile',
    toolName: '/tmp/secret'
  });
  const record = lineForState(raw, { now: () => NOW });
  assert.ok(!record.message.line.agent_id);
  assert.ok(!record.message.line.tool_name);
  assert.ok(!JSON.stringify(record.message).includes(raw.sessionId));
  for (const key of Object.keys(record.message.line)) {
    assert.ok(!['prompt', 'message', 'project', 'path', 'agent_id'].includes(key));
  }
});

test('invalid and future timestamps are rejected', () => {
  assert.equal(lineForState(state({ observedAt: 'bad' }), { now: () => NOW }), null);
  assert.equal(lineForState(state({ observedAt: '2026-08-31T12:00:01.000Z' }), { now: () => NOW }), null);
});

test('normalizes tilde socket paths', () => {
  assert.equal(normalizeSidePulseSocketPath('~/sidepulse.sock'), path.join(os.homedir(), 'sidepulse.sock'));
});

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');

const {
  AGENT_ACTIVITY_ACTIVE_TTL_MS,
  AGENT_ACTIVITY_CLOCK_SKEW_MS,
  AGENT_ACTIVITY_COMPLETED_TTL_MS,
  AGENT_ACTIVITY_RAW_SESSION_ID_LENGTH,
  agentActivityPriority,
  agentSessionKey,
  aggregateAgentActivity,
  expireAgentStates,
  modeForAgentEvent,
  normalizeAgentActivity,
  normalizeAgentStates,
  sha256Hex
} = require('../../src/shared/agentActivity');

const NOW = Date.parse('2026-08-31T12:00:00.000Z');

function event(extra = {}) {
  return {
    schemaVersion: 1,
    harness: 'codex',
    profile: 'work',
    sessionId: 'raw-session-id',
    event: 'tool_started',
    observedAt: '2026-08-31T11:59:45.000Z',
    fidelity: 'exact',
    ...extra
  };
}

test('portable SHA-256 matches Node crypto for session identity hashing', () => {
  const input = 'codex\0work\0raw-session-id';
  assert.equal(sha256Hex(input), crypto.createHash('sha256').update(input).digest('hex'));
  assert.equal(agentSessionKey('codex', 'work', 'raw-session-id'), `sha256:${sha256Hex(input)}`);
});

test('normalization allowlists fields and never exposes raw session identity', () => {
  const normalized = normalizeAgentActivity(event({
    deviceId: 'spoofed-device',
    toolName: 'shell'.repeat(80),
    surface: 'terminal',
    adapterVersion: '1.0.0',
    prompt: 'private prompt',
    path: '/private/path',
    result: { secret: true }
  }), { nowMs: NOW, allowRawSessionId: true });

  assert.equal(normalized.mode, 'tool_running');
  assert.equal(normalized.toolName.length, 128);
  assert.equal(normalized.sessionId, agentSessionKey('codex', 'work', 'raw-session-id'));
  assert.notEqual(normalized.sessionId, 'raw-session-id');
  assert.equal(Object.hasOwn(normalized, 'deviceId'), false);
  assert.equal(Object.hasOwn(normalized, 'prompt'), false);
  assert.equal(Object.hasOwn(normalized, 'path'), false);
  assert.equal(Object.hasOwn(normalized, 'result'), false);
});

test('raw session identity hashes the full bounded id before output capping', () => {
  const prefix = 'x'.repeat(128);
  const first = `${prefix}a`;
  const second = `${prefix}b`;

  const normalizedFirst = normalizeAgentActivity(event({ sessionId: first }), { nowMs: NOW, allowRawSessionId: true });
  const normalizedSecond = normalizeAgentActivity(event({ sessionId: second }), { nowMs: NOW, allowRawSessionId: true });

  assert.equal(normalizedFirst.sessionId, agentSessionKey('codex', 'work', first));
  assert.equal(normalizedSecond.sessionId, agentSessionKey('codex', 'work', second));
  assert.notEqual(normalizedFirst.sessionId, normalizedSecond.sessionId);
});

test('oversized raw session identity is rejected instead of truncated', () => {
  const tooLong = 's'.repeat(AGENT_ACTIVITY_RAW_SESSION_ID_LENGTH + 1);

  assert.equal(agentSessionKey('codex', 'work', tooLong), '');
  assert.equal(normalizeAgentActivity(event({ sessionId: tooLong }), { nowMs: NOW, allowRawSessionId: true }), null);
});

test('invalid schema, timestamps, event names, fidelity, and session identity are rejected', () => {
  assert.equal(normalizeAgentActivity(event({ schemaVersion: 2 }), { nowMs: NOW }), null);
  assert.equal(normalizeAgentActivity(event({ observedAt: 'not-a-date' }), { nowMs: NOW }), null);
  assert.equal(normalizeAgentActivity(event({ event: 'message_text' }), { nowMs: NOW }), null);
  assert.equal(normalizeAgentActivity(event({ fidelity: 'maybe' }), { nowMs: NOW }), null);
  assert.equal(normalizeAgentActivity(event({ sessionId: '' }), { nowMs: NOW }), null);
});

test('wire normalization derives mode and requires lowercase opaque session identity', () => {
  const opaque = agentSessionKey('codex', 'work', 'raw-session-id');
  const normalized = normalizeAgentActivity(event({
    sessionId: opaque,
    event: 'turn_started',
    fidelity: 'inferred',
    mode: 'blocked_error'
  }), { nowMs: NOW });

  assert.equal(normalized.mode, 'working');
  assert.equal(normalizeAgentActivity(event({ sessionId: 'raw-session-id' }), { nowMs: NOW }), null);
  for (const bad of [
    `sha256:${'a'.repeat(63)}`,
    `sha256:${'A'.repeat(64)}`,
    `sha256:${'g'.repeat(64)}`
  ]) {
    assert.equal(normalizeAgentActivity(event({ sessionId: bad }), { nowMs: NOW, allowRawSessionId: true }), null);
  }
});

test('events map centrally by fidelity', () => {
  assert.equal(modeForAgentEvent('approval_requested', 'exact'), 'waiting_for_input');
  assert.equal(modeForAgentEvent('error', 'exact'), 'blocked_error');
  assert.equal(modeForAgentEvent('tool_started', 'exact'), 'tool_running');
  assert.equal(modeForAgentEvent('tool_started', 'inferred'), 'working');
  assert.equal(modeForAgentEvent('error', 'inferred'), 'working');
  assert.equal(modeForAgentEvent('tool_started', 'presence_only'), 'idle_ready');
  assert.equal(modeForAgentEvent('session_ended', 'presence_only'), 'completed');
});

test('normalization accepts old structural states and explicit expiry uses independent TTLs', () => {
  const activeBoundary = normalizeAgentActivity(event({
    event: 'turn_started',
    observedAt: new Date(NOW - AGENT_ACTIVITY_ACTIVE_TTL_MS).toISOString()
  }), { nowMs: NOW, allowRawSessionId: true });
  const activeExpired = normalizeAgentActivity(event({
    event: 'turn_started',
    observedAt: new Date(NOW - AGENT_ACTIVITY_ACTIVE_TTL_MS - 1).toISOString()
  }), { nowMs: NOW, allowRawSessionId: true });
  const completedBoundary = normalizeAgentActivity(event({
    event: 'turn_completed',
    observedAt: new Date(NOW - AGENT_ACTIVITY_COMPLETED_TTL_MS).toISOString()
  }), { nowMs: NOW, allowRawSessionId: true });
  const completedExpired = normalizeAgentActivity(event({
    event: 'turn_completed',
    observedAt: new Date(NOW - AGENT_ACTIVITY_COMPLETED_TTL_MS - 1).toISOString()
  }), { nowMs: NOW, allowRawSessionId: true });

  assert.ok(activeBoundary);
  assert.ok(activeExpired);
  assert.ok(completedBoundary);
  assert.ok(completedExpired);
  assert.deepEqual(expireAgentStates([activeBoundary], { nowMs: NOW }), [activeBoundary]);
  assert.deepEqual(expireAgentStates([activeExpired], { nowMs: NOW }), []);
  assert.deepEqual(expireAgentStates([completedBoundary], { nowMs: NOW }), [completedBoundary]);
  assert.deepEqual(expireAgentStates([completedExpired], { nowMs: NOW }), []);
});

test('future timestamps are accepted through 30 seconds and rejected at 31 seconds', () => {
  const sessionId = agentSessionKey('codex', 'work', 'raw-session-id');
  assert.ok(normalizeAgentActivity(event({
    sessionId,
    observedAt: new Date(NOW + 30_000).toISOString()
  }), { nowMs: NOW }));
  assert.equal(normalizeAgentActivity(event({
    sessionId,
    observedAt: new Date(NOW + 31_000).toISOString()
  }), { nowMs: NOW }), null);
  assert.equal(AGENT_ACTIVITY_CLOCK_SKEW_MS, 30_000);
  assert.equal(normalizeAgentActivity(event({
    sessionId,
    observedAt: '2099-01-01T00:00:00.000Z'
  }), { nowMs: NOW }), null);
});

test('priority orders aggregate modes without letting presence-only become active', () => {
  assert.ok(agentActivityPriority('blocked_error') > agentActivityPriority('waiting_for_input'));
  const aggregate = aggregateAgentActivity([
    { agentStates: [event({ sessionId: 'a', event: 'turn_started', fidelity: 'presence_only' })] },
    { agentStates: [event({ sessionId: 'b', event: 'approval_requested' })] },
    { agentStates: [event({ sessionId: 'c', event: 'error' })] }
  ], { nowMs: NOW, allowRawSessionId: true });

  assert.equal(aggregate.mode, 'blocked_error');
  assert.equal(aggregate.modes.blocked_error, 1);
  assert.equal(aggregate.modes.waiting_for_input, 1);
  assert.equal(aggregate.modes.idle_ready, 1);
});

test('direct lifecycle aggregation filters expired states explicitly', () => {
  const aggregate = aggregateAgentActivity([
    event({ sessionId: 'old', observedAt: new Date(NOW - AGENT_ACTIVITY_ACTIVE_TTL_MS - 1).toISOString() }),
    event({ sessionId: 'fresh', observedAt: new Date(NOW - AGENT_ACTIVITY_ACTIVE_TTL_MS).toISOString() })
  ], { nowMs: NOW, allowRawSessionId: true });

  assert.equal(aggregate.states.length, 1);
  assert.equal(aggregate.states[0].sessionId, agentSessionKey('codex', 'work', 'fresh'));
});

test('fleet aggregation scopes identical sessions by trusted device id', () => {
  const aggregate = aggregateAgentActivity([
    { deviceId: 'device-a', agentStates: [event({ sessionId: 'same-session' })] },
    { deviceId: 'device-b', agentStates: [event({ sessionId: 'same-session' })] }
  ], { nowMs: NOW, allowRawSessionId: true });

  assert.equal(aggregate.states.length, 2);
  assert.deepEqual(
    aggregate.states.map((state) => state.deviceId).sort(),
    ['device-a', 'device-b']
  );
  assert.equal(new Set(aggregate.states.map((state) => state.sessionId)).size, 1);
});

test('state reduction keeps latest per session and caps output', () => {
  const states = normalizeAgentStates([
    event({ sessionId: 'a', event: 'turn_started', observedAt: '2026-08-31T11:59:40.000Z' }),
    event({ sessionId: 'a', event: 'turn_completed', observedAt: '2026-08-31T11:59:50.000Z' }),
    event({ sessionId: 'b', event: 'approval_requested', observedAt: '2026-08-31T11:59:45.000Z' })
  ], { nowMs: NOW, maxStatesPerDevice: 1, allowRawSessionId: true });

  assert.equal(states.length, 1);
  assert.equal(states[0].mode, 'waiting_for_input');
  assert.deepEqual(expireAgentStates(states, { nowMs: NOW + AGENT_ACTIVITY_ACTIVE_TTL_MS + 1 }), []);
});

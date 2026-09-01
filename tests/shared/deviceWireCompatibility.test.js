'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createDeviceState } = require('../../src/shared/deviceState');
const { agentSessionKey } = require('../../src/shared/agentActivity');
const { syncPayload } = require('../../src/shared/syncPayload');
const { aggregateDevices, mergeDeviceRecord, normalizeDeviceRecord } = require('../../src/shared/usage');
const workerUsage = require('../../worker/src/shared/usage');

function period(tokens) {
  return {
    totalTokens: tokens,
    costUsd: 0,
    clients: { codex: tokens },
    clientCosts: {},
    models: {},
    modelCosts: {}
  };
}

test('Node and Worker preserve explicit unavailable History', () => {
  const record = { deviceId: 'device-1', historyAvailable: false, history: null };

  assert.equal(normalizeDeviceRecord(record).history, null);
  assert.equal(workerUsage.normalizeDeviceRecord(record).history, null);
  assert.equal(normalizeDeviceRecord(record).historyAvailable, false);
  assert.equal(workerUsage.normalizeDeviceRecord(record).historyAvailable, false);
});

test('composed full records remain compatible with hub normalization and merging', () => {
  const records = [];
  const state = createDeviceState({
    envelope: {
      deviceId: 'device-1',
      hostname: 'host',
      platform: 'darwin-arm64',
      agentVersion: '1.2.3'
    },
    onRecord: (record, meta) => records.push({ record, meta })
  });
  state.updateUsage({
    updatedAt: '2026-07-21T01:00:00.000Z',
    today: period(10),
    month: period(20),
    allTime: period(30),
    historyAvailable: true,
    history: { daily: [{ date: '2026-07-21', totalTokens: 10, costUsd: 0 }] }
  });
  state.updateLimits({
    updatedAt: '2026-07-21T01:01:00.000Z',
    refreshMs: 300000,
    providers: [{
      provider: 'codex',
      status: 'unavailable',
      accountKey: 'account-1',
      windows: [{ kind: 'session', usedPercent: 40 }]
    }]
  });

  assert.equal(records.length, 2);
  assert.equal(Object.hasOwn(records[1].record, 'revision'), false);
  assert.equal(records[1].record.updatedAt, '2026-07-21T01:00:00.000Z');

  const normalized = normalizeDeviceRecord(records[1].record);
  assert.equal(normalized.periods.today.totalTokens, 10);
  assert.equal(normalized.history.daily[0].totalTokens, 10);
  assert.equal(normalized.historyAvailable, true);
  assert.equal(normalized.limits.providers[0].status, 'unavailable');
  assert.equal(normalized.limits.providers[0].windows[0].usedPercent, 40);
  assert.equal(syncPayload(records[1].record).historyAvailable, true);

  const merged = mergeDeviceRecord(records[0].record, {
    ...records[1].record,
    receivedAt: '2026-07-21T01:01:01.000Z'
  });
  assert.equal(merged.periods.today.totalTokens, 10);
  assert.equal(merged.history.daily[0].totalTokens, 10);
  assert.equal(merged.updatedAt, '2026-07-21T01:00:00.000Z');
  assert.equal(merged.receivedAt, '2026-07-21T01:01:01.000Z');
});

test('sync payload keeps retained public status/windows and drops runtime-only provider state', () => {
  const payload = syncPayload({
    deviceId: 'device-1',
    updatedAt: '2026-07-21T01:00:00.000Z',
    today: period(10),
    month: period(20),
    allTime: period(30),
    limits: {
      updatedAt: '2026-07-21T01:01:00.000Z',
      refreshMs: 300000,
      providers: [{
        provider: 'codex',
        status: 'unavailable',
        accountKey: 'account-1',
        windows: [{ kind: 'session', usedPercent: 40 }],
        lastAttempt: { status: 'unavailable' },
        error: 'private diagnostic',
        credentialDigest: 'private digest',
        revision: 99
      }]
    }
  });
  const provider = payload.limits.providers[0];
  assert.equal(provider.status, 'unavailable');
  assert.equal(provider.windows[0].usedPercent, 40);
  assert.equal(Object.hasOwn(provider, 'lastAttempt'), false);
  assert.equal(Object.hasOwn(provider, 'error'), false);
  assert.equal(Object.hasOwn(provider, 'credentialDigest'), false);
  assert.equal(Object.hasOwn(provider, 'revision'), false);
});

test('agent states normalize on Node wire and omit caller device identity', () => {
  const observedAt = new Date().toISOString();
  const sessionId = agentSessionKey('codex', 'work', 'raw-private-session');
  const normalized = normalizeDeviceRecord({
    deviceId: 'device-1',
    agentStates: [{
      schemaVersion: 1,
      harness: 'codex',
      profile: 'work',
      deviceId: 'spoofed-device',
      sessionId,
      event: 'approval_requested',
      observedAt,
      fidelity: 'exact',
      messages: ['private'],
      toolArgs: { path: '/private' }
    }]
  });

  assert.equal(normalized.agentStates.length, 1);
  assert.equal(normalized.agentStates[0].mode, 'waiting_for_input');
  assert.equal(normalized.agentStates[0].sessionId, sessionId);
  assert.equal(Object.hasOwn(normalized.agentStates[0], 'deviceId'), false);
  assert.equal(Object.hasOwn(normalized.agentStates[0], 'messages'), false);
  assert.equal(Object.hasOwn(normalized.agentStates[0], 'toolArgs'), false);
});

test('agent states reject raw and malformed session identity on Node wire', () => {
  const observedAt = new Date().toISOString();
  for (const sessionId of [
    'raw-private-session',
    `sha256:${'a'.repeat(63)}`,
    `sha256:${'A'.repeat(64)}`,
    `sha256:${'g'.repeat(64)}`
  ]) {
    const normalized = normalizeDeviceRecord({
      deviceId: 'device-1',
      agentStates: [{
        schemaVersion: 1,
        harness: 'codex',
        profile: 'work',
        sessionId,
        event: 'approval_requested',
        observedAt,
        fidelity: 'exact'
      }]
    });
    assert.deepEqual(normalized.agentStates, []);
  }
});

test('agent state merge preserves omitted state, replaces present state, and clears explicit empty arrays', () => {
  const observedAt = new Date().toISOString();
  const existing = normalizeDeviceRecord({
    deviceId: 'device-1',
    today: period(10),
    month: period(20),
    allTime: period(30),
    agentStates: [{
      schemaVersion: 1,
      harness: 'codex',
      profile: 'work',
      sessionId: agentSessionKey('codex', 'work', 's1'),
      event: 'turn_started',
      observedAt,
      fidelity: 'exact'
    }]
  });
  const omitted = mergeDeviceRecord(existing, { deviceId: 'device-1', limitsOnly: true, limits: { providers: [] } });
  assert.equal(omitted.agentStates.length, 1);
  assert.equal(omitted.periods.today.totalTokens, 10);

  const replaced = mergeDeviceRecord(existing, {
    deviceId: 'device-1',
    agentStates: [{
      schemaVersion: 1,
      harness: 'codex',
      profile: 'work',
      sessionId: agentSessionKey('codex', 'work', 's2'),
      event: 'error',
      observedAt,
      fidelity: 'exact'
    }]
  });
  assert.equal(replaced.agentStates.length, 1);
  assert.equal(replaced.agentStates[0].mode, 'blocked_error');
  assert.equal(replaced.periods.month.totalTokens, 20);
  assert.equal(replaced.periods.allTime.totalTokens, 30);
  assert.equal(replaced.limits.providers.length, 0);

  const cleared = mergeDeviceRecord(existing, { deviceId: 'device-1', agentStates: [] });
  assert.deepEqual(cleared.agentStates, []);
  assert.equal(cleared.periods.today.totalTokens, 10);
});

test('agent state merge omission cannot resurrect expired or future-invalid state', () => {
  const sessionId = agentSessionKey('codex', 'work', 's1');
  const expired = normalizeDeviceRecord({
    deviceId: 'device-expired',
    agentStates: [{
      schemaVersion: 1,
      harness: 'codex',
      profile: 'work',
      sessionId,
      event: 'turn_started',
      observedAt: new Date(Date.now() - 61_000).toISOString(),
      fidelity: 'exact'
    }]
  });
  assert.equal(expired.agentStates.length, 1);

  const expiredOmitted = mergeDeviceRecord(expired, { deviceId: 'device-expired', limitsOnly: true, limits: { providers: [] } });
  assert.deepEqual(expiredOmitted.agentStates, []);

  const futureInvalid = normalizeDeviceRecord({
    deviceId: 'device-future',
    agentStates: [{
      schemaVersion: 1,
      harness: 'codex',
      profile: 'work',
      sessionId,
      event: 'turn_started',
      observedAt: new Date(Date.now() + 31_000).toISOString(),
      fidelity: 'exact'
    }]
  });
  assert.deepEqual(futureInvalid.agentStates, []);

  const futureOmitted = mergeDeviceRecord(futureInvalid, { deviceId: 'device-future', limitsOnly: true, limits: { providers: [] } });
  assert.deepEqual(futureOmitted.agentStates, []);
});

test('lifecycle-only agent state posts preserve existing device identity and usage metadata', () => {
  const observedAt = '2026-08-31T12:00:00.000Z';
  const existing = normalizeDeviceRecord({
    deviceId: 'device-1',
    hostname: 'workstation.local',
    platform: 'linux-x64',
    agentVersion: '1.2.3',
    agentRuntime: 'electron',
    osName: 'Ubuntu',
    osVersion: '26.04',
    trackedClients: ['codex'],
    clientStatus: { codex: 'active' },
    wslStatus: { state: 'not-installed', detected: [], withData: [] },
    projectsEnabled: true,
    periodWindows: {
      today: { key: '2026-08-31', endsAt: '2026-09-01T00:00:00.000Z' },
      month: { key: '2026-08', endsAt: '2026-09-01T00:00:00.000Z' }
    },
    today: { ...period(10), capabilities: { tokenComponents: true } },
    month: { ...period(20), capabilities: { tokenComponents: true } },
    allTime: { ...period(30), capabilities: { tokenComponents: true } },
    updatedAt: '2026-08-31T11:59:00.000Z',
    receivedAt: '2026-08-31T11:59:01.000Z',
    agentStates: [{
      schemaVersion: 1,
      harness: 'codex',
      profile: 'work',
      sessionId: agentSessionKey('codex', 'work', 'old'),
      event: 'turn_started',
      observedAt,
      fidelity: 'exact'
    }]
  });

  const updated = mergeDeviceRecord(existing, {
    deviceId: 'device-1',
    updatedAt: '2026-08-31T12:00:00.000Z',
    receivedAt: '2026-08-31T12:00:01.000Z',
    agentStates: [{
      schemaVersion: 1,
      harness: 'codex',
      profile: 'work',
      sessionId: agentSessionKey('codex', 'work', 'new'),
      event: 'approval_requested',
      observedAt,
      fidelity: 'exact'
    }]
  });

  assert.equal(updated.hostname, 'workstation.local');
  assert.equal(updated.platform, 'linux-x64');
  assert.equal(updated.agentVersion, '1.2.3');
  assert.equal(updated.agentRuntime, 'electron');
  assert.equal(updated.osName, 'Ubuntu');
  assert.equal(updated.osVersion, '26.04');
  assert.deepEqual(updated.trackedClients, ['codex']);
  assert.deepEqual(updated.clientStatus, { codex: 'active' });
  assert.deepEqual(updated.wslStatus, { state: 'not-installed', detected: [], withData: [] });
  assert.equal(updated.periods.today.totalTokens, 10);
  assert.equal(updated.periods.month.totalTokens, 20);
  assert.equal(updated.periods.allTime.totalTokens, 30);
  assert.equal(updated.periods.today.capabilities.tokenComponents, true);
  assert.deepEqual(updated.periodWindows, existing.periodWindows);
  assert.equal(updated.agentStates.length, 1);
  assert.equal(updated.agentStates[0].mode, 'waiting_for_input');
  assert.equal(updated.updatedAt, '2026-08-31T12:00:00.000Z');
  assert.equal(updated.receivedAt, '2026-08-31T12:00:01.000Z');

  const cleared = mergeDeviceRecord(existing, {
    deviceId: 'device-1',
    updatedAt: '2026-08-31T12:01:00.000Z',
    receivedAt: '2026-08-31T12:01:01.000Z',
    agentStates: []
  });
  assert.deepEqual(cleared.agentStates, []);
  assert.equal(cleared.hostname, 'workstation.local');
  assert.equal(cleared.platform, 'linux-x64');
  assert.equal(cleared.agentVersion, '1.2.3');
  assert.equal(cleared.agentRuntime, 'electron');
  assert.deepEqual(cleared.trackedClients, ['codex']);

  const explicit = mergeDeviceRecord(existing, {
    deviceId: 'device-1',
    hostname: 'replacement.local',
    platform: 'darwin-arm64',
    agentVersion: '2.0.0',
    agentRuntime: '',
    agentStates: []
  });
  assert.equal(explicit.hostname, 'replacement.local');
  assert.equal(explicit.platform, 'darwin-arm64');
  assert.equal(explicit.agentVersion, '2.0.0');
  assert.equal(explicit.agentRuntime, '');
});

test('aggregate devices exposes authenticated lifecycle aggregate with TTL', () => {
  const now = Date.parse('2026-08-31T12:00:00.000Z');
  const stats = aggregateDevices([
    {
      deviceId: 'device-1',
      receivedAt: new Date(now).toISOString(),
      agentStates: [{
        schemaVersion: 1,
        harness: 'codex',
        profile: 'work',
        sessionId: agentSessionKey('codex', 'work', 's1'),
        event: 'approval_requested',
        observedAt: new Date(now - 10_000).toISOString(),
        fidelity: 'exact'
      }]
    },
    {
      deviceId: 'device-2',
      receivedAt: new Date(now).toISOString(),
      agentStates: [{
        schemaVersion: 1,
        harness: 'codex',
        profile: 'work',
        sessionId: agentSessionKey('codex', 'work', 's2'),
        event: 'error',
        observedAt: new Date(now - 61_000).toISOString(),
        fidelity: 'exact'
      }]
    }
  ], 600_000, now);

  assert.equal(stats.agentActivity.mode, 'waiting_for_input');
  assert.equal(stats.agentActivity.states.length, 1);
  assert.equal(stats.agentActivity.states[0].mode, 'waiting_for_input');
  assert.equal(stats.devices.find((device) => device.deviceId === 'device-1').agentStates.length, 1);
  assert.deepEqual(stats.devices.find((device) => device.deviceId === 'device-2').agentStates, []);
});

test('aggregate devices expires per-device lifecycle states using aggregate now', () => {
  const observedAt = Date.parse('2026-08-31T12:00:00.000Z');
  const record = {
    deviceId: 'device-1',
    receivedAt: new Date(observedAt).toISOString(),
    agentStates: [{
      schemaVersion: 1,
      harness: 'codex',
      profile: 'work',
      sessionId: agentSessionKey('codex', 'work', 's1'),
      event: 'approval_requested',
      observedAt: new Date(observedAt).toISOString(),
      fidelity: 'exact'
    }]
  };

  const stats = aggregateDevices([record], 600_000, observedAt + 61_000);

  assert.equal(stats.agentActivity.mode, 'idle_ready');
  assert.deepEqual(stats.agentActivity.states, []);
  assert.deepEqual(stats.devices[0].agentStates, []);
  assert.equal(record.agentStates.length, 1);
});

test('aggregate devices scopes lifecycle states by trusted device id', () => {
  const now = Date.parse('2026-08-31T12:00:00.000Z');
  const stats = aggregateDevices([
    {
      deviceId: 'device-a',
      receivedAt: new Date(now).toISOString(),
      agentStates: [{
        schemaVersion: 1,
        harness: 'codex',
        profile: 'work',
        deviceId: 'spoofed-a',
        sessionId: agentSessionKey('codex', 'work', 'same-session'),
        event: 'tool_started',
        observedAt: new Date(now - 10_000).toISOString(),
        fidelity: 'exact'
      }]
    },
    {
      deviceId: 'device-b',
      receivedAt: new Date(now).toISOString(),
      agentStates: [{
        schemaVersion: 1,
        harness: 'codex',
        profile: 'work',
        deviceId: 'spoofed-b',
        sessionId: agentSessionKey('codex', 'work', 'same-session'),
        event: 'tool_started',
        observedAt: new Date(now - 10_000).toISOString(),
        fidelity: 'exact'
      }]
    }
  ], 600_000, now);

  assert.equal(stats.agentActivity.states.length, 2);
  assert.deepEqual(
    stats.agentActivity.states.map((state) => state.deviceId).sort(),
    ['device-a', 'device-b']
  );
  assert.equal(Object.hasOwn(stats.devices[0].agentStates[0], 'deviceId'), false);
  assert.equal(Object.hasOwn(stats.devices[1].agentStates[0], 'deviceId'), false);
});

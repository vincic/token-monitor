'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const { agentSessionKey } = require('../../src/shared/agentActivity');

test('public stats periods strip every project identity field', async () => {
  const worker = await import(pathToFileURL(path.resolve(__dirname, '../../worker/src/index.js')).href);
  const periods = worker.publicPeriods({ today: {
    projects: {
      'private-client': { label: 'Private-Client', tokens: 1, clients: { codex: 1 } }
    },
    sessions: { 'codex:s1': {
      client: 'codex', sessionId: 's1', totalTokens: 1,
      projectId: 'sha256:secret', projectLabel: 'Private-Client', projectPath: '/Users/alice/Private-Client'
    } }
  } });
  assert.deepEqual(periods.today.sessions['codex:s1'], { client: 'codex', sessionId: 's1', totalTokens: 1 });
  assert.equal(Object.hasOwn(periods.today, 'projects'), false);
  const json = JSON.stringify(periods);
  assert.doesNotMatch(json, /Private-Client/);
  assert.doesNotMatch(json, /private-client/);
});

test('Worker public stats strip every account identity and plan field', async () => {
  const worker = await import(pathToFileURL(path.resolve(__dirname, '../../worker/src/index.js')).href);
  const now = new Date().toISOString();
  const device = {
    deviceId: 'macbook',
    updatedAt: now,
    receivedAt: now,
    limits: {
      updatedAt: now,
      providers: [{
        provider: 'opencode',
        accountKey: 'sha256:private',
        webAccountKey: 'sha256:private-web',
        accountKeyAliases: ['sha256:private-legacy'],
        accountEmail: 'work@example.com',
        accountName: 'work',
        accountLabel: 'work',
        planLabel: 'Go',
        workspaceKind: 'personal',
        status: 'ok',
        source: 'web',
        updatedAt: now,
        windows: [],
        usageSummary: {
          period: 'month',
          requests: 12,
          inputTokens: 345,
          standardCost: 8,
          actualCost: 3
        }
      }]
    }
  };
  const hub = new worker.HubDO({
    storage: {
      // The one unauthenticated route must not reach for the document holding
      // what the user pays, not even to read a version off it and drop it again.
      async get(key) { throw new Error(`public stats must not read storage key: ${key}`); },
      async list(options) {
        assert.deepEqual(options, { prefix: 'dev:' });
        return new Map([['dev:macbook', device]]);
      }
    }
  }, { PUBLIC_STATS_ENABLED: '1' });

  const response = await hub.fetch(new Request('https://example.com/api/public/stats'));
  assert.equal(response.status, 200);
  const payload = await response.json();
  const provider = payload.limits.providers[0];
  assert.equal(provider.provider, 'opencode');
  for (const field of ['accountKey', 'webAccountKey', 'accountKeyAliases', 'accountEmail', 'accountName', 'accountLabel', 'planLabel', 'workspaceKind']) {
    assert.equal(Object.hasOwn(provider, field), false, `${field} should stay private`);
  }
  assert.equal(Object.hasOwn(provider, 'usageSummary'), false, 'detailed usage should stay private');
  assert.equal(Object.hasOwn(payload, 'devices'), false);
  assert.equal(Object.hasOwn(payload, 'deviceHistoryRevision'), false);
});

// clientHealth says which of a machine's directories exist and whether a
// background sync is failing. It rides on the device record, which the public
// route drops wholesale — so the only way it could surface is a cross-device
// rollup at the top level, where `...rest` would carry it straight through.
test('Worker public stats carry no client health', async () => {
  const worker = await import(pathToFileURL(path.resolve(__dirname, '../../worker/src/index.js')).href);
  const now = new Date().toISOString();
  const device = {
    deviceId: 'macbook',
    updatedAt: now,
    receivedAt: now,
    clientHealth: {
      clients: {
        antigravity: {
          source: { state: 'detected', detectedCount: 1, checkedCount: 3, checks: [{ id: 'antigravity-cli-data', exists: false }] },
          collection: { state: 'failed', lastAttemptAt: now },
          data: { liveTokens: 0 },
          diagnostics: ['sync-timeout']
        }
      }
    }
  };
  // Guards only the public request: the authenticated read below legitimately
  // reaches for the subscription document to stamp its version.
  let publicRequestInFlight = true;
  const hub = new worker.HubDO({
    storage: {
      async get(key) {
        if (publicRequestInFlight) throw new Error(`public stats must not read storage key: ${key}`);
        return undefined;
      },
      async list() { return new Map([['dev:macbook', device]]); }
    }
  }, { PUBLIC_STATS_ENABLED: '1' });

  const payload = await (await hub.fetch(new Request('https://example.com/api/public/stats'))).json();
  publicRequestInFlight = false;
  assert.equal(Object.hasOwn(payload, 'clientHealth'), false);
  const json = JSON.stringify(payload);
  assert.doesNotMatch(json, /antigravity-cli-data/);
  assert.doesNotMatch(json, /sync-timeout/);

  // The authenticated route is where it belongs, and still per device only.
  const stats = await hub.statsWithSubscriptionVersion();
  assert.equal(stats.devices[0].clientHealth.clients.antigravity.overall, 'attention');
  assert.equal(Object.hasOwn(stats, 'clientHealth'), false);
});

test('Worker public stats strip agent lifecycle state and identities', async () => {
  const worker = await import(pathToFileURL(path.resolve(__dirname, '../../worker/src/index.js')).href);
  const now = new Date().toISOString();
  const device = {
    deviceId: 'macbook',
    updatedAt: now,
    receivedAt: now,
    agentStates: [{
      schemaVersion: 1,
      harness: 'codex',
      profile: 'work',
      sessionId: agentSessionKey('codex', 'work', 'raw-session'),
      event: 'approval_requested',
      observedAt: now,
      fidelity: 'exact'
    }]
  };
  const hub = new worker.HubDO({
    storage: {
      async get(key) { throw new Error(`public stats must not read storage key: ${key}`); },
      async list() { return new Map([['dev:macbook', device]]); }
    }
  }, { PUBLIC_STATS_ENABLED: '1' });

  const payload = await (await hub.fetch(new Request('https://example.com/api/public/stats'))).json();
  assert.equal(Object.hasOwn(payload, 'devices'), false);
  assert.equal(Object.hasOwn(payload, 'agentActivity'), false);
  const json = JSON.stringify(payload);
  assert.doesNotMatch(json, /raw-session|approval_requested|sha256:/);
});

test('Worker authenticated stats expose lifecycle aggregate and device states', async () => {
  const worker = await import(pathToFileURL(path.resolve(__dirname, '../../worker/src/index.js')).href);
  const now = new Date().toISOString();
  const device = {
    deviceId: 'macbook',
    updatedAt: now,
    receivedAt: now,
    agentStates: [{
      schemaVersion: 1,
      harness: 'codex',
      profile: 'work',
      sessionId: agentSessionKey('codex', 'work', 'raw-session'),
      event: 'tool_started',
      observedAt: now,
      fidelity: 'exact'
    }]
  };
  const hub = new worker.HubDO({
    storage: {
      async get() { return undefined; },
      async list() { return new Map([['dev:macbook', device]]); }
    }
  }, { TOKEN_MONITOR_SECRET: 'shh' });

  const payload = await (await hub.fetch(new Request('https://example.com/api/stats', {
    headers: { authorization: 'Bearer shh' }
  }))).json();
  assert.equal(payload.agentActivity.mode, 'tool_running');
  assert.equal(payload.agentActivity.states[0].deviceId, 'macbook');
  assert.equal(payload.devices[0].agentStates[0].mode, 'tool_running');
  assert.match(payload.devices[0].agentStates[0].sessionId, /^sha256:/);
  assert.notEqual(payload.devices[0].agentStates[0].sessionId, 'raw-session');
});

test('Worker ingest rejects raw and malformed lifecycle session identities', async () => {
  const worker = await import(pathToFileURL(path.resolve(__dirname, '../../worker/src/index.js')).href);
  const hub = new worker.HubDO({
    storage: {
      async get() { return undefined; },
      async list() { return new Map(); },
      async put() { throw new Error('invalid lifecycle state must not be stored'); }
    }
  }, { TOKEN_MONITOR_SECRET: 'shh' });
  const post = (sessionId) => hub.fetch(new Request('https://example.com/api/ingest', {
    method: 'POST',
    headers: { authorization: 'Bearer shh', 'content-type': 'application/json' },
    body: JSON.stringify({
      deviceId: 'macbook',
      agentStates: [{
        schemaVersion: 1,
        harness: 'codex',
        profile: 'work',
        sessionId,
        event: 'turn_started',
        observedAt: new Date().toISOString(),
        fidelity: 'exact'
      }]
    })
  }));

  for (const sessionId of [
    'raw-session',
    `sha256:${'a'.repeat(63)}`,
    `sha256:${'A'.repeat(64)}`,
    `sha256:${'g'.repeat(64)}`
  ]) {
    const response = await post(sessionId);
    assert.equal(response.status, 400);
    assert.match((await response.json()).message, /agentStates\.sessionId/);
  }
});

test('Worker ingest rejects future-invalid lifecycle states and drops expired states', async () => {
  const worker = await import(pathToFileURL(path.resolve(__dirname, '../../worker/src/index.js')).href);
  const storage = new Map();
  const hub = new worker.HubDO({
    storage: {
      async get(key) { return storage.get(key); },
      async list() { return new Map(Array.from(storage.entries()).filter(([key]) => key.startsWith('dev:'))); },
      async put(key, value) { storage.set(key, value); }
    }
  }, { TOKEN_MONITOR_SECRET: 'shh' });
  const post = (observedAt, deviceId = 'macbook') => hub.fetch(new Request('https://example.com/api/ingest', {
    method: 'POST',
    headers: { authorization: 'Bearer shh', 'content-type': 'application/json' },
    body: JSON.stringify({
      deviceId,
      agentStates: [{
        schemaVersion: 1,
        harness: 'codex',
        profile: 'work',
        sessionId: agentSessionKey('codex', 'work', 's1'),
        event: 'turn_started',
        observedAt,
        fidelity: 'exact'
      }]
    })
  }));

  let response = await post('2099-01-01T00:00:00.000Z', 'future');
  assert.equal(response.status, 400);
  assert.match((await response.json()).message, /agentStates\.observedAt/);
  assert.equal(storage.has('dev:future'), false);

  response = await post(new Date(Date.now() + 30_000).toISOString(), 'boundary');
  assert.equal(response.status, 200);
  assert.equal(storage.get('dev:boundary').agentStates.length, 1);

  response = await post(new Date(Date.now() + 31_000).toISOString(), 'beyond-boundary');
  assert.equal(response.status, 400);
  assert.equal(storage.has('dev:beyond-boundary'), false);

  response = await post(new Date(Date.now() - 61_000).toISOString(), 'expired');
  assert.equal(response.status, 200);
  assert.deepEqual(storage.get('dev:expired').agentStates, []);
});

test('Worker ingest preserves omitted lifecycle state and clears explicit empty arrays', async () => {
  const worker = await import(pathToFileURL(path.resolve(__dirname, '../../worker/src/index.js')).href);
  const storage = new Map();
  const hub = new worker.HubDO({
    storage: {
      async delete(key) { storage.delete(key); },
      async get(key) { return storage.get(key); },
      async list() { return new Map(Array.from(storage.entries()).filter(([key]) => key.startsWith('dev:'))); },
      async put(key, value) { storage.set(key, value); }
    }
  }, { TOKEN_MONITOR_SECRET: 'shh' });
  const post = (body) => hub.fetch(new Request('https://example.com/api/ingest', {
    method: 'POST',
    headers: { authorization: 'Bearer shh', 'content-type': 'application/json' },
    body: JSON.stringify(body)
  }));
  const now = new Date().toISOString();

  await post({
    deviceId: 'macbook',
    today: { totalTokens: 1 },
    month: { totalTokens: 2 },
    allTime: { totalTokens: 3 },
    agentStates: [{
      schemaVersion: 1,
      harness: 'codex',
      profile: 'work',
      sessionId: agentSessionKey('codex', 'work', 's1'),
      event: 'turn_started',
      observedAt: now,
      fidelity: 'exact'
    }]
  });
  await post({ deviceId: 'macbook', limitsOnly: true, limits: { providers: [] } });
  assert.equal((await hub.statsWithSubscriptionVersion()).devices[0].agentStates.length, 1);

  await post({ deviceId: 'macbook', agentStates: [] });
  const stats = await hub.statsWithSubscriptionVersion();
  assert.deepEqual(stats.devices[0].agentStates, []);
  assert.equal(stats.devices[0].periods.allTime.totalTokens, 3);
});

test('Worker authenticated stats expose the effective staleness threshold', async () => {
  const worker = await import(pathToFileURL(path.resolve(__dirname, '../../worker/src/index.js')).href);
  const hub = new worker.HubDO({
    storage: { async get() { return undefined; }, async list() { return new Map(); } }
  }, { STALE_AFTER_MS: '7654321' });

  const stats = await hub.statsWithSubscriptionVersion();

  assert.equal(stats.staleAfterMs, 7654321);
  // A hub nobody has written to reports an empty version rather than omitting
  // the field, so a device holding nothing compares equal and asks for nothing.
  assert.equal(stats.subscriptionsUpdatedAt, '');
  // And the version is not on the shape the public route is built from.
  assert.equal('subscriptionsUpdatedAt' in await hub.getStats(), false);
});

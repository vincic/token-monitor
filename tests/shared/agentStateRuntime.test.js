'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { agentSessionKey } = require('../../src/shared/agentActivity');
const { MAX_AGENT_STATE_TIMER_DELAY_MS, createAgentStateRuntime } = require('../../src/shared/agentStateRuntime');
const { createAgentStateStore } = require('../../src/shared/agentStateStore');

const NOW = Date.parse('2026-08-31T12:00:00.000Z');

function state(extra = {}) {
  return {
    schemaVersion: 1,
    harness: 'codex',
    profile: 'work',
    sessionId: agentSessionKey('codex', 'work', 'session-a'),
    event: 'turn_started',
    observedAt: '2026-08-31T11:59:45.000Z',
    fidelity: 'exact',
    ...extra
  };
}

function timers() {
  let nextId = 1;
  const scheduled = new Map();
  return {
    clearTimeout(handle) { scheduled.delete(handle); },
    fire(handle) {
      const fn = scheduled.get(handle);
      scheduled.delete(handle);
      fn?.();
    },
    scheduled,
    setTimeout(fn, delay) {
      const handle = { id: nextId++, delay };
      scheduled.set(handle, fn);
      return handle;
    }
  };
}

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tm-agent-state-runtime-'));
}

test('runtime emits initial read and diagnostics without invoking usage collection', () => {
  const updates = [];
  const store = { root: '/tmp/agent-state', read: () => [state()] };
  const runtime = createAgentStateRuntime({
    onUpdate: (states, reason) => updates.push({ states, reason })
  }, {
    store,
    now: () => NOW,
    watch: () => ({ close() {} })
  });

  assert.equal(updates.length, 1);
  assert.equal(updates[0].reason, 'initial');
  assert.equal(updates[0].states[0].mode, 'working');
  assert.deepEqual(runtime.getDiagnostics(), {
    enabled: true,
    root: '/tmp/agent-state',
    states: 1,
    lastReadAt: '2026-08-31T12:00:00.000Z',
    lastError: ''
  });
  runtime.stop();
});

test('watch events are debounced before reading the store', () => {
  const clock = { now: NOW };
  const timer = timers();
  let handlers;
  let reads = 0;
  const updates = [];
  const runtime = createAgentStateRuntime({
    debounceMs: 50,
    onUpdate: (states, reason) => updates.push({ states, reason })
  }, {
    ...timer,
    store: { root: '/tmp/agent-state', read: () => { reads += 1; return [state({ sessionId: String(reads) })]; } },
    now: () => clock.now,
    watch: (_root, nextHandlers) => { handlers = nextHandlers; return { close() {} }; }
  });

  assert.equal(reads, 1);
  handlers.onEvent('change', '/tmp/agent-state/a.json');
  handlers.onEvent('change', '/tmp/agent-state/b.json');
  assert.equal(reads, 1);
  const pending = Array.from(timer.scheduled.keys()).find((handle) => handle.delay === 50);
  timer.fire(pending);

  assert.equal(reads, 2);
  assert.equal(updates.at(-1).reason, 'watch');
  assert.equal(updates.length, 2);
  runtime.stop();
});

test('watch ready closes the initial read gap and stop suppresses late ready', () => {
  let handlers;
  let currentStates = [];
  let reads = 0;
  const updates = [];
  const runtime = createAgentStateRuntime({
    onUpdate: (states, reason) => updates.push({ states, reason })
  }, {
    store: {
      root: '/tmp/agent-state',
      prepare() { return { ok: true, root: '/tmp/agent-state', failOpen: false }; },
      read() {
        reads += 1;
        return currentStates;
      }
    },
    now: () => NOW,
    watch: (_root, nextHandlers) => {
      handlers = nextHandlers;
      return { close() {} };
    }
  });

  assert.equal(reads, 1);
  assert.deepEqual(updates, [{ states: [], reason: 'initial' }]);

  const appeared = state({ sessionId: agentSessionKey('codex', 'work', 'session-ready') });
  currentStates = [appeared];
  handlers.onReady();

  assert.equal(reads, 2);
  assert.equal(updates.length, 2);
  assert.equal(updates[1].reason, 'watch-ready');
  assert.deepEqual(updates[1].states, [{
    ...appeared,
    mode: 'working'
  }]);
  runtime.stop();

  currentStates = [state({ sessionId: agentSessionKey('codex', 'work', 'session-late') })];
  handlers.onReady();
  assert.equal(reads, 2);
  assert.equal(updates.length, 2);
});

test('runtime prepares the store root before creating the watcher', () => {
  const calls = [];
  const runtime = createAgentStateRuntime({
    onUpdate() {}
  }, {
    store: {
      root: '/tmp/agent-state',
      prepare() { calls.push('prepare'); return { ok: true, root: '/tmp/agent-state', failOpen: false }; },
      read() { calls.push('read'); return []; }
    },
    now: () => NOW,
    watch: (root) => {
      calls.push(`watch:${root}`);
      return { close() {} };
    }
  });

  assert.deepEqual(calls, ['read', 'prepare', 'watch:/tmp/agent-state']);
  runtime.stop();
});

test('runtime creates a missing real store root before watching that exact root', () => {
  const base = tempRoot();
  const root = path.join(base, 'state', 'agent-state');
  const store = createAgentStateStore({ root, nowMs: NOW });
  let watchedRoot = '';
  const runtime = createAgentStateRuntime({
    onUpdate() {}
  }, {
    store,
    now: () => NOW,
    watch: (nextRoot) => {
      watchedRoot = nextRoot;
      assert.equal(fs.statSync(root).isDirectory(), true);
      if (process.platform !== 'win32') assert.equal((fs.statSync(root).mode & 0o777), 0o700);
      return { close() {} };
    }
  });

  assert.equal(watchedRoot, root);
  assert.equal(fs.existsSync(root), true);
  assert.notEqual(watchedRoot, path.dirname(root));
  runtime.stop();
});

test('TTL timer republishes when states expire', () => {
  const clock = { now: NOW };
  const timer = timers();
  const updates = [];
  const runtime = createAgentStateRuntime({
    activeTtlMs: 20,
    onUpdate: (states, reason) => updates.push({ states, reason })
  }, {
    ...timer,
    store: { root: '/tmp/agent-state', read: ({ nowMs }) => nowMs > NOW + 20 ? [] : [state({ observedAt: new Date(NOW).toISOString() })] },
    now: () => clock.now,
    watch: () => ({ close() {} })
  });

  const ttl = Array.from(timer.scheduled.keys()).find((handle) => handle.delay === 21);
  assert.ok(ttl);
  clock.now = NOW + 21;
  timer.fire(ttl);

  assert.equal(updates.at(-1).reason, 'ttl-expired');
  assert.deepEqual(updates.at(-1).states, []);
  runtime.stop();
});

test('TTL timer delay stays bounded for future timestamps', () => {
  const timer = timers();
  const runtime = createAgentStateRuntime({
    maxTimerDelayMs: 1234,
    onUpdate() {}
  }, {
    ...timer,
    store: { root: '/tmp/agent-state', read: () => [state({ observedAt: '2099-01-01T00:00:00.000Z' })] },
    now: () => NOW,
    watch: () => ({ close() {} })
  });

  assert.ok([...timer.scheduled.keys()].every((handle) => handle.delay <= 1234));
  assert.ok(MAX_AGENT_STATE_TIMER_DELAY_MS < 120_000);
  runtime.stop();
});

test('stop closes watcher and severs pending callbacks', () => {
  const timer = timers();
  let closed = 0;
  let handlers;
  const updates = [];
  const runtime = createAgentStateRuntime({
    debounceMs: 50,
    onUpdate: (states, reason) => updates.push({ states, reason })
  }, {
    ...timer,
    store: { root: '/tmp/agent-state', read: () => [state()] },
    now: () => NOW,
    watch: (_root, nextHandlers) => {
      handlers = nextHandlers;
      return { close() { closed += 1; } };
    }
  });

  handlers.onEvent('change', '/tmp/agent-state/a.json');
  runtime.stop();
  for (const handle of Array.from(timer.scheduled.keys())) timer.fire(handle);
  assert.equal(closed, 1);
  assert.equal(updates.length, 1);
  assert.equal(runtime.refresh('late'), null);
});

test('watch and read failures surface as diagnostics without throwing', () => {
  const events = [];
  const runtime = createAgentStateRuntime({
    onDiagnosticEvent: (event) => events.push(event)
  }, {
    store: { root: '/tmp/agent-state', read: () => { throw new Error('read failed'); } },
    now: () => NOW,
    watch: () => { throw new Error('watch failed'); }
  });

  assert.deepEqual(events.map((event) => event.code), ['agent-state-read-failed', 'agent-state-watch-failed']);
  assert.equal(runtime.getDiagnostics().lastError, 'watch failed');
  runtime.stop();
});

test('store preparation failure emits a bounded diagnostic and leaves manual refresh usable', () => {
  const events = [];
  const updates = [];
  let watchCalls = 0;
  let prepareCalls = 0;
  const runtime = createAgentStateRuntime({
    onDiagnosticEvent: (event) => events.push(event),
    onUpdate: (states, reason) => updates.push({ states, reason })
  }, {
    store: {
      root: '/tmp/agent-state',
      prepare() {
        prepareCalls += 1;
        return { ok: false, error: 'unsafe_root', root: '/tmp/agent-state', failOpen: true };
      },
      read() { return []; }
    },
    now: () => NOW,
    watch: () => {
      watchCalls += 1;
      return { close() {} };
    }
  });

  assert.equal(prepareCalls, 1);
  assert.equal(watchCalls, 0);
  assert.deepEqual(events, [{
    subsystem: 'agent-activity',
    code: 'agent-state-watch-unavailable',
    detailCode: 'unsafe_root',
    message: 'unsafe_root'
  }]);
  assert.equal(runtime.getDiagnostics().lastError, 'unsafe_root');
  runtime.refresh('manual');
  assert.equal(updates.at(-1).reason, 'manual');
  assert.equal(events.length, 1);
  runtime.stop();
});

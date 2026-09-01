'use strict';

const { AGENT_ACTIVITY_ACTIVE_TTL_MS, AGENT_ACTIVITY_CLOCK_SKEW_MS, expireAgentStates } = require('./agentActivity');
const { createAgentStateStore } = require('./agentStateStore');

const DEFAULT_AGENT_STATE_DEBOUNCE_MS = 250;
const MAX_AGENT_STATE_TIMER_DELAY_MS = AGENT_ACTIVITY_ACTIVE_TTL_MS + AGENT_ACTIVITY_CLOCK_SKEW_MS + 1_000;

function timerSet(fn, delay, deps) {
  const set = deps.setTimeout || setTimeout;
  const handle = set(fn, delay);
  handle?.unref?.();
  return handle;
}

function timerClear(handle, deps) {
  if (!handle) return;
  const clear = deps.clearTimeout || clearTimeout;
  clear(handle);
}

function createDefaultWatcher(root, handlers) {
  const chokidar = require('chokidar');
  const watcher = chokidar.watch(root, {
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    ignoreInitial: true,
    persistent: true
  });
  watcher.on('all', (event, filePath) => handlers.onEvent?.(event, filePath));
  watcher.on('error', (error) => handlers.onError?.(error));
  watcher.on('ready', () => handlers.onReady?.());
  return watcher;
}

function createAgentStateRuntime(options = {}, deps = {}) {
  const store = deps.store || createAgentStateStore(options.storeOptions || options);
  const debounceMs = options.debounceMs ?? DEFAULT_AGENT_STATE_DEBOUNCE_MS;
  const onUpdate = typeof options.onUpdate === 'function' ? options.onUpdate : null;
  const onDiagnosticEvent = typeof options.onDiagnosticEvent === 'function' ? options.onDiagnosticEvent : null;
  let active = true;
  let currentStates = [];
  let debounceTimer = null;
  let expiryTimer = null;
  let watcher = null;
  let lastReadAt = '';
  let lastError = '';
  let watchUnavailableEmitted = false;

  function nowMs() {
    return typeof deps.now === 'function' ? deps.now() : Date.now();
  }

  function emit(reason) {
    if (!active) return;
    try {
      const states = store.read({ nowMs: nowMs() });
      currentStates = expireAgentStates(states, { nowMs: nowMs() });
      lastReadAt = new Date(nowMs()).toISOString();
      lastError = '';
      onUpdate?.(currentStates, reason);
    } catch (error) {
      lastError = error.message;
      onDiagnosticEvent?.({ subsystem: 'agent-activity', code: 'agent-state-read-failed', message: error.message });
    }
    scheduleExpiry();
  }

  function scheduleDebounced(reason = 'watch') {
    if (!active) return;
    timerClear(debounceTimer, deps);
    debounceTimer = timerSet(() => {
      debounceTimer = null;
      emit(reason);
    }, debounceMs, deps);
  }

  function scheduleExpiry() {
    timerClear(expiryTimer, deps);
    expiryTimer = null;
    if (!active || currentStates.length === 0) return;
    const nextDelay = currentStates.reduce((min, state) => {
      const ttl = state.mode === 'completed'
        ? (options.completedTtlMs ?? 15_000)
        : (options.activeTtlMs ?? AGENT_ACTIVITY_ACTIVE_TTL_MS);
      const remaining = Date.parse(state.observedAt) + ttl - nowMs() + 1;
      return Math.min(min, Math.max(1, remaining));
    }, AGENT_ACTIVITY_ACTIVE_TTL_MS + 1);
    expiryTimer = timerSet(() => {
      expiryTimer = null;
      emit('ttl-expired');
    }, Math.min(nextDelay, options.maxTimerDelayMs ?? MAX_AGENT_STATE_TIMER_DELAY_MS), deps);
  }

  function startWatcher() {
    const watch = deps.watch || createDefaultWatcher;
    try {
      if (typeof store.prepare === 'function') {
        const prepared = store.prepare();
        if (!prepared?.ok) {
          const message = prepared?.error || 'store_prepare_failed';
          lastError = message;
          if (!watchUnavailableEmitted) {
            watchUnavailableEmitted = true;
            onDiagnosticEvent?.({
              subsystem: 'agent-activity',
              code: 'agent-state-watch-unavailable',
              detailCode: prepared?.error || 'store_prepare_failed',
              message
            });
          }
          return;
        }
      }
      let readyRefreshDone = false;
      watcher = watch(store.root, {
        onEvent() { scheduleDebounced('watch'); },
        onError(error) {
          lastError = error.message;
          onDiagnosticEvent?.({ subsystem: 'agent-activity', code: 'agent-state-watch-failed', message: error.message });
        },
        onReady() {
          if (readyRefreshDone) return;
          readyRefreshDone = true;
          emit('watch-ready');
        }
      });
    } catch (error) {
      lastError = error.message;
      onDiagnosticEvent?.({ subsystem: 'agent-activity', code: 'agent-state-watch-failed', message: error.message });
    }
  }

  emit('initial');
  startWatcher();

  function stop() {
    if (!active) return;
    active = false;
    timerClear(debounceTimer, deps);
    timerClear(expiryTimer, deps);
    debounceTimer = null;
    expiryTimer = null;
    try { watcher?.close?.(); } catch (_) {}
    watcher = null;
  }

  return {
    getDiagnostics: () => ({
      enabled: true,
      root: store.root,
      states: currentStates.length,
      lastReadAt,
      lastError
    }),
    getSnapshot: () => currentStates.slice(),
    refresh: (reason = 'manual') => active ? emit(reason) : null,
    stop
  };
}

module.exports = {
  DEFAULT_AGENT_STATE_DEBOUNCE_MS,
  MAX_AGENT_STATE_TIMER_DELAY_MS,
  createAgentStateRuntime
};

'use strict';

const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const nodeNet = require('node:net');

const DEFAULT_SOCKET_PATH = path.join(os.homedir(), '.local', 'state', 'sidepulse', 'agent-monitor', 'events.sock');
const DEFAULT_CONNECT_TIMEOUT_MS = 200;
const DEFAULT_MAX_QUEUE = 128;
const DEFAULT_RETRY_DELAY_MS = 1000;
const LOG_RATE_LIMIT_MS = 60_000;
const MAX_SAFE_STRING = 80;
const FORBIDDEN_LINE_KEYS = new Set([
  'agent_id',
  'cwd',
  'directory',
  'file',
  'files',
  'message',
  'messages',
  'path',
  'paths',
  'project',
  'projects',
  'prompt',
  'prompts',
  'text',
  'transcript',
  'transcript_path'
]);

function defaultNow() {
  return Date.now();
}

function nowMs(now) {
  const value = typeof now === 'function' ? now() : Date.now();
  if (value instanceof Date) return value.getTime();
  const number = Number(value);
  return Number.isFinite(number) ? number : Date.now();
}

function safeString(value, maxLength = MAX_SAFE_STRING) {
  if (typeof value !== 'string') return '';
  return value.trim().normalize('NFC').replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, maxLength);
}

function safeSegment(value, fallback = 'unknown') {
  const normalized = safeString(value, 48).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function normalizeSidePulseSocketPath(value) {
  const raw = safeString(value, 4096);
  if (!raw) return DEFAULT_SOCKET_PATH;
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2));
  return raw;
}

function normalizeHarness(value) {
  const harness = safeSegment(value);
  if (harness === 'claude-code') return 'claude';
  if (harness === 'open-code') return 'opencode';
  return harness;
}

function hashSessionId(state) {
  const input = [
    safeString(state?.deviceId, 160),
    safeString(state?.harness, 160),
    safeString(state?.profile, 160),
    safeString(state?.sessionId, 220)
  ].join('\0');
  return `tm:${crypto.createHash('sha256').update(input).digest('hex')}`;
}

function identityKey(state) {
  const deviceId = safeString(state?.deviceId, 160);
  const harness = normalizeHarness(state?.harness);
  const profile = safeString(state?.profile, 160);
  const sessionId = safeString(state?.sessionId, 220);
  if (!deviceId || !harness || !profile || !sessionId) return '';
  return `${deviceId}\0${harness}\0${profile}\0${sessionId}`;
}

function timestampIso(value, now) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms) || ms <= 0 || ms > nowMs(now)) return '';
  return new Date(ms).toISOString();
}

function eventForState(state) {
  const explicitStatus = safeString(state?.sidepulse_status || state?.sidepulseStatus, 48);
  if (explicitStatus) return explicitStatus;
  const explicitMode = safeString(state?.sidepulse_mode || state?.sidepulseMode, 48);
  if (explicitMode) return explicitMode;
  switch (state?.mode) {
    case 'working': return 'UserPromptSubmit';
    case 'tool_running': return 'PreToolUse';
    case 'waiting_for_input': return 'PermissionRequest';
    case 'blocked_error': return 'StopFailure';
    case 'completed': return 'Stop';
    case 'idle_ready': return 'SessionEnd';
    default: return '';
  }
}

function safeToolName(value) {
  const toolName = safeString(value, 64);
  if (!toolName || /[\\/]|(?:^|[.])(?:\.)(?:$|[.])/.test(toolName)) return '';
  return toolName;
}

function agentOrigin(state) {
  const harness = normalizeHarness(state?.harness);
  const device = safeSegment(state?.deviceId, 'device');
  const profile = safeSegment(state?.profile, 'default');
  return `${harness}:${device}:${profile}`.slice(0, MAX_SAFE_STRING);
}

function lineForState(state, options = {}) {
  const provider = normalizeHarness(state?.harness);
  const loggedAt = timestampIso(state?.observedAt, options.now || defaultNow);
  const hookEventName = eventForState(state);
  const key = identityKey(state);
  if (!provider || !loggedAt || !hookEventName || !key) return null;
  const line = {
    logged_at: loggedAt,
    hook_event_name: hookEventName,
    session_id: hashSessionId(state),
    sidepulse_status: hookEventName,
    agent_origin: agentOrigin(state)
  };
  const toolName = safeToolName(state?.toolName);
  if (toolName) line.tool_name = toolName;
  return { key, message: { provider, line } };
}

function clearLineForState(state, options = {}) {
  const provider = normalizeHarness(state?.harness);
  const loggedAt = new Date(nowMs(options.now || defaultNow)).toISOString();
  const key = identityKey(state);
  if (!provider || !key) return null;
  return {
    key,
    message: {
      provider,
      line: {
        logged_at: loggedAt,
        hook_event_name: 'SessionEnd',
        session_id: hashSessionId(state),
        sidepulse_status: 'SessionEnd',
        agent_origin: agentOrigin(state)
      }
    }
  };
}

function signature(message) {
  return JSON.stringify(message);
}

function hasForbiddenKeys(value) {
  if (!value || typeof value !== 'object') return false;
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_LINE_KEYS.has(String(key).toLowerCase())) return true;
  }
  return false;
}

function sendSocketMessage({ net, socketPath, connectTimeoutMs }, message) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let settled = false;
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      try { socket.destroy(); } catch (_) {}
      if (error) reject(error);
      else resolve();
    }
    const timer = setTimeout(() => finish(new Error('sidepulse socket timeout')), connectTimeoutMs);
    socket.once('connect', () => {
      socket.end(`${JSON.stringify(message)}\n`);
    });
    socket.once('error', finish);
    socket.once('close', () => finish());
  });
}

function createSidePulseSink(options = {}) {
  const logger = options.logger || console;
  const transport = options.net || nodeNet;
  let enabled = options.enabled === true;
  let socketPath = normalizeSidePulseSocketPath(options.socketPath);
  let connectTimeoutMs = Math.max(1, Number(options.connectTimeoutMs) || DEFAULT_CONNECT_TIMEOUT_MS);
  let stopped = false;
  let draining = false;
  let disableDrain = false;
  let revision = 0;
  let lastErrorLogAt = 0;
  const maxQueue = Math.max(1, Number(options.maxQueue) || DEFAULT_MAX_QUEUE);
  const retryDelayMs = Math.max(1, Number(options.retryDelayMs) || DEFAULT_RETRY_DELAY_MS);
  const emitted = new Map();
  const lastByKey = new Map();
  const pending = new Map();
  const retryTimers = new Map();

  function logSendError(error) {
    const ts = nowMs(options.now || defaultNow);
    if (ts - lastErrorLogAt < LOG_RATE_LIMIT_MS) return;
    lastErrorLogAt = ts;
    try { logger.warn?.(`[sidepulse] send failed: ${error?.message || error}`); } catch (_) {}
  }

  function enqueue(record) {
    if (!enabled || stopped || !record?.key || !record?.message || hasForbiddenKeys(record.message.line)) return;
    const retryTimer = retryTimers.get(record.key);
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimers.delete(record.key);
    }
    if (!pending.has(record.key) && pending.size >= maxQueue) {
      const oldest = pending.keys().next().value;
      if (oldest) pending.delete(oldest);
    }
    pending.set(record.key, { ...record, revision: ++revision });
    void drain();
  }

  function scheduleRetry(record) {
    if (stopped || retryTimers.has(record.key)) return;
    const timer = setTimeout(() => {
      retryTimers.delete(record.key);
      if (stopped) return;
      if (emitted.get(record.key) !== signature(record.message)) return;
      enqueue(record);
    }, retryDelayMs);
    if (typeof timer.unref === 'function') timer.unref();
    retryTimers.set(record.key, timer);
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (!stopped && (enabled || disableDrain) && pending.size > 0) {
        let selected = null;
        for (const value of pending.values()) {
          if (!selected || value.revision < selected.revision) selected = value;
        }
        if (!selected) break;
        pending.delete(selected.key);
        try {
          await sendSocketMessage({ net: transport, socketPath, connectTimeoutMs }, selected.message);
        } catch (error) {
          logSendError(error);
          scheduleRetry(selected);
        }
      }
    } finally {
      draining = false;
    }
  }

  function ingestStats(stats) {
    if (!enabled || stopped) return;
    if (!Object.prototype.hasOwnProperty.call(stats || {}, 'agentActivity')) return;
    const activity = stats?.agentActivity;
    if (!activity || typeof activity !== 'object' || !Array.isArray(activity.states)) return;
    const seen = new Set();
    for (const state of activity.states) {
      const record = lineForState(state, { now: options.now || defaultNow });
      if (!record) continue;
      seen.add(record.key);
      const nextSignature = signature(record.message);
      if (emitted.get(record.key) === nextSignature) continue;
      emitted.set(record.key, nextSignature);
      lastByKey.set(record.key, state);
      enqueue(record);
    }
    for (const [key, state] of Array.from(lastByKey.entries())) {
      if (seen.has(key) || !emitted.has(key)) continue;
      const clear = clearLineForState(state, { now: options.now || defaultNow });
      if (!clear) continue;
      const clearSignature = signature(clear.message);
      if (emitted.get(key) !== clearSignature) {
        emitted.set(key, clearSignature);
        enqueue(clear);
      }
      lastByKey.delete(key);
    }
  }

  function reconfigure(next = {}) {
    const nextEnabled = next.enabled === true;
    const disabling = enabled && !nextEnabled;
    if (next.socketPath !== undefined) socketPath = normalizeSidePulseSocketPath(next.socketPath);
    if (next.connectTimeoutMs !== undefined) connectTimeoutMs = Math.max(1, Number(next.connectTimeoutMs) || DEFAULT_CONNECT_TIMEOUT_MS);
    if (disabling) {
      disableDrain = true;
      for (const timer of retryTimers.values()) clearTimeout(timer);
      retryTimers.clear();
      for (const state of lastByKey.values()) {
        const clear = clearLineForState(state, { now: options.now || defaultNow });
        if (clear) enqueue(clear);
      }
      lastByKey.clear();
      emitted.clear();
      void drain();
      enabled = false;
      void Promise.resolve().then(async () => {
        while (draining || pending.size > 0) await new Promise((resolve) => setTimeout(resolve, 1));
        disableDrain = false;
      });
      return;
    }
    enabled = nextEnabled;
    if (!enabled) pending.clear();
  }

  function status() {
    return {
      enabled,
      socketPath,
      pending: pending.size,
      active: draining,
      tracked: lastByKey.size
    };
  }

  function stop() {
    stopped = true;
    pending.clear();
    for (const timer of retryTimers.values()) clearTimeout(timer);
    retryTimers.clear();
    lastByKey.clear();
    emitted.clear();
  }

  return { ingestStats, reconfigure, status, stop };
}

module.exports = {
  DEFAULT_SOCKET_PATH,
  createSidePulseSink,
  lineForState,
  normalizeSidePulseSocketPath
};

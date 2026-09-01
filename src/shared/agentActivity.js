'use strict';

const AGENT_ACTIVITY_SCHEMA_VERSION = 1;
const AGENT_ACTIVITY_ACTIVE_TTL_MS = 60_000;
const AGENT_ACTIVITY_COMPLETED_TTL_MS = 15_000;
const AGENT_ACTIVITY_CLOCK_SKEW_MS = 30_000;
const MAX_AGENT_ACTIVITY_STRING_LENGTH = 128;
const MAX_AGENT_ACTIVITY_RAW_SESSION_ID_LENGTH = 4096;
const MAX_AGENT_ACTIVITY_STATES_PER_DEVICE = 32;
const MAX_AGENT_ACTIVITY_AGGREGATE_STATES = 128;

const AGENT_ACTIVITY_EVENTS = Object.freeze([
  'session_started',
  'session_resumed',
  'turn_started',
  'tool_started',
  'tool_finished',
  'approval_requested',
  'approval_resolved',
  'turn_completed',
  'session_ended',
  'error',
  'heartbeat'
]);
const AGENT_ACTIVITY_FIDELITIES = Object.freeze(['exact', 'inferred', 'presence_only']);
const AGENT_ACTIVITY_MODES = Object.freeze([
  'idle_ready',
  'working',
  'tool_running',
  'waiting_for_input',
  'blocked_error',
  'completed'
]);
const EVENT_SET = new Set(AGENT_ACTIVITY_EVENTS);
const FIDELITY_SET = new Set(AGENT_ACTIVITY_FIDELITIES);
const MODE_PRIORITY = Object.freeze({
  idle_ready: 0,
  completed: 1,
  working: 2,
  tool_running: 3,
  waiting_for_input: 4,
  blocked_error: 5
});
const OPAQUE_SESSION_ID_RE = /^sha256:[a-f0-9]{64}$/;
const EXACT_EVENT_MODES = Object.freeze({
  session_started: 'working',
  session_resumed: 'working',
  turn_started: 'working',
  tool_started: 'tool_running',
  tool_finished: 'working',
  approval_requested: 'waiting_for_input',
  approval_resolved: 'working',
  turn_completed: 'completed',
  session_ended: 'completed',
  error: 'blocked_error',
  heartbeat: 'working'
});
const INFERRED_ACTIVE_EVENTS = new Set([
  'session_started',
  'session_resumed',
  'turn_started',
  'tool_started',
  'tool_finished',
  'approval_requested',
  'approval_resolved',
  'error',
  'heartbeat'
]);
const COMPLETED_EVENTS = new Set(['turn_completed', 'session_ended']);

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function cappedString(value) {
  if (typeof value !== 'string') return '';
  return value.trim().normalize('NFC').slice(0, MAX_AGENT_ACTIVITY_STRING_LENGTH);
}

function normalizedRawSessionId(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim().normalize('NFC');
  if (!normalized || normalized.length > MAX_AGENT_ACTIVITY_RAW_SESSION_ID_LENGTH) return '';
  return normalized;
}

function timestampMs(value) {
  if (typeof value !== 'string' || !value.trim()) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function normalizeIsoTimestamp(value) {
  const ms = timestampMs(value);
  return ms > 0 ? new Date(ms).toISOString() : '';
}

function rotr(value, bits) {
  return (value >>> bits) | (value << (32 - bits));
}

// Small portable SHA-256 implementation so the same lifecycle core can run in
// Node and in the Cloudflare Worker shared closure without Node built-ins.
function sha256Hex(input) {
  const bytes = new TextEncoder().encode(String(input));
  const words = [];
  for (let index = 0; index < bytes.length; index += 1) {
    words[index >> 2] |= bytes[index] << (24 - (index % 4) * 8);
  }
  const bitLength = bytes.length * 8;
  words[bitLength >> 5] |= 0x80 << (24 - (bitLength % 32));
  words[(((bitLength + 64) >> 9) << 4) + 15] = bitLength;
  const h = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ];
  const k = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];
  const w = new Array(64);
  for (let block = 0; block < words.length; block += 16) {
    for (let index = 0; index < 16; index += 1) w[index] = words[block + index] | 0;
    for (let index = 16; index < 64; index += 1) {
      const s0 = rotr(w[index - 15], 7) ^ rotr(w[index - 15], 18) ^ (w[index - 15] >>> 3);
      const s1 = rotr(w[index - 2], 17) ^ rotr(w[index - 2], 19) ^ (w[index - 2] >>> 10);
      w[index] = (w[index - 16] + s0 + w[index - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + s1 + ch + k[index] + w[index]) | 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) | 0;
      hh = g; g = f; f = e; e = (d + temp1) | 0;
      d = c; c = b; b = a; a = (temp1 + temp2) | 0;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
  }
  return h.map((value) => (value >>> 0).toString(16).padStart(8, '0')).join('');
}

function agentSessionKey(harness, profile, sessionId) {
  const h = cappedString(harness);
  const p = cappedString(profile);
  const s = normalizedRawSessionId(sessionId);
  if (!h || !p || !s) return '';
  return `sha256:${sha256Hex(`${h}\0${p}\0${s}`)}`;
}

function isOpaqueAgentSessionId(value) {
  return OPAQUE_SESSION_ID_RE.test(String(value || ''));
}

function normalizeAgentSessionId(harness, profile, sessionId, options = {}) {
  const rawSessionId = normalizedRawSessionId(sessionId);
  if (!rawSessionId) return '';
  if (rawSessionId.startsWith('sha256:')) {
    return isOpaqueAgentSessionId(rawSessionId) ? rawSessionId : '';
  }
  if (options.allowRawSessionId !== true) return '';
  return agentSessionKey(harness, profile, rawSessionId);
}

function modeForAgentEvent(event, fidelity) {
  if (!EVENT_SET.has(event) || !FIDELITY_SET.has(fidelity)) return '';
  if (fidelity === 'presence_only') return COMPLETED_EVENTS.has(event) ? 'completed' : 'idle_ready';
  if (fidelity === 'inferred') return COMPLETED_EVENTS.has(event)
    ? 'completed'
    : (INFERRED_ACTIVE_EVENTS.has(event) ? 'working' : 'idle_ready');
  return EXACT_EVENT_MODES[event] || 'idle_ready';
}

function agentActivityPriority(mode) {
  return MODE_PRIORITY[mode] ?? -1;
}

function ttlForAgentMode(mode, options = {}) {
  if (mode === 'completed') return options.completedTtlMs ?? AGENT_ACTIVITY_COMPLETED_TTL_MS;
  return options.activeTtlMs ?? AGENT_ACTIVITY_ACTIVE_TTL_MS;
}

function normalizeAgentActivity(input, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  if (input.schemaVersion !== AGENT_ACTIVITY_SCHEMA_VERSION) return null;
  const harness = cappedString(input.harness);
  const profile = cappedString(input.profile);
  const event = input.event;
  const fidelity = input.fidelity;
  const observedAt = normalizeIsoTimestamp(input.observedAt);
  const sessionId = normalizeAgentSessionId(harness, profile, input.sessionId, options);
  if (!harness || !profile || !sessionId || !EVENT_SET.has(event) || !FIDELITY_SET.has(fidelity)) return null;
  if (!observedAt) return null;
  const mode = modeForAgentEvent(event, fidelity);
  if (!mode) return null;
  const observedMs = timestampMs(observedAt);
  const now = typeof options.now === 'function' ? options.now() : (options.nowMs ?? Date.now());
  if (!Number.isFinite(now) || observedMs - now > (options.clockSkewMs ?? AGENT_ACTIVITY_CLOCK_SKEW_MS)) return null;
  const state = {
    schemaVersion: AGENT_ACTIVITY_SCHEMA_VERSION,
    harness,
    profile,
    sessionId,
    event,
    mode,
    fidelity,
    observedAt
  };
  const toolName = cappedString(input.toolName);
  const surface = cappedString(input.surface);
  const adapterVersion = cappedString(input.adapterVersion);
  if (toolName) state.toolName = toolName;
  if (surface) state.surface = surface;
  if (adapterVersion) state.adapterVersion = adapterVersion;
  const trustedDeviceId = hasOwn(options, 'trustedDeviceId') ? cappedString(options.trustedDeviceId) : '';
  if (trustedDeviceId) state.deviceId = trustedDeviceId;
  return state;
}

function isAgentStateExpired(state, options = {}) {
  const now = typeof options.now === 'function' ? options.now() : (options.nowMs ?? Date.now());
  const observed = timestampMs(state?.observedAt);
  if (!observed || !Number.isFinite(now)) return true;
  return now - observed > ttlForAgentMode(state.mode, options);
}

function compareAgentStates(a, b) {
  const priority = agentActivityPriority(b.mode) - agentActivityPriority(a.mode);
  if (priority) return priority;
  const time = timestampMs(b.observedAt) - timestampMs(a.observedAt);
  if (time) return time;
  return `${a.deviceId || ''}:${a.harness}:${a.profile}:${a.sessionId}`
    .localeCompare(`${b.deviceId || ''}:${b.harness}:${b.profile}:${b.sessionId}`);
}

function normalizeAgentStates(value, options = {}) {
  if (!Array.isArray(value)) return [];
  const limit = Math.max(0, Math.min(
    options.maxStatesPerDevice ?? MAX_AGENT_ACTIVITY_STATES_PER_DEVICE,
    MAX_AGENT_ACTIVITY_AGGREGATE_STATES
  ));
  const states = [];
  for (const entry of value) {
    const normalized = normalizeAgentActivity(entry, options);
    if (normalized) states.push(normalized);
    if (states.length >= MAX_AGENT_ACTIVITY_AGGREGATE_STATES) break;
  }
  return reduceAgentStates(states, { ...options, maxStates: limit });
}

function agentStatesWireIdentityError(value) {
  if (!Object.prototype.hasOwnProperty.call(value || {}, 'agentStates')) return '';
  if (!Array.isArray(value.agentStates)) return '';
  for (const state of value.agentStates) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) continue;
    const sessionId = cappedString(state.sessionId);
    if (!isOpaqueAgentSessionId(sessionId)) return 'agentStates.sessionId must be sha256: followed by 64 lowercase hex characters';
  }
  return '';
}

function agentStatesFutureClockError(value, options = {}) {
  if (!Object.prototype.hasOwnProperty.call(value || {}, 'agentStates')) return '';
  if (!Array.isArray(value.agentStates)) return '';
  const now = typeof options.now === 'function' ? options.now() : (options.nowMs ?? Date.now());
  if (!Number.isFinite(now)) return 'agentStates observedAt cannot be validated against the hub clock';
  for (const state of value.agentStates) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) continue;
    const observed = timestampMs(state.observedAt);
    if (!observed) continue;
    if (observed - now > (options.clockSkewMs ?? AGENT_ACTIVITY_CLOCK_SKEW_MS)) {
      return 'agentStates.observedAt must not be more than 30 seconds in the future';
    }
  }
  return '';
}

function reduceAgentStates(value, options = {}) {
  const states = [];
  for (const entry of Array.isArray(value) ? value : []) {
    const state = normalizeAgentActivity(entry, options);
    if (state) states.push(state);
  }
  return reduceNormalizedAgentStates(states, options);
}

function reduceNormalizedAgentStates(value, options = {}) {
  const latestBySession = new Map();
  for (const state of Array.isArray(value) ? value : []) {
    if (!state) continue;
    const key = `${state.deviceId || ''}\0${state.harness}\0${state.profile}\0${state.sessionId}`;
    const existing = latestBySession.get(key);
    if (!existing || timestampMs(state.observedAt) >= timestampMs(existing.observedAt)) {
      latestBySession.set(key, state);
    }
  }
  const limit = Math.max(0, options.maxStates ?? options.maxStatesPerDevice ?? MAX_AGENT_ACTIVITY_STATES_PER_DEVICE);
  return Array.from(latestBySession.values()).sort(compareAgentStates).slice(0, limit);
}

function expireAgentStates(value, options = {}) {
  const states = [];
  for (const entry of Array.isArray(value) ? value : []) {
    const state = normalizeAgentActivity(entry, options);
    if (state && !isAgentStateExpired(state, options)) states.push(state);
  }
  return reduceNormalizedAgentStates(states, options);
}

function aggregateAgentActivity(devicesOrStates, options = {}) {
  const collected = [];
  for (const entry of Array.isArray(devicesOrStates) ? devicesOrStates : []) {
    const isDeviceEntry = Array.isArray(entry?.agentStates);
    const states = isDeviceEntry ? entry.agentStates : [entry];
    const trustedDeviceId = isDeviceEntry ? cappedString(entry.deviceId) : '';
    for (const state of states) {
      const normalized = normalizeAgentActivity(
        state,
        trustedDeviceId ? { ...options, trustedDeviceId } : options
      );
      if (normalized && !isAgentStateExpired(normalized, options)) collected.push(normalized);
    }
  }
  const states = reduceNormalizedAgentStates(collected, {
    ...options,
    maxStates: options.maxStates ?? MAX_AGENT_ACTIVITY_AGGREGATE_STATES
  });
  const modes = Object.fromEntries(AGENT_ACTIVITY_MODES.map((mode) => [mode, 0]));
  for (const state of states) modes[state.mode] += 1;
  return {
    updatedAt: new Date(typeof options.now === 'function' ? options.now() : (options.nowMs ?? Date.now())).toISOString(),
    mode: states[0]?.mode || 'idle_ready',
    modes,
    states
  };
}

module.exports = {
  AGENT_ACTIVITY_ACTIVE_TTL_MS,
  AGENT_ACTIVITY_AGGREGATE_STATES: MAX_AGENT_ACTIVITY_AGGREGATE_STATES,
  AGENT_ACTIVITY_CLOCK_SKEW_MS,
  AGENT_ACTIVITY_COMPLETED_TTL_MS,
  AGENT_ACTIVITY_EVENTS,
  AGENT_ACTIVITY_FIDELITIES,
  AGENT_ACTIVITY_MODES,
  AGENT_ACTIVITY_RAW_SESSION_ID_LENGTH: MAX_AGENT_ACTIVITY_RAW_SESSION_ID_LENGTH,
  AGENT_ACTIVITY_SCHEMA_VERSION,
  AGENT_ACTIVITY_STATES_PER_DEVICE: MAX_AGENT_ACTIVITY_STATES_PER_DEVICE,
  agentActivityPriority,
  agentSessionKey,
  agentStatesFutureClockError,
  aggregateAgentActivity,
  agentStatesWireIdentityError,
  expireAgentStates,
  isAgentStateExpired,
  modeForAgentEvent,
  isOpaqueAgentSessionId,
  normalizeAgentActivity,
  normalizeAgentSessionId,
  normalizeAgentStates,
  reduceAgentStates,
  sha256Hex
};

// token-monitor-agent-lifecycle:v1

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ADAPTER_VERSION = '2.0.0';
const CONFIGURED_DEFAULT_ROOT = '';
const MAX_PATH_CHARS = 4096;

function compact(value, limit = 128) {
  if (typeof value !== 'string') return '';
  return value.trim().normalize('NFC').slice(0, limit);
}

function first(...values) {
  for (const value of values) {
    const text = compact(value, 4096);
    if (text) return text;
  }
  return '';
}

function firstRaw(...values) {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const text = value.trim().normalize('NFC');
    if (text) return text;
  }
  return '';
}

function safePath(value) {
  return typeof value === 'string' && value && value.length <= MAX_PATH_CHARS && !/[\0\r\n]/.test(value);
}

function safeCall(fn, fallback) {
  try { return fn(); } catch (_) { return fallback; }
}

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function modeBits(stat) {
  return Number(stat?.mode || 0) & 0o777;
}

const DARWIN_SYSTEM_ALIASES = new Map([
  ['/etc', '/private/etc'],
  ['/tmp', '/private/tmp'],
  ['/var', '/private/var']
]);

function fsRealpath(targetPath) {
  return fs.realpathSync.native(targetPath);
}

function darwinSystemAliasTarget(candidate, target) {
  if (process.platform !== 'darwin') return '';
  const expected = DARWIN_SYSTEM_ALIASES.get(candidate);
  if (!expected || candidate === target) return '';
  const stat = safeCall(() => fs.lstatSync(candidate), null);
  if (!stat || !stat.isSymbolicLink?.() || stat.uid !== 0) return '';
  const real = safeCall(() => fsRealpath(candidate), '');
  return real === expected ? real : '';
}

function canonicalPathForDarwinSystemAliases(targetPath) {
  let resolved = path.resolve(targetPath);
  if (process.platform !== 'darwin') return resolved;
  const root = path.parse(resolved).root;
  const parts = resolved.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    const replacement = darwinSystemAliasTarget(current, resolved);
    if (!replacement) continue;
    resolved = path.join(replacement, path.relative(current, resolved));
    break;
  }
  return resolved;
}

function existingPathComponents(targetPath) {
  const resolved = path.resolve(targetPath);
  const parsed = path.parse(resolved);
  const parts = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  const paths = [parsed.root];
  let current = parsed.root;
  for (const part of parts) {
    current = path.join(current, part);
    paths.push(current);
  }
  return paths;
}

function validateExistingAncestors(dir) {
  const target = canonicalPathForDarwinSystemAliases(dir);
  for (const candidate of existingPathComponents(target)) {
    const stat = safeCall(() => fs.lstatSync(candidate), null);
    if (!stat) continue;
    if (stat.isSymbolicLink?.()) return false;
    if (candidate === target) return stat.isDirectory?.() === true;
    if (!stat.isDirectory?.()) return false;
  }
  return true;
}

function createRootUnderValidatedAncestors(dir) {
  for (const candidate of existingPathComponents(canonicalPathForDarwinSystemAliases(dir))) {
    const existing = safeCall(() => fs.lstatSync(candidate), null);
    if (existing) {
      if (existing.isSymbolicLink?.() || !existing.isDirectory?.()) return false;
      continue;
    }
    safeCall(() => fs.mkdirSync(candidate, { mode: 0o700 }), null);
    const created = safeCall(() => fs.lstatSync(candidate), null);
    if (!created || created.isSymbolicLink?.() || !created.isDirectory?.()) return false;
  }
  return true;
}

function rootIsSafe(dir) {
  const canonicalRoot = canonicalPathForDarwinSystemAliases(dir);
  if (!validateExistingAncestors(canonicalRoot)) return false;
  const stat = safeCall(() => fs.lstatSync(canonicalRoot), null);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) return false;
  if (process.platform === 'win32') return true;
  const uid = currentUid();
  if (uid !== null && uid !== undefined && stat.uid !== uid) return false;
  return (modeBits(stat) & 0o077) === 0;
}

function ensureRoot(dir) {
  const canonicalRoot = canonicalPathForDarwinSystemAliases(dir);
  if (!validateExistingAncestors(canonicalRoot)) return false;
  if (!createRootUnderValidatedAncestors(canonicalRoot)) return false;
  return rootIsSafe(canonicalRoot);
}

function tempSnapshotPath(dir, file) {
  const token = crypto.randomBytes(16).toString('hex');
  const timeNs = typeof process.hrtime?.bigint === 'function' ? process.hrtime.bigint().toString() : `${Date.now()}000000`;
  return path.join(dir, `.${file}.${process.pid}.${timeNs}.${token}.tmp`);
}

function cleanupLegacySnapshotTemps(dir, file) {
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const legacy = new RegExp(`^\\.${escaped}\\.${process.pid}(?:\\.\\d+)?\\.tmp$`);
  for (const entry of safeCall(() => fs.readdirSync(dir, { withFileTypes: true }), [])) {
    if (!entry.isFile() || !legacy.test(entry.name)) continue;
    safeCall(() => fs.rmSync(path.join(dir, entry.name), { force: true }), null);
  }
}

function root() {
  if (safePath(process.env.TOKEN_MONITOR_AGENT_STATE_ROOT)) return process.env.TOKEN_MONITOR_AGENT_STATE_ROOT;
  if (safePath(CONFIGURED_DEFAULT_ROOT)) return CONFIGURED_DEFAULT_ROOT;
  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || process.env.APPDATA || path.join(home, 'AppData', 'Local'), 'Token Monitor', 'agent-state');
  }
  return path.join(process.env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'token-monitor', 'agent-state');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function sessionId(payload = {}) {
  return firstRaw(
    payload.sessionID,
    payload.sessionId,
    payload.session_id,
    payload.session?.id,
    payload.session?.sessionID,
    payload.session?.sessionId,
    payload.session?.session_id,
    payload.conversationId,
    payload.conversation_id,
    payload.id
  );
}

function profile(payload = {}, context = {}) {
  return first(
    payload.profile,
    payload.profileName,
    payload.profile_name,
    payload.config?.profile,
    context.profile,
    context.profileName,
    context.profile_name
  ) || 'default';
}

function toolName(payload = {}) {
  const tool = payload.tool;
  return first(
    payload.toolName,
    payload.tool_name,
    typeof tool === 'string' ? tool : '',
    tool?.name,
    tool?.id,
    payload.call?.toolName,
    payload.call?.tool_name,
    payload.name
  );
}

function surface(payload = {}) {
  const explicit = compact(payload.surface || payload.client || payload.origin).toLowerCase();
  if (explicit === 'opencode' || explicit === 't3code' || explicit === 'herdr') return explicit;
  if (process.env.T3CODE || process.env.T3CODE_PROFILE || process.env.T3CODE_SESSION) return 't3code';
  if (process.env.HERDR || process.env.HERDR_PROFILE || process.env.HERDR_SESSION) return 'herdr';
  return 'opencode';
}

function failed(payload = {}) {
  const status = String(payload.status || payload.result || payload.outcome || payload.state || '').toLowerCase();
  return Boolean(payload.error || payload.failed === true || payload.success === false || ['error', 'failed', 'failure', 'denied', 'rejected'].includes(status));
}

function approval(payload = {}) {
  const status = String(payload.status || payload.result || payload.outcome || payload.decision || '').toLowerCase();
  if (payload.approved === false || ['denied', 'rejected', 'blocked'].includes(status)) return 'error';
  return 'approval_resolved';
}

function eventFor(name, payload = {}) {
  return {
    'session.created': 'session_started',
    'session.status': payload.status === 'idle' ? 'turn_completed' : 'heartbeat',
    'session.idle': 'turn_completed',
    'session.error': 'error',
    'permission.asked': 'approval_requested',
    'permission.replied': approval(payload),
    'tool.execute.before': 'tool_started',
    'tool.execute.after': failed(payload) ? 'error' : 'tool_finished'
  }[name] || '';
}

function write(name, payload = {}, context = {}) {
  try {
    const sid = sessionId(payload);
    const event = eventFor(name, payload);
    if (!sid || sid.length > 4096 || !event) return;
    const harness = 'opencode';
    const prof = profile(payload, context);
    const key = `sha256:${sha256(`${harness}\0${prof}\0${sid}`)}`;
    const file = `${sha256(`${harness}\0${prof}\0${key}`)}.json`;
    const dir = root();
    if (!ensureRoot(dir)) return;
    const state = {
      schemaVersion: 1,
      harness,
      profile: prof,
      sessionId: key,
      event,
      observedAt: first(payload.observedAt, payload.timestamp, payload.time) || new Date().toISOString(),
      fidelity: 'exact',
      adapterVersion: ADAPTER_VERSION,
      surface: surface(payload)
    };
    const tool = toolName(payload);
    if (tool) state.toolName = tool;
    const target = path.join(dir, file);
    const existing = safeCall(() => fs.lstatSync(target), null);
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) return;
    const tmp = tempSnapshotPath(dir, file);
    try {
      fs.writeFileSync(tmp, `${JSON.stringify({ storeVersion: 1, state })}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      if (process.platform !== 'win32') fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, target);
      cleanupLegacySnapshotTemps(dir, file);
    } finally {
      safeCall(() => fs.rmSync(tmp, { force: true }), null);
    }
  } catch (_) {}
}

function eventName(nativeEvent = {}) {
  return first(nativeEvent.type, nativeEvent.name, nativeEvent.event, nativeEvent.id);
}

function toolPayload(input = {}, output = {}) {
  return {
    sessionID: input.sessionID,
    sessionId: input.sessionId,
    session_id: input.session_id,
    profile: input.profile,
    profileName: input.profileName,
    profile_name: input.profile_name,
    tool: input.tool,
    toolName: input.toolName,
    callID: input.callID,
    callId: input.callId,
    status: output.status,
    result: output.result,
    outcome: output.outcome,
    state: output.state,
    error: output.error,
    failed: output.failed,
    success: output.success,
    observedAt: input.observedAt || output.observedAt,
    timestamp: input.timestamp || output.timestamp,
    surface: input.surface || output.surface,
    client: input.client || output.client,
    origin: input.origin || output.origin
  };
}

export const TokenMonitorAgentState = async (context = {}) => ({
  name: 'token-monitor-agent-state',
  event: async ({ event } = {}) => {
    const payload = event && typeof event === 'object' ? event : {};
    write(eventName(payload), payload, context);
  },
  'tool.execute.before': async (input = {}, output = {}) => {
    write('tool.execute.before', toolPayload(input, output), context);
  },
  'tool.execute.after': async (input = {}, output = {}) => {
    write('tool.execute.after', toolPayload(input, output), context);
  },
  tokenMonitorManaged: 'token-monitor-agent-lifecycle:v1'
});

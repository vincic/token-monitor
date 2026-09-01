#!/usr/bin/env node
// token-monitor-agent-lifecycle:v1
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ADAPTER_VERSION = '2.0.0';
const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_PATH_CHARS = 4096;
const EVENTS = new Set([
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
const FIDELITIES = new Set(['exact', 'inferred', 'presence_only']);

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || '') : '';
}

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

function nested(object, parts) {
  let current = object;
  for (const part of parts) {
    if (!current || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

function defaultRoot() {
  const explicit = arg('--state-root') || process.env.TOKEN_MONITOR_AGENT_STATE_ROOT;
  if (safePath(explicit)) return explicit;
  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || process.env.APPDATA || path.join(home, 'AppData', 'Local'), 'Token Monitor', 'agent-state');
  }
  return path.join(process.env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'token-monitor', 'agent-state');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
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

function validateExistingAncestors(root) {
  const target = canonicalPathForDarwinSystemAliases(root);
  for (const candidate of existingPathComponents(target)) {
    const stat = safeCall(() => fs.lstatSync(candidate), null);
    if (!stat) continue;
    if (stat.isSymbolicLink?.()) return false;
    if (candidate === target) return stat.isDirectory?.() === true;
    if (!stat.isDirectory?.()) return false;
  }
  return true;
}

function createRootUnderValidatedAncestors(root) {
  for (const candidate of existingPathComponents(canonicalPathForDarwinSystemAliases(root))) {
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

function rootIsSafe(root) {
  const canonicalRoot = canonicalPathForDarwinSystemAliases(root);
  if (!validateExistingAncestors(canonicalRoot)) return false;
  const stat = safeCall(() => fs.lstatSync(canonicalRoot), null);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) return false;
  if (process.platform === 'win32') return true;
  const uid = currentUid();
  if (uid !== null && uid !== undefined && stat.uid !== uid) return false;
  return (modeBits(stat) & 0o077) === 0;
}

function sessionKey(harness, profile, sessionId) {
  const raw = typeof sessionId === 'string' ? sessionId.trim().normalize('NFC') : '';
  if (!raw || raw.length > 4096) return '';
  return `sha256:${sha256(`${harness}\0${profile}\0${raw}`)}`;
}

function fileName(harness, profile, sessionId) {
  const key = sessionKey(harness, profile, sessionId);
  return key ? `${sha256(`${harness}\0${profile}\0${key}`)}.json` : '';
}

function ensureRoot(root) {
  const canonicalRoot = canonicalPathForDarwinSystemAliases(root);
  if (!safePath(root) || !validateExistingAncestors(canonicalRoot)) return false;
  if (!createRootUnderValidatedAncestors(canonicalRoot)) return false;
  return rootIsSafe(canonicalRoot);
}

function tempSnapshotPath(root, name) {
  const token = crypto.randomBytes(16).toString('hex');
  const timeNs = typeof process.hrtime?.bigint === 'function' ? process.hrtime.bigint().toString() : `${Date.now()}000000`;
  return path.join(root, `.${name}.${process.pid}.${timeNs}.${token}.tmp`);
}

function cleanupLegacySnapshotTemps(root, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const legacy = new RegExp(`^\\.${escaped}\\.${process.pid}(?:\\.\\d+)?\\.tmp$`);
  for (const entry of safeCall(() => fs.readdirSync(root, { withFileTypes: true }), [])) {
    if (!entry.isFile() || !legacy.test(entry.name)) continue;
    safeCall(() => fs.rmSync(path.join(root, entry.name), { force: true }), null);
  }
}

function sessionId(payload) {
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
    payload.id,
    nested(payload, ['context', 'session_id']),
    nested(payload, ['ctx', 'session_id'])
  );
}

function toolName(payload) {
  return first(payload.toolName, payload.tool_name, payload.tool?.name, payload.tool?.id, payload.call?.toolName, payload.call?.tool_name, payload.name);
}

function profile(payload) {
  return first(arg('--profile'), payload.profile, payload.profileName, payload.profile_name, payload.config?.profile, nested(payload, ['ctx', 'profile_name'])) || 'default';
}

function failed(payload) {
  const status = String(payload.status || payload.result || payload.outcome || payload.state || '').toLowerCase();
  return Boolean(payload.error || payload.failed === true || payload.success === false || payload.terminalFailure === true || payload.terminal_failure === true || ['error', 'failed', 'failure', 'denied', 'rejected'].includes(status));
}

function approvalResolution(payload) {
  const status = String(payload.status || payload.result || payload.outcome || payload.decision || '').toLowerCase();
  if (payload.approved === true || ['approved', 'allowed', 'accepted', 'granted'].includes(status)) return 'approval_resolved';
  if (payload.approved === false || ['denied', 'rejected', 'blocked'].includes(status)) return 'error';
  return '';
}

function mapEvent(harness, nativeEvent, payload) {
  if (harness === 'claude') {
    if (nativeEvent === 'SessionStart') return 'session_started';
    if (nativeEvent === 'UserPromptSubmit') return 'turn_started';
    if (nativeEvent === 'PreToolUse') return 'tool_started';
    if (nativeEvent === 'PostToolUse') return 'tool_finished';
    if (nativeEvent === 'PostToolUseFailure') return failed(payload) ? 'error' : 'tool_finished';
    if (nativeEvent === 'PermissionRequest') return 'approval_requested';
    if (nativeEvent === 'Notification' || nativeEvent === 'PermissionResponse') return approvalResolution(payload);
    if (nativeEvent === 'Stop') return 'turn_completed';
    if (nativeEvent === 'SessionEnd') return 'session_ended';
  }
  if (harness === 'codex') {
    if (nativeEvent === 'SessionStart') return 'session_started';
    if (nativeEvent === 'UserPromptSubmit') return 'turn_started';
    if (nativeEvent === 'PreToolUse') return 'tool_started';
    if (nativeEvent === 'PostToolUse') return failed(payload) ? 'error' : 'tool_finished';
    if (nativeEvent === 'PermissionRequest') return 'approval_requested';
    if (nativeEvent === 'Stop') return 'turn_completed';
    if (nativeEvent === 'PreCompact' || nativeEvent === 'PostCompact') return 'heartbeat';
    if (nativeEvent === 'SubagentStart') return 'session_resumed';
    if (nativeEvent === 'SubagentStop') return 'turn_completed';
  }
  return '';
}

function writeSnapshot(state) {
  if (!state.harness || !state.profile || !state.sessionId || !EVENTS.has(state.event) || !FIDELITIES.has(state.fidelity)) return;
  const root = defaultRoot();
  if (!ensureRoot(root)) return;
  const name = fileName(state.harness, state.profile, state.sessionId);
  if (!/^[a-f0-9]{64}\.json$/.test(name)) return;
  const normalized = { ...state, sessionId: sessionKey(state.harness, state.profile, state.sessionId) };
  const body = `${JSON.stringify({ storeVersion: 1, state: normalized })}\n`;
  const temp = tempSnapshotPath(root, name);
  const target = path.join(root, name);
  try {
    const existing = safeCall(() => fs.lstatSync(target), null);
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) return;
    fs.writeFileSync(temp, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    if (process.platform !== 'win32') fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, target);
    cleanupLegacySnapshotTemps(root, name);
  } catch (_) {
    try { fs.rmSync(temp, { force: true }); } catch (_) {}
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch (_) {}
  }
}

function main() {
  const harness = compact(arg('--harness'));
  const nativeEvent = compact(arg('--native-event'));
  if (!['claude', 'codex'].includes(harness) || !nativeEvent) return;
  let input = '';
  let oversized = false;
  function processInput() {
    try {
      if (!input) input = arg('--payload-json');
      if (oversized || Buffer.byteLength(input, 'utf8') > MAX_STDIN_BYTES) return;
      const payload = input.trim() ? JSON.parse(input) : {};
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
      const event = mapEvent(harness, nativeEvent, payload);
      const rawSessionId = sessionId(payload);
      if (!event || !rawSessionId) return;
      const state = {
        schemaVersion: 1,
        harness,
        profile: profile(payload),
        sessionId: rawSessionId,
        event,
        observedAt: first(payload.observedAt, payload.timestamp, payload.time) || new Date().toISOString(),
        fidelity: 'exact',
        adapterVersion: ADAPTER_VERSION
      };
      const tool = toolName(payload);
      const surface = first(payload.surface, payload.client, payload.origin, payload.app, harness);
      if (tool) state.toolName = tool;
      if (surface) state.surface = surface;
      writeSnapshot(state);
    } catch (_) {}
  }
  const timer = setTimeout(() => {
    processInput();
    process.exit(0);
  }, 2500);
  if (arg('--payload-json')) {
    clearTimeout(timer);
    processInput();
    return;
  }
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    input += chunk;
    if (Buffer.byteLength(input, 'utf8') > MAX_STDIN_BYTES) {
      oversized = true;
      process.stdin.destroy();
    }
  });
  process.stdin.on('end', () => {
    clearTimeout(timer);
    processInput();
  });
  process.stdin.resume();
}

process.stdout.write = () => true;
process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));
main();

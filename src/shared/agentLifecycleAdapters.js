'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const { createAgentStateStore, defaultAgentStateRoot } = require('./agentStateStore');
const { normalizeAgentActivity } = require('./agentActivity');
const { resolveHermesHome } = require('./hermesProfiles');

const AGENT_LIFECYCLE_ADAPTER_VERSION = '2.0.0';
const MANAGED_SIGNATURE = 'token-monitor-agent-lifecycle:v1';
const MANAGED_OWNER = 'Token Monitor agent lifecycle';
const MAX_NATIVE_PAYLOAD_BYTES = 1024 * 1024;
const MAX_CONFIGURED_STATE_ROOT_CHARS = 4096;
const HERMES_HOOKS = Object.freeze([
  'on_session_start',
  'on_session_reset',
  'on_session_end',
  'on_session_finalize',
  'pre_llm_call',
  'post_llm_call',
  'pre_tool_call',
  'post_tool_call',
  'pre_approval_request',
  'post_approval_response',
  'api_request_error'
]);
const CLAUDE_HOOK_EVENTS = Object.freeze([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'Stop',
  'SessionEnd'
]);
const CODEX_HOOK_EVENTS = Object.freeze([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Stop',
  'PreCompact',
  'PostCompact',
  'SubagentStart',
  'SubagentStop'
]);
const AGENT_LIFECYCLE_HARNESSES = Object.freeze(['claude', 'codex', 'opencode', 'hermes']);

function compactString(value, limit = 128) {
  if (typeof value !== 'string') return '';
  return value.trim().normalize('NFC').slice(0, limit);
}

function firstString(...values) {
  for (const value of values) {
    const compact = compactString(value, 4096);
    if (compact) return compact;
  }
  return '';
}

function firstRawString(...values) {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const normalized = value.trim().normalize('NFC');
    if (normalized) return normalized;
  }
  return '';
}

function nested(object, pathParts) {
  let current = object;
  for (const part of pathParts) {
    if (!current || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

function observedAtFromPayload(payload, options = {}) {
  return firstString(payload?.observedAt, payload?.timestamp, payload?.time)
    || new Date(options.nowMs ?? Date.now()).toISOString();
}

function safeToolName(payload) {
  return firstString(
    payload?.toolName,
    payload?.tool_name,
    typeof payload?.tool === 'string' ? payload.tool : '',
    payload?.tool?.name,
    payload?.tool?.id,
    payload?.call?.toolName,
    payload?.call?.tool_name,
    payload?.name
  );
}

function nativeSessionId(payload) {
  return firstRawString(
    payload?.sessionID,
    payload?.sessionId,
    payload?.session_id,
    payload?.session?.id,
    payload?.session?.sessionID,
    payload?.session?.sessionId,
    payload?.session?.session_id,
    payload?.conversationId,
    payload?.conversation_id,
    payload?.id,
    nested(payload, ['context', 'session_id']),
    nested(payload, ['ctx', 'session_id'])
  );
}

function profileName(payload, fallback = 'default') {
  return firstString(
    payload?.profile,
    payload?.profileName,
    payload?.profile_name,
    payload?.config?.profile,
    nested(payload, ['ctx', 'profile_name'])
  ) || fallback;
}

function surfaceName(payload, fallback) {
  return firstString(payload?.surface, payload?.client, payload?.origin, payload?.app, fallback);
}

function eventSnapshot({ harness, profile, sessionId, event, toolName = '', surface = '', fidelity = 'exact', observedAt, adapterVersion = AGENT_LIFECYCLE_ADAPTER_VERSION }, options = {}) {
  const candidate = {
    schemaVersion: 1,
    harness,
    profile,
    sessionId,
    event,
    fidelity,
    observedAt: observedAt || new Date(options.nowMs ?? Date.now()).toISOString(),
    adapterVersion
  };
  if (toolName) candidate.toolName = toolName;
  if (surface) candidate.surface = surface;
  return normalizeAgentActivity(candidate, { allowRawSessionId: true, nowMs: options.nowMs ?? Date.now() });
}

function explicitFailure(payload) {
  const status = String(payload?.status || payload?.result || payload?.outcome || payload?.state || '').toLowerCase();
  return Boolean(
    payload?.error
    || payload?.failed === true
    || payload?.success === false
    || payload?.terminalFailure === true
    || payload?.terminal_failure === true
    || ['error', 'failed', 'failure', 'denied', 'rejected'].includes(status)
  );
}

function explicitApprovalResolution(payload) {
  const status = String(payload?.status || payload?.result || payload?.outcome || payload?.decision || '').toLowerCase();
  if (payload?.approved === true || ['approved', 'allowed', 'accepted', 'granted'].includes(status)) return 'approval_resolved';
  if (payload?.approved === false || ['denied', 'rejected', 'blocked'].includes(status)) return 'error';
  return '';
}

function mapClaudeLifecycleEvent(nativeEvent, payload = {}, options = {}) {
  const name = compactString(nativeEvent);
  const mapped = {
    SessionStart: 'session_started',
    UserPromptSubmit: 'turn_started',
    PreToolUse: 'tool_started',
    PermissionRequest: 'approval_requested',
    Stop: 'turn_completed',
    SessionEnd: 'session_ended'
  }[name] || '';
  let event = mapped;
  if (name === 'PostToolUse') event = 'tool_finished';
  if (name === 'PostToolUseFailure') event = explicitFailure(payload) ? 'error' : 'tool_finished';
  if (name === 'Notification' || name === 'PermissionResponse') event = explicitApprovalResolution(payload);
  if (!event) return null;
  const sessionId = nativeSessionId(payload);
  if (!sessionId) return null;
  return eventSnapshot({
    harness: 'claude',
    profile: profileName(payload),
    sessionId,
    event,
    toolName: safeToolName(payload),
    surface: surfaceName(payload, 'claude'),
    observedAt: observedAtFromPayload(payload, options),
    fidelity: 'exact'
  }, options);
}

function mapCodexLifecycleEvent(nativeEvent, payload = {}, options = {}) {
  const name = compactString(nativeEvent);
  const mapped = {
    SessionStart: 'session_started',
    UserPromptSubmit: 'turn_started',
    PreToolUse: 'tool_started',
    PostToolUse: explicitFailure(payload) ? 'error' : 'tool_finished',
    PermissionRequest: 'approval_requested',
    Stop: 'turn_completed',
    PreCompact: 'heartbeat',
    PostCompact: 'heartbeat',
    SubagentStart: 'session_resumed',
    SubagentStop: 'turn_completed'
  }[name] || '';
  if (!mapped) return null;
  const sessionId = nativeSessionId(payload);
  if (!sessionId) return null;
  return eventSnapshot({
    harness: 'codex',
    profile: profileName(payload),
    sessionId,
    event: mapped,
    toolName: safeToolName(payload),
    surface: surfaceName(payload, 'codex'),
    observedAt: observedAtFromPayload(payload, options),
    fidelity: 'exact'
  }, options);
}

function opencodeSurface(payload = {}, env = process.env) {
  const explicit = compactString(payload.surface || payload.client || payload.origin).toLowerCase();
  if (explicit === 't3code' || explicit === 'herdr' || explicit === 'opencode') return explicit;
  if (env.T3CODE || env.T3CODE_PROFILE || env.T3CODE_SESSION) return 't3code';
  if (env.HERDR || env.HERDR_PROFILE || env.HERDR_SESSION) return 'herdr';
  return 'opencode';
}

function mapOpenCodeLifecycleEvent(nativeEvent, payload = {}, options = {}) {
  const name = compactString(nativeEvent);
  const mapped = {
    'session.created': 'session_started',
    'session.status': payload?.status === 'idle' ? 'turn_completed' : 'heartbeat',
    'session.idle': 'turn_completed',
    'session.error': 'error',
    'permission.asked': 'approval_requested',
    'permission.replied': explicitApprovalResolution(payload) || 'approval_resolved',
    'tool.execute.before': 'tool_started',
    'tool.execute.after': explicitFailure(payload) ? 'error' : 'tool_finished'
  }[name] || '';
  if (!mapped) return null;
  const sessionId = nativeSessionId(payload);
  if (!sessionId) return null;
  return eventSnapshot({
    harness: 'opencode',
    profile: profileName(payload),
    sessionId,
    event: mapped,
    toolName: safeToolName(payload),
    surface: opencodeSurface(payload, options.env || process.env),
    observedAt: observedAtFromPayload(payload, options),
    fidelity: 'exact'
  }, options);
}

function mapHermesLifecycleEvent(nativeEvent, payload = {}, options = {}) {
  const name = compactString(nativeEvent);
  const mapped = {
    on_session_start: 'session_started',
    on_session_reset: 'session_resumed',
    on_session_end: 'session_ended',
    on_session_finalize: 'session_ended',
    pre_llm_call: 'turn_started',
    post_llm_call: explicitFailure(payload) ? 'error' : 'turn_completed',
    pre_tool_call: 'tool_started',
    post_tool_call: explicitFailure(payload) ? 'error' : 'tool_finished',
    pre_approval_request: 'approval_requested',
    post_approval_response: explicitApprovalResolution(payload) || 'approval_resolved',
    api_request_error: 'error'
  }[name] || '';
  if (!mapped) return null;
  const sessionId = nativeSessionId(payload);
  const profile = profileName(payload, '');
  if (!sessionId || !profile) return null;
  return eventSnapshot({
    harness: 'hermes',
    profile,
    sessionId,
    event: mapped,
    toolName: safeToolName(payload),
    surface: surfaceName(payload, 'hermes'),
    observedAt: observedAtFromPayload(payload, options),
    fidelity: 'exact'
  }, options);
}

function repoRoot() {
  return path.resolve(__dirname, '..', '..');
}

function defaultWriterPath(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const env = options.env || process.env;
  if ((options.platform || process.platform) === 'win32') {
    return path.join(env.LOCALAPPDATA || env.APPDATA || path.join(homeDir, 'AppData', 'Local'), 'Token Monitor', 'agent-lifecycle', 'agent-event.js');
  }
  return path.join(env.XDG_DATA_HOME || path.join(homeDir, '.local', 'share'), 'token-monitor', 'agent-lifecycle', 'agent-event.js');
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
  let stat;
  try {
    stat = fs.lstatSync(candidate);
  } catch (_) {
    return '';
  }
  if (!stat.isSymbolicLink() || stat.uid !== 0) return '';
  try {
    return fsRealpath(candidate) === expected ? expected : '';
  } catch (_) {
    return '';
  }
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

function safeExistingParentTraversal(filePath) {
  const resolvedPath = canonicalPathForDarwinSystemAliases(filePath);
  const parent = path.resolve(path.dirname(resolvedPath));
  const root = path.parse(parent).root;
  const parts = parent.slice(root.length).split(path.sep).filter(Boolean);
  let current = root || path.sep;
  for (const part of parts) {
    current = path.join(current, part);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error.code === 'ENOENT') break;
      return { ok: false, code: 'unsafe_destination', path: current, message: error.message };
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return { ok: false, code: 'unsafe_destination', path: current };
    }
  }
  return { ok: true, path: resolvedPath };
}

function safeReadRegularFile(filePath) {
  const traversal = safeExistingParentTraversal(filePath);
  if (!traversal.ok) return { ok: false, exists: true, code: traversal.code, path: traversal.path, message: traversal.message };
  const resolvedPath = traversal.path;
  let stat;
  try {
    stat = fs.lstatSync(resolvedPath);
  } catch (error) {
    if (error.code === 'ENOENT') return { ok: true, exists: false, content: '' };
    return { ok: false, exists: true, code: 'unsafe_destination', path: filePath, message: error.message };
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return { ok: false, exists: true, code: 'unsafe_destination', path: filePath };
  }
  try {
    return { ok: true, exists: true, content: fs.readFileSync(resolvedPath, 'utf8'), path: resolvedPath };
  } catch (error) {
    return { ok: false, exists: true, code: 'unsafe_destination', path: filePath, message: error.message };
  }
}

function safeWritableParentDirectory(filePath) {
  const destination = canonicalPathForDarwinSystemAliases(filePath);
  const parent = path.resolve(path.dirname(destination));
  const root = path.parse(parent).root;
  const parts = parent.slice(root.length).split(path.sep).filter(Boolean);
  let current = root || path.sep;
  for (const part of parts) {
    current = path.join(current, part);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error.code === 'ENOENT') break;
      return { ok: false, code: 'unsafe_destination', path: current, message: error.message };
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return { ok: false, code: 'unsafe_destination', path: current };
    }
  }
  let existing = parent;
  while (true) {
    try {
      const stat = fs.lstatSync(existing);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        return { ok: false, code: 'unsafe_destination', path: existing };
      }
      fs.accessSync(existing, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
      return { ok: true, destination, parent };
    } catch (error) {
      if (error.code !== 'ENOENT') {
        return { ok: false, code: 'unsafe_destination', path: existing, message: error.message };
      }
      const next = path.dirname(existing);
      if (next === existing) return { ok: false, code: 'unsafe_destination', path: parent, message: error.message };
      existing = next;
    }
  }
}

function safeFilePresent(filePath) {
  const file = safeReadRegularFile(filePath);
  return file.ok && file.exists;
}

function copyTemplate(templateRelativePath, destination, options = {}) {
  const parent = safeWritableParentDirectory(destination);
  if (!parent.ok) return { ok: false, changed: false, collision: true, code: parent.code, source: path.join(repoRoot(), templateRelativePath), destination, path: parent.path };
  const writeDestination = parent.destination;
  const source = path.join(repoRoot(), templateRelativePath);
  const sourceContent = fs.readFileSync(source, 'utf8');
  const content = typeof options.renderTemplate === 'function'
    ? options.renderTemplate(sourceContent)
    : sourceContent;
  const file = safeReadRegularFile(writeDestination);
  if (!file.ok) return { ok: false, changed: false, collision: true, code: file.code, source, destination, path: destination };
  const hasExisting = file.exists;
  const existing = file.content;
  const managedTemplate = content.includes(MANAGED_SIGNATURE);
  if (hasExisting && managedTemplate && !existing.includes(MANAGED_SIGNATURE)) {
    return { ok: false, changed: false, collision: true, code: 'unmanaged_collision', source, destination };
  }
  if (options.dryRun) return { ok: true, changed: existing !== content, source, destination };
  fs.mkdirSync(path.dirname(writeDestination), { recursive: true, mode: 0o700 });
  if (existing === content) return { ok: true, changed: false, source, destination };
  const backup = hasExisting && managedTemplate ? backupExisting(writeDestination, options) : '';
  fs.writeFileSync(writeDestination, content, { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(writeDestination, 0o600);
  return { ok: true, changed: true, source, destination, backup };
}

function validateConfiguredStateRoot(value) {
  if (value == null || value === '') return { ok: true, value: '' };
  if (typeof value !== 'string') return { ok: false, code: 'invalid_state_root', message: 'state root must be a string' };
  const text = value.trim();
  if (!text) return { ok: true, value: '' };
  if (text.length > MAX_CONFIGURED_STATE_ROOT_CHARS || /[\0\r\n]/.test(text)) {
    return { ok: false, code: 'invalid_state_root', message: 'state root contains invalid characters or is too long' };
  }
  return { ok: true, value: text };
}

function configuredStateRoot(options = {}) {
  return validateConfiguredStateRoot(options.stateRoot || '');
}

function renderOpenCodePlugin(source, options = {}) {
  const root = configuredStateRoot(options);
  if (!root.ok) throw Object.assign(new Error(root.message), root);
  const rendered = String(source).replace(
    /^const CONFIGURED_DEFAULT_ROOT = .*;$/m,
    `const CONFIGURED_DEFAULT_ROOT = ${JSON.stringify(root.value)};`
  );
  if (root.value && rendered === String(source)) throw Object.assign(new Error('OpenCode plugin state root placeholder was not found'), { code: 'render_failed' });
  return rendered;
}

function hermesSettingsBody(options = {}) {
  const root = configuredStateRoot(options);
  if (!root.ok) return root;
  const templatePath = path.join(repoRoot(), 'integrations/hermes/token-monitor-agent-state/settings.json');
  const template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
  return {
    ok: true,
    content: `${JSON.stringify({ ...template, stateRoot: root.value }, null, 2)}\n`
  };
}

function fileContentChanged(filePath, content) {
  const file = safeReadRegularFile(filePath);
  if (!file.ok) return { ok: false, code: file.code, path: filePath };
  return { ok: true, changed: !file.exists || file.content !== content };
}

function writeManagedFile(filePath, content, options = {}) {
  const parent = safeWritableParentDirectory(filePath);
  if (!parent.ok) return { ok: false, code: parent.code, path: parent.path, message: parent.message };
  const writePath = parent.destination;
  const file = safeReadRegularFile(writePath);
  if (!file.ok) return { ok: false, code: file.code, path: filePath };
  if (options.dryRun) return { ok: true, changed: !file.exists || file.content !== content };
  fs.mkdirSync(path.dirname(writePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(writePath, content, { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(writePath, 0o600);
  return { ok: true, changed: !file.exists || file.content !== content };
}

function parseJsonLiteral(text) {
  try {
    const value = JSON.parse(text);
    return typeof value === 'string' ? value : '';
  } catch (_) {
    return '';
  }
}

function readOpenCodeConfiguredStateRoot(pluginPath) {
  const file = safeReadRegularFile(pluginPath);
  if (!file.ok || !file.exists) return '';
  const content = file.content;
  const match = content.match(/^const CONFIGURED_DEFAULT_ROOT = (.*);$/m);
  return match ? parseJsonLiteral(match[1]) : '';
}

function readHermesConfiguredStateRoot(pluginDir) {
  const settingsPath = path.join(pluginDir, 'settings.json');
  if (!fs.existsSync(settingsPath)) return '';
  const config = readJsonConfig(settingsPath);
  const value = config.ok && typeof config.value?.stateRoot === 'string' ? config.value.stateRoot : '';
  return validateConfiguredStateRoot(value).ok ? value : '';
}

function backupPath(target, options = {}) {
  const stamp = options.backupStamp || new Date(options.nowMs ?? Date.now()).toISOString().replace(/[:.]/g, '-');
  return `${target}.bak.${stamp}`;
}

function backupExisting(target, options = {}) {
  if (!fs.existsSync(target) || options.dryRun) return '';
  let dest = backupPath(target, options);
  let suffix = 1;
  while (fs.existsSync(dest)) {
    suffix += 1;
    dest = `${backupPath(target, options)}.${suffix}`;
  }
  fs.cpSync(target, dest, { recursive: true, force: false, errorOnExist: true });
  return dest;
}

function ensureWriter(options = {}) {
  const writerPath = options.writerPath || defaultWriterPath(options);
  return copyTemplate('integrations/agent-lifecycle/agent-event.js', writerPath, options);
}

function rejectUnsafeShellArg(value) {
  const text = String(value);
  if (/[\0\r\n]/.test(text)) throw new Error('shell arguments must not contain NUL or newlines');
  return text;
}

function posixShellQuote(value) {
  const text = rejectUnsafeShellArg(value);
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function windowsShellQuote(value) {
  const text = rejectUnsafeShellArg(value);
  if (!text) return '""';
  const escaped = text
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\+)$/g, '$1$1')
    .replace(/%/g, '%%')
    .replace(/!/g, '^!');
  return `"${escaped}"`;
}

function shellQuote(value, options = {}) {
  return (options.platform || process.platform) === 'win32'
    ? windowsShellQuote(value)
    : posixShellQuote(value);
}

function writerCommand(harness, nativeEvent, options = {}) {
  const writer = options.writerPath || defaultWriterPath(options);
  const quote = (value) => shellQuote(value, options);
  const args = [
    options.nodePath || process.execPath,
    writer,
    '--harness',
    harness,
    '--native-event',
    nativeEvent
  ];
  const stateRoot = options.stateRoot || '';
  const profile = options.profile || '';
  if (stateRoot) args.push('--state-root', stateRoot);
  if (profile) args.push('--profile', profile);
  return args.map(quote).join(' ');
}

function readJsonConfig(filePath) {
  const file = safeReadRegularFile(filePath);
  if (!file.ok) return { ok: false, code: file.code, path: filePath, message: file.message || 'unsafe file destination' };
  if (!file.exists) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(file.content) };
  } catch (error) {
    return { ok: false, code: 'invalid_json', path: filePath, message: error.message };
  }
}

function writeJsonFile(filePath, value, options = {}) {
  const parent = safeWritableParentDirectory(filePath);
  if (!parent.ok) return { ok: false, code: parent.code, path: parent.path, message: parent.message };
  const writePath = parent.destination;
  const file = safeReadRegularFile(writePath);
  if (!file.ok) return { ok: false, code: file.code, path: filePath, message: file.message };
  const body = `${JSON.stringify(value, null, 2)}\n`;
  if (options.dryRun) return { ok: true, changed: !file.exists || file.content !== body };
  fs.mkdirSync(path.dirname(writePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(writePath, body, { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(writePath, 0o600);
  return { ok: true, changed: true };
}

function managedHook(nativeEvent, command) {
  return {
    matcher: '*',
    hooks: [{
      type: 'command',
      command,
      tokenMonitorManaged: MANAGED_SIGNATURE,
      tokenMonitorOwner: MANAGED_OWNER,
      tokenMonitorEvent: nativeEvent
    }]
  };
}

function isManagedClaudeEntry(entry) {
  return JSON.stringify(entry || '').includes(MANAGED_SIGNATURE);
}

function installClaudeLifecycle(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const settingsPath = options.claudeSettingsPath || path.join(homeDir, '.claude', 'settings.json');
  const config = readJsonConfig(settingsPath);
  if (!config.ok) return { ok: false, harness: 'claude', ...config };
  const writer = ensureWriter(options);
  const settings = config.value;
  if (writer.ok === false) return { ok: false, harness: 'claude', code: writer.code, writerPath: writer.destination, collision: writer.collision };
  const hooks = settings && typeof settings === 'object' && !Array.isArray(settings) && typeof settings.hooks === 'object' && settings.hooks
    ? { ...settings.hooks }
    : {};
  for (const nativeEvent of CLAUDE_HOOK_EVENTS) {
    const existing = Array.isArray(hooks[nativeEvent]) ? hooks[nativeEvent].filter((entry) => !isManagedClaudeEntry(entry)) : [];
    hooks[nativeEvent] = [...existing, managedHook(nativeEvent, writerCommand('claude', nativeEvent, { ...options, writerPath: writer.destination }))];
  }
  const next = { ...(settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {}), hooks };
  if (JSON.stringify(settings) !== JSON.stringify(next)) backupExisting(settingsPath, options);
  const written = writeJsonFile(settingsPath, next, options);
  if (written?.ok === false) return { ok: false, harness: 'claude', code: written.code, path: settingsPath, message: written.message };
  return { ok: true, harness: 'claude', settingsPath, writerPath: writer.destination, dryRun: Boolean(options.dryRun) };
}

function managedClaudeHookCommands(entry) {
  const hooks = Array.isArray(entry?.hooks) ? entry.hooks : [];
  return hooks.filter((hook) => hook && typeof hook === 'object' && !Array.isArray(hook) && (
    hook.tokenMonitorManaged === MANAGED_SIGNATURE
    || JSON.stringify(hook).includes(MANAGED_SIGNATURE)
  ));
}

function analyzeClaudeHooks(settings, options = {}) {
  const hooks = settings && typeof settings === 'object' && !Array.isArray(settings) && settings.hooks && typeof settings.hooks === 'object'
    ? settings.hooks
    : {};
  const writerPath = options.writerPath || defaultWriterPath(options);
  const events = [];
  let managedOccurrenceCount = 0;
  for (const nativeEvent of CLAUDE_HOOK_EVENTS) {
    const expectedCommand = writerCommand('claude', nativeEvent, { ...options, writerPath });
    const entries = Array.isArray(hooks[nativeEvent]) ? hooks[nativeEvent] : [];
    const managedCommands = entries.flatMap((entry) => managedClaudeHookCommands(entry));
    managedOccurrenceCount += managedCommands.length;
    const correct = managedCommands.some((hook) => (
      hook.type === 'command'
      && hook.command === expectedCommand
      && hook.tokenMonitorManaged === MANAGED_SIGNATURE
      && hook.tokenMonitorOwner === MANAGED_OWNER
      && hook.tokenMonitorEvent === nativeEvent
    ));
    const wrongCommand = managedCommands.some((hook) => (
      hook.type === 'command'
      && hook.tokenMonitorManaged === MANAGED_SIGNATURE
      && hook.tokenMonitorOwner === MANAGED_OWNER
      && hook.tokenMonitorEvent === nativeEvent
      && hook.command !== expectedCommand
    ));
    events.push({
      event: nativeEvent,
      ok: correct,
      managed: managedCommands.length > 0,
      wrongCommand,
      expectedCommand
    });
  }
  const missingEvents = events.filter((event) => !event.managed).map((event) => event.event);
  const partialEvents = events.filter((event) => event.managed && !event.ok).map((event) => event.event);
  const wrongCommandEvents = events.filter((event) => event.wrongCommand).map((event) => event.event);
  const configuredEvents = events.filter((event) => event.ok).map((event) => event.event);
  const complete = events.every((event) => event.ok);
  return {
    complete,
    configuredEvents,
    missingEvents,
    partialEvents,
    wrongCommandEvents,
    managedOccurrenceCount,
    events
  };
}

function uninstallClaudeLifecycle(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const settingsPath = options.claudeSettingsPath || path.join(homeDir, '.claude', 'settings.json');
  const config = readJsonConfig(settingsPath);
  if (!config.ok) return { ok: false, harness: 'claude', ...config };
  const settings = config.value;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings) || !settings.hooks) return { ok: true, harness: 'claude', changed: false };
  const hooks = { ...settings.hooks };
  let changed = false;
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    const kept = entries.filter((entry) => !isManagedClaudeEntry(entry));
    if (kept.length !== entries.length) changed = true;
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  if (changed) {
    backupExisting(settingsPath, options);
    const written = writeJsonFile(settingsPath, { ...settings, hooks }, options);
    if (written?.ok === false) return { ok: false, harness: 'claude', code: written.code, path: settingsPath, message: written.message };
  }
  return { ok: true, harness: 'claude', changed, settingsPath, dryRun: Boolean(options.dryRun) };
}

function upsertFeatureHooks(toml) {
  const lines = String(toml || '').split(/\r?\n/);
  const featureIndex = lines.findIndex((line) => /^\s*\[features\]\s*$/.test(line));
  if (featureIndex < 0) return `${String(toml || '').trimEnd()}\n\n[features]\nhooks = true\n`;
  let end = lines.length;
  for (let index = featureIndex + 1; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index])) { end = index; break; }
  }
  let sawHooks = false;
  const section = lines.slice(featureIndex + 1, end).filter((line) => {
    if (/^\s*hooks\s*=/.test(line)) {
      if (sawHooks) return false;
      sawHooks = true;
      return false;
    }
    return true;
  });
  section.unshift('hooks = true');
  return [...lines.slice(0, featureIndex + 1), ...section, ...lines.slice(end)].join('\n').replace(/\n*$/, '\n');
}

function tomlString(value) {
  return JSON.stringify(rejectUnsafeShellArg(value));
}

function codexManagedBlock(options = {}) {
  const blocks = [];
  for (const nativeEvent of CODEX_HOOK_EVENTS) {
    blocks.push(
      `[[hooks.${nativeEvent}]]`,
      `command = ${tomlString(options.nodePath || process.execPath)}`,
      `args = [${[
        options.writerPath || defaultWriterPath(options),
        '--harness',
        'codex',
        '--native-event',
        nativeEvent,
        ...(options.stateRoot ? ['--state-root', options.stateRoot] : []),
        ...(options.profile ? ['--profile', options.profile] : [])
      ].map((value) => tomlString(String(value))).join(', ')}]`,
      ''
    );
  }
  return [
    `# >>> ${MANAGED_SIGNATURE}`,
    `# owner = ${MANAGED_OWNER}`,
    ...blocks,
    `# <<< ${MANAGED_SIGNATURE}`
  ].join('\n');
}

function stripCodexManagedBlock(toml) {
  return String(toml || '').replace(new RegExp(`\\n?# >>> ${MANAGED_SIGNATURE}[\\s\\S]*?# <<< ${MANAGED_SIGNATURE}\\n?`, 'g'), '\n').replace(/\n{3,}/g, '\n\n');
}

function stripTomlComment(line) {
  let quote = '';
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quote = '';
      continue;
    }
    if (quote === "'") {
      if (char === "'") quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '#') return line.slice(0, index);
  }
  return line;
}

function tomlQuotesBalanced(text) {
  let quote = '';
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quote = '';
      continue;
    }
    if (quote === "'") {
      if (char === "'") quote = '';
      continue;
    }
    if (char === '"' || char === "'") quote = char;
  }
  return quote === '' && !escaped;
}

function bracketBalanceOk(text) {
  const pairs = { '[': ']', '{': '}' };
  const stack = [];
  let quote = '';
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quote = '';
      continue;
    }
    if (quote === "'") {
      if (char === "'") quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (pairs[char]) stack.push(pairs[char]);
    else if (char === ']' || char === '}') {
      if (stack.pop() !== char) return false;
    }
  }
  return stack.length === 0 && quote === '' && !escaped;
}

function unquotedTomlCompoundDelta(text) {
  let delta = 0;
  let quote = '';
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quote = '';
      continue;
    }
    if (quote === "'") {
      if (char === "'") quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '[' || char === '{') delta += 1;
    else if (char === ']' || char === '}') delta -= 1;
  }
  return delta;
}

function validateCodexTomlParseable(content) {
  const text = String(content || '');
  if (!tomlQuotesBalanced(text) || !bracketBalanceOk(text)) {
    return { ok: false, code: 'invalid_toml', message: 'Codex config is not valid TOML' };
  }
  const lines = text.split(/\r?\n/);
  let compoundDepth = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = stripTomlComment(lines[index]).trim();
    if (!line) continue;
    if (compoundDepth > 0) {
      compoundDepth += unquotedTomlCompoundDelta(line);
      continue;
    }
    if (/^\[\[[^\]]+\]\]$/.test(line) || /^\[[^\]]+\]$/.test(line)) continue;
    const equalsIndex = line.indexOf('=');
    if (equalsIndex <= 0 || equalsIndex === line.length - 1) {
      return { ok: false, code: 'invalid_toml', message: `Codex config is not valid TOML near line ${index + 1}` };
    }
    const value = line.slice(equalsIndex + 1);
    compoundDepth += unquotedTomlCompoundDelta(value);
  }
  return { ok: true };
}

function readCodexConfigForInstall(configPath) {
  const parent = safeWritableParentDirectory(configPath);
  if (!parent.ok) return parent;
  const config = safeReadRegularFile(parent.destination);
  if (!config.ok) return { ok: false, code: config.code, path: configPath, message: config.message };
  const parseable = validateCodexTomlParseable(config.exists ? config.content : '');
  if (!parseable.ok) return { ...parseable, path: configPath };
  return { ...config, path: parent.destination };
}

function installCodexLifecycle(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const configPath = options.codexConfigPath || path.join(homeDir, '.codex', 'config.toml');
  const support = installSupportForHarness('codex', options);
  if (!support.exact && !options.forceUnsupported) return unsupportedInstallResult('codex', support);
  const config = readCodexConfigForInstall(configPath);
  if (!config.ok) return { ok: false, harness: 'codex', code: config.code, path: config.path || configPath, message: config.message };
  const writeConfigPath = config.path || configPath;
  const existing = config.exists ? config.content : '';
  const writer = ensureWriter(options);
  if (writer.ok === false) return { ok: false, harness: 'codex', code: writer.code, writerPath: writer.destination, collision: writer.collision };
  const next = `${stripCodexManagedBlock(upsertFeatureHooks(existing)).trimEnd()}\n\n${codexManagedBlock({ ...options, writerPath: writer.destination })}\n`;
  if (existing !== next) backupExisting(writeConfigPath, options);
  if (!options.dryRun) {
    fs.mkdirSync(path.dirname(writeConfigPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(writeConfigPath, next, { encoding: 'utf8', mode: 0o600 });
    if (process.platform !== 'win32') fs.chmodSync(writeConfigPath, 0o600);
  }
  return { ok: true, harness: 'codex', configPath, writerPath: writer.destination, changed: existing !== next || writer.changed, version: support.version, dryRun: Boolean(options.dryRun), forced: !support.exact };
}

function uninstallCodexLifecycle(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const configPath = options.codexConfigPath || path.join(homeDir, '.codex', 'config.toml');
  const parent = safeWritableParentDirectory(configPath);
  if (!parent.ok) return { ok: false, harness: 'codex', code: parent.code, path: parent.path };
  const writeConfigPath = parent.destination;
  const config = safeReadRegularFile(writeConfigPath);
  if (!config.ok) return { ok: false, harness: 'codex', code: config.code, path: configPath };
  if (!config.exists) return { ok: true, harness: 'codex', changed: false };
  const existing = config.content;
  const next = stripCodexManagedBlock(existing);
  const changed = next !== existing;
  if (changed) {
    backupExisting(writeConfigPath, options);
    if (!options.dryRun) fs.writeFileSync(writeConfigPath, next, { encoding: 'utf8', mode: 0o600 });
  }
  return { ok: true, harness: 'codex', changed, configPath, dryRun: Boolean(options.dryRun) };
}

function commandRunner(options = {}) {
  return options.commandRunner || options.spawnSync || childProcess.spawnSync;
}

function commandOutput(result) {
  return `${result?.stdout || ''}\n${result?.stderr || ''}`.trim();
}

function probeCommandVersion(command, options = {}) {
  const runner = commandRunner(options);
  try {
    const result = runner(command, ['--version'], {
      encoding: 'utf8',
      env: options.env || process.env,
      timeout: 5000
    });
    const output = commandOutput(result);
    const version = output.match(/(\d+\.\d+\.\d+)/)?.[1] || '';
    return {
      ok: result && result.error == null && result.status === 0 && Boolean(version),
      command,
      version,
      output,
      code: result?.error ? 'command_unavailable' : (version ? 'ok' : 'version_unknown')
    };
  } catch (error) {
    return { ok: false, command, version: '', output: '', code: 'command_unavailable', message: error.message };
  }
}

function resolveHarnessVersion(harness, options = {}) {
  const explicit = {
    codex: options.codexVersion || options.version,
    opencode: options.opencodeVersion || options.version,
    hermes: options.hermesVersion || options.version
  }[harness];
  if (explicit) return { ok: true, version: compactString(explicit), source: 'option' };
  if (options.skipVersionProbe) return { ok: false, version: '', source: 'skipped', code: 'version_probe_skipped' };
  const command = {
    codex: options.codexCommand || 'codex',
    opencode: options.opencodeCommand || 'opencode',
    hermes: options.hermesCommand || 'hermes'
  }[harness];
  const probe = probeCommandVersion(command, options);
  return { ...probe, source: 'command' };
}

function supportForHarness(harness, options = {}) {
  const versionProbe = resolveHarnessVersion(harness, options);
  const support = {
    codex: codexHookSupport,
    opencode: opencodeSupport,
    hermes: hermesSupport
  }[harness]?.(versionProbe.version) || { exact: false, reason: 'unknown_harness' };
  return { ...support, version: versionProbe.version, versionSource: versionProbe.source, probe: versionProbe };
}

function installSupportForHarness(harness, options = {}) {
  return supportForHarness(harness, options);
}

function unsupportedInstallResult(harness, support) {
  return {
    ok: false,
    harness,
    code: `${harness}_unsupported`,
    fidelity: 'presence_only',
    reason: support.reason,
    version: support.version || ''
  };
}

function installOpenCodeLifecycle(options = {}) {
  const support = installSupportForHarness('opencode', options);
  if (!support.exact && !options.forceUnsupported) return unsupportedInstallResult('opencode', support);
  const root = configuredStateRoot(options);
  if (!root.ok) return { ok: false, harness: 'opencode', code: root.code, message: root.message };
  const homeDir = options.homeDir || os.homedir();
  const configDir = options.opencodeConfigDir || path.join(homeDir, '.config', 'opencode');
  const pluginPath = path.join(configDir, 'plugins', 'token-monitor-agent-state.js');
  const existingPlugin = safeReadRegularFile(pluginPath);
  if (!existingPlugin.ok) return { ok: false, harness: 'opencode', code: existingPlugin.code, path: pluginPath, collision: true };
  if (existingPlugin.exists) {
    const existing = existingPlugin.content;
    if (!existing.includes(MANAGED_SIGNATURE)) return { ok: false, harness: 'opencode', code: 'unmanaged_collision', path: pluginPath };
  }
  let result;
  try {
    result = copyTemplate('integrations/opencode/token-monitor-agent-state.js', pluginPath, {
      ...options,
      renderTemplate: (source) => renderOpenCodePlugin(source, { ...options, stateRoot: root.value })
    });
  } catch (error) {
    return { ok: false, harness: 'opencode', code: error.code || 'render_failed', message: error.message };
  }
  if (result.ok === false) return { ok: false, harness: 'opencode', code: result.code, path: pluginPath, collision: result.collision };
  return { ok: true, harness: 'opencode', pluginPath, changed: result.changed, version: support.version, dryRun: Boolean(options.dryRun), forced: !support.exact };
}

function uninstallOpenCodeLifecycle(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const configDir = options.opencodeConfigDir || path.join(homeDir, '.config', 'opencode');
  const pluginPath = path.join(configDir, 'plugins', 'token-monitor-agent-state.js');
  const plugin = safeReadRegularFile(pluginPath);
  if (!plugin.ok) return { ok: false, harness: 'opencode', code: plugin.code, path: pluginPath, collision: true };
  if (!plugin.exists) return { ok: true, harness: 'opencode', changed: false };
  const existing = plugin.content;
  if (!existing.includes(MANAGED_SIGNATURE)) return { ok: false, harness: 'opencode', code: 'unmanaged_collision', path: pluginPath };
  backupExisting(pluginPath, options);
  if (!options.dryRun) fs.rmSync(pluginPath, { force: true });
  return { ok: true, harness: 'opencode', changed: true, pluginPath, dryRun: Boolean(options.dryRun) };
}

function safeHermesProfilePath(hermesHome, profile) {
  const name = compactString(profile);
  if (!name || name === '.' || name === '..' || /[\\/]/.test(name)) return '';
  const base = path.resolve(hermesHome, 'profiles');
  const target = path.resolve(base, name);
  return target.startsWith(`${base}${path.sep}`) ? target : '';
}

function hermesPluginDir(options = {}) {
  const hermesHome = options.hermesHome || resolveHermesHome(options);
  const profile = options.profile || 'default';
  if (profile === 'default') return path.join(hermesHome, 'plugins', 'token-monitor-agent-state');
  const profilePath = safeHermesProfilePath(hermesHome, profile);
  if (!profilePath) return '';
  return path.join(profilePath, 'plugins', 'token-monitor-agent-state');
}

function hermesCommandArgs(action, profile) {
  const args = [];
  if (profile && profile !== 'default') args.push('--profile', profile);
  args.push('plugins', action);
  if (action !== 'list') args.push('token-monitor-agent-state');
  return args;
}

function runHermesPluginCommand(action, profile, options = {}) {
  const args = hermesCommandArgs(action, profile);
  if (options.dryRun) return { ok: true, dryRun: true, command: options.hermesCommand || 'hermes', args };
  const runner = commandRunner(options);
  const command = options.hermesCommand || 'hermes';
  try {
    const result = runner(command, args, {
      encoding: 'utf8',
      env: options.env || process.env,
      timeout: 10000
    });
    return {
      ok: result && result.error == null && result.status === 0,
      command,
      args,
      stdout: result?.stdout || '',
      stderr: result?.stderr || '',
      status: result?.status,
      code: result?.error ? 'command_unavailable' : (result?.status === 0 ? 'ok' : `${action}_failed`)
    };
  } catch (error) {
    return { ok: false, command, args, code: 'command_unavailable', message: error.message };
  }
}

function installHermesLifecycle(options = {}) {
  const support = installSupportForHarness('hermes', options);
  if (!support.exact && !options.forceUnsupported) return unsupportedInstallResult('hermes', support);
  const settings = hermesSettingsBody(options);
  if (!settings.ok) return { ok: false, harness: 'hermes', code: settings.code, message: settings.message };
  const profiles = (options.profiles && options.profiles.length ? options.profiles : [options.profile || 'default']).map(String);
  const results = [];
  for (const profile of profiles) {
    const pluginDir = hermesPluginDir({ ...options, profile });
    if (!pluginDir) {
      results.push({ ok: false, harness: 'hermes', profile, code: 'invalid_profile' });
      continue;
    }
    const existed = fs.existsSync(pluginDir);
    let backup = '';
    if (existed) {
      let pluginDirStat;
      try {
        pluginDirStat = fs.lstatSync(pluginDir);
      } catch (error) {
        results.push({ ok: false, harness: 'hermes', profile, code: 'unsafe_destination', path: pluginDir, message: error.message });
        continue;
      }
      if (!pluginDirStat.isDirectory() || pluginDirStat.isSymbolicLink()) {
        results.push({ ok: false, harness: 'hermes', profile, code: 'unmanaged_collision', path: pluginDir });
        continue;
      }
      const marker = path.join(pluginDir, '.token-monitor-agent-lifecycle');
      const markerFile = safeReadRegularFile(marker);
      if (!markerFile.ok || !markerFile.exists || !markerFile.content.includes(MANAGED_SIGNATURE)) {
        results.push({ ok: false, harness: 'hermes', profile, code: 'unmanaged_collision', path: pluginDir });
        continue;
      }
    }
    const pluginFiles = ['plugin.yaml', '__init__.py', 'bridge.py', 'diagnostics.py'];
    let changed = !existed;
    for (const file of pluginFiles) {
      const planned = copyTemplate(`integrations/hermes/token-monitor-agent-state/${file}`, path.join(pluginDir, file), { ...options, profile, dryRun: true });
      if (planned.ok === false) {
        results.push({ ok: false, harness: 'hermes', profile, code: planned.code, path: planned.destination, collision: planned.collision });
        changed = null;
        break;
      }
      changed = changed || planned.changed;
    }
    if (changed === null) continue;
    const settingsPath = path.join(pluginDir, 'settings.json');
    const settingsChanged = fileContentChanged(settingsPath, settings.content);
    if (!settingsChanged.ok) {
      results.push({ ok: false, harness: 'hermes', profile, code: settingsChanged.code, path: settingsPath });
      continue;
    }
    changed = changed || settingsChanged.changed;
    const markerPath = path.join(pluginDir, '.token-monitor-agent-lifecycle');
    const markerBody = `${MANAGED_SIGNATURE}\nprofile=${profile}\n`;
    const markerFile = safeReadRegularFile(markerPath);
    if (!markerFile.ok && markerFile.exists) {
      results.push({ ok: false, harness: 'hermes', profile, code: markerFile.code, path: markerPath });
      continue;
    }
    const markerChanged = !markerFile.exists || markerFile.content !== markerBody;
    changed = changed || markerChanged;
    if (existed && changed) backup = backupExisting(pluginDir, options);
    if (!options.dryRun) fs.mkdirSync(pluginDir, { recursive: true, mode: 0o700 });
    let copyFailed = false;
    for (const file of pluginFiles) {
      const copied = copyTemplate(`integrations/hermes/token-monitor-agent-state/${file}`, path.join(pluginDir, file), { ...options, profile });
      if (copied.ok === false) {
        results.push({ ok: false, harness: 'hermes', profile, code: copied.code, path: copied.destination, collision: copied.collision });
        copyFailed = true;
        continue;
      }
    }
    if (copyFailed) continue;
    const settingsWrite = writeManagedFile(settingsPath, settings.content, options);
    if (settingsWrite?.ok === false) {
      results.push({ ok: false, harness: 'hermes', profile, code: settingsWrite.code, path: settingsPath });
      continue;
    }
    if (!options.dryRun && markerChanged) fs.writeFileSync(markerPath, markerBody, { mode: 0o600 });
    const enabled = runHermesPluginCommand('enable', profile, options);
    if (!enabled.ok) {
      if (!options.dryRun) {
        if (!existed) fs.rmSync(pluginDir, { recursive: true, force: true });
        else if (backup) {
          fs.rmSync(pluginDir, { recursive: true, force: true });
          fs.cpSync(backup, pluginDir, { recursive: true, force: false, errorOnExist: true });
        }
      }
      results.push({ ok: false, harness: 'hermes', profile, code: enabled.code || 'enable_failed', pluginDir, command: enabled, dryRun: Boolean(options.dryRun) });
      continue;
    }
    results.push({ ok: true, harness: 'hermes', profile, pluginDir, changed, command: enabled, version: support.version, dryRun: Boolean(options.dryRun), forced: !support.exact });
  }
  return { ok: results.every((result) => result.ok), harness: 'hermes', results };
}

function uninstallHermesLifecycle(options = {}) {
  const profiles = (options.profiles && options.profiles.length ? options.profiles : [options.profile || 'default']).map(String);
  const results = [];
  for (const profile of profiles) {
    const pluginDir = hermesPluginDir({ ...options, profile });
    if (!pluginDir || !fs.existsSync(pluginDir)) {
      results.push({ ok: true, harness: 'hermes', profile, changed: false });
      continue;
    }
    let pluginDirStat;
    try {
      pluginDirStat = fs.lstatSync(pluginDir);
    } catch (error) {
      results.push({ ok: false, harness: 'hermes', profile, code: 'unsafe_destination', path: pluginDir, message: error.message });
      continue;
    }
    if (!pluginDirStat.isDirectory() || pluginDirStat.isSymbolicLink()) {
      results.push({ ok: false, harness: 'hermes', profile, code: 'unmanaged_collision', path: pluginDir });
      continue;
    }
    const marker = path.join(pluginDir, '.token-monitor-agent-lifecycle');
    const markerFile = safeReadRegularFile(marker);
    if (!markerFile.ok || !markerFile.exists || !markerFile.content.includes(MANAGED_SIGNATURE)) {
      results.push({ ok: false, harness: 'hermes', profile, code: 'unmanaged_collision', path: pluginDir });
      continue;
    }
    const disabled = runHermesPluginCommand('disable', profile, options);
    if (!disabled.ok) {
      results.push({ ok: false, harness: 'hermes', profile, code: disabled.code || 'disable_failed', pluginDir, command: disabled, dryRun: Boolean(options.dryRun) });
      continue;
    }
    backupExisting(pluginDir, options);
    if (!options.dryRun) fs.rmSync(pluginDir, { recursive: true, force: true });
    results.push({ ok: true, harness: 'hermes', profile, changed: true, pluginDir, command: disabled, dryRun: Boolean(options.dryRun) });
  }
  return { ok: results.every((result) => result.ok), harness: 'hermes', results };
}

function parseVersion(version) {
  const match = String(version || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

function compareVersion(a, b) {
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function codexHookSupport(version) {
  const parsed = parseVersion(version);
  if (!parsed) return { exact: false, reason: 'version_unknown' };
  if (compareVersion(parsed, [0, 139, 0]) >= 0 && compareVersion(parsed, [0, 150, 1]) <= 0) {
    return { exact: true, reason: 'codex_native_hooks_supported' };
  }
  return { exact: false, reason: 'codex_native_hooks_unsupported' };
}

function opencodeSupport(version) {
  return ['1.18.18', '1.18.25'].includes(String(version || ''))
    ? { exact: true, reason: 'opencode_plugin_supported' }
    : { exact: false, reason: version ? 'opencode_version_unverified' : 'version_unknown' };
}

function hermesSupport(version) {
  return ['0.19.0', '0.20.5'].includes(String(version || ''))
    ? { exact: true, reason: 'hermes_plugin_supported' }
    : { exact: false, reason: version ? 'hermes_version_unverified' : 'version_unknown' };
}

function doctorAgentLifecycle(options = {}) {
  const requestedRoot = configuredStateRoot({ stateRoot: options.stateRoot || '' });
  if (!requestedRoot.ok) return { ok: false, code: requestedRoot.code, message: requestedRoot.message, results: [] };
  const root = requestedRoot.value || defaultAgentStateRoot(options);
  const store = createAgentStateStore({ root });
  const stateRoot = store.prepare();
  const synthetic = stateRoot.ok ? store.record({
    schemaVersion: 1,
    harness: 'doctor',
    profile: 'doctor',
    sessionId: `synthetic-${Date.now()}`,
    event: 'heartbeat',
    observedAt: new Date().toISOString(),
    fidelity: 'exact',
    adapterVersion: AGENT_LIFECYCLE_ADAPTER_VERSION
  }) : { ok: false };
  const results = [];
  const selected = new Set(options.harnesses || (options.harness ? [options.harness] : ['claude', 'codex', 'opencode', 'hermes']));
  for (const harness of selected) {
    if (!AGENT_LIFECYCLE_HARNESSES.includes(harness)) {
      results.push({ ok: false, harness, code: 'unknown_harness' });
    }
  }
  if (selected.has('claude')) {
    const homeDir = options.homeDir || os.homedir();
    const settingsPath = options.claudeSettingsPath || path.join(homeDir, '.claude', 'settings.json');
    const config = readJsonConfig(settingsPath);
    const writerPath = options.writerPath || defaultWriterPath(options);
    const writerPresent = safeFilePresent(writerPath);
    const hookStatus = config.ok ? analyzeClaudeHooks(config.value, { ...options, writerPath }) : analyzeClaudeHooks({}, { ...options, writerPath });
    const installed = hookStatus.complete && writerPresent;
    const hasManagedPresence = hookStatus.managedOccurrenceCount > 0;
    results.push({
      harness: 'claude',
      capability: installed ? 'exact' : (hasManagedPresence ? 'presence_only' : 'not_configured'),
      reason: installed ? 'claude_hooks_configurable' : (hasManagedPresence ? 'claude_adapter_partial' : 'claude_adapter_not_installed'),
      settingsPath,
      settingsOk: config.ok,
      code: config.ok ? undefined : config.code,
      installed,
      hooksConfigured: hookStatus.complete,
      configuredEvents: hookStatus.configuredEvents,
      missingEvents: hookStatus.missingEvents,
      partialEvents: hookStatus.partialEvents,
      wrongCommandEvents: hookStatus.wrongCommandEvents,
      writerPath,
      writerPresent,
      stateRoot,
      syntheticWrite: synthetic.ok
    });
  }
  if (selected.has('codex')) {
    const support = supportForHarness('codex', options);
    const homeDir = options.homeDir || os.homedir();
    const configPath = options.codexConfigPath || path.join(homeDir, '.codex', 'config.toml');
    const configFile = safeReadRegularFile(configPath);
    const config = configFile.ok && configFile.exists ? configFile.content : '';
    const installed = config.includes(MANAGED_SIGNATURE);
    const managedHooks = CODEX_HOOK_EVENTS.filter((event) => config.includes(`[[hooks.${event}]]`));
    const hooksEnabled = /^\s*hooks\s*=\s*true\s*$/m.test(config);
    const writerPath = options.writerPath || defaultWriterPath(options);
    const writerPresent = safeFilePresent(writerPath);
    results.push({
      harness: 'codex',
      capability: support.exact && installed && hooksEnabled && managedHooks.length === CODEX_HOOK_EVENTS.length && writerPresent ? 'exact' : 'presence_only',
      reason: support.reason,
      version: support.version,
      configPath,
      configOk: configFile.ok,
      code: configFile.ok ? undefined : configFile.code,
      installed,
      hooksEnabled,
      managedHooks,
      writerPath,
      writerPresent,
      stateRoot,
      syntheticWrite: synthetic.ok
    });
  }
  if (selected.has('opencode')) {
    const support = supportForHarness('opencode', options);
    const homeDir = options.homeDir || os.homedir();
    const configDir = options.opencodeConfigDir || path.join(homeDir, '.config', 'opencode');
    const pluginPath = path.join(configDir, 'plugins', 'token-monitor-agent-state.js');
    const pluginFile = safeReadRegularFile(pluginPath);
    const installed = pluginFile.ok && pluginFile.exists && pluginFile.content.includes(MANAGED_SIGNATURE);
    const configuredRoot = installed ? readOpenCodeConfiguredStateRoot(pluginPath) : '';
    const configuredRootMatches = !requestedRoot.value || configuredRoot === requestedRoot.value;
    results.push({ harness: 'opencode', capability: support.exact && installed && configuredRootMatches ? 'exact' : 'presence_only', reason: support.reason, version: support.version, pluginPath, pluginOk: pluginFile.ok, code: pluginFile.ok ? undefined : pluginFile.code, installed, configuredRoot, configuredRootMatches, stateRoot, syntheticWrite: synthetic.ok });
  }
  if (selected.has('hermes')) {
    const support = supportForHarness('hermes', options);
    const profiles = (options.profiles && options.profiles.length ? options.profiles : [options.profile || 'default']).map(String);
    for (const profile of profiles) {
      const pluginDir = hermesPluginDir({ ...options, profile });
      const markerFile = pluginDir ? safeReadRegularFile(path.join(pluginDir, '.token-monitor-agent-lifecycle')) : { ok: false };
      const installed = Boolean(pluginDir && markerFile.ok && markerFile.exists);
      const configuredRoot = installed ? readHermesConfiguredStateRoot(pluginDir) : '';
      const configuredRootMatches = !requestedRoot.value || configuredRoot === requestedRoot.value;
      const list = installed ? runHermesPluginCommand('list', profile, options) : { ok: false, code: 'plugin_missing' };
      const listedEnabled = hermesListShowsEnabled(list.stdout || '', 'token-monitor-agent-state');
      const diagnostic = installed ? runDoctorHermesImport({ ...options, profile, pluginDir, stateRoot: root }) : { ok: false, code: 'plugin_missing' };
      results.push({
        harness: 'hermes',
        profile,
        capability: support.exact && installed && configuredRootMatches && listedEnabled && diagnostic.ok ? 'exact' : 'presence_only',
        reason: support.reason,
        version: support.version,
        hooks: HERMES_HOOKS,
        pluginDir,
        installed,
        configuredRoot,
        configuredRootMatches,
        listedEnabled,
        list,
        diagnostic,
        stateRoot,
        syntheticWrite: synthetic.ok
      });
    }
  }
  return { ok: stateRoot.ok && results.every((result) => result.capability === 'exact'), stateRoot: root, results };
}

function testAgentLifecycle(options = {}) {
  const root = options.stateRoot || defaultAgentStateRoot(options);
  const store = createAgentStateStore({ root });
  const record = store.record({
    schemaVersion: 1,
    harness: options.harness || 'codex',
    profile: options.profile || 'doctor',
    sessionId: `synthetic-${Date.now()}`,
    event: 'heartbeat',
    observedAt: new Date().toISOString(),
    fidelity: 'exact',
    adapterVersion: AGENT_LIFECYCLE_ADAPTER_VERSION
  });
  return { ok: record.ok, stateRoot: root, record };
}

function installAgentLifecycle(options = {}) {
  const harnesses = options.harnesses || ['claude', 'codex', 'opencode', 'hermes'];
  return harnesses.map((harness) => ({
    claude: installClaudeLifecycle,
    codex: installCodexLifecycle,
    opencode: installOpenCodeLifecycle,
    hermes: installHermesLifecycle
  }[harness]?.(options) || { ok: false, harness, code: 'unknown_harness' }));
}

function uninstallAgentLifecycle(options = {}) {
  const harnesses = options.harnesses || ['claude', 'codex', 'opencode', 'hermes'];
  return harnesses.map((harness) => ({
    claude: uninstallClaudeLifecycle,
    codex: uninstallCodexLifecycle,
    opencode: uninstallOpenCodeLifecycle,
    hermes: uninstallHermesLifecycle
  }[harness]?.(options) || { ok: false, harness, code: 'unknown_harness' }));
}

function hermesListShowsEnabled(stdout, pluginName) {
  const line = String(stdout || '').split(/\r?\n/).find((candidate) => candidate.includes(pluginName));
  if (!line) return false;
  return !/\b(disabled|false|off)\b/i.test(line) && /\b(enabled|true|on|\*)\b/i.test(line);
}

function runDoctorHermesImport(options = {}) {
  const pluginDir = options.pluginDir || hermesPluginDir(options);
  const python = options.python || discoverHermesPython({ ...options, pluginDir }) || 'python3';
  const script = path.join(pluginDir, 'diagnostics.py');
  if (!fs.existsSync(script)) return { ok: false, code: 'plugin_missing', pluginDir };
  const runner = commandRunner(options);
  const result = runner(python, [script], {
    cwd: pluginDir,
    env: { ...(options.env || process.env), TOKEN_MONITOR_AGENT_STATE_ROOT: options.stateRoot || '' },
    encoding: 'utf8',
    timeout: 5000
  });
  let parsed = null;
  try {
    parsed = JSON.parse(String(result.stdout || '').trim());
  } catch (_) {}
  const declared = Array.isArray(parsed?.declaredHooks) ? parsed.declaredHooks : [];
  const manifest = Array.isArray(parsed?.manifestHooks) ? parsed.manifestHooks : declared;
  const registered = Array.isArray(parsed?.registeredHooks) ? parsed.registeredHooks : declared;
  const registeredTools = Number.isSafeInteger(parsed?.registeredTools) ? parsed.registeredTools : 0;
  const expectedHooks = HERMES_HOOKS.length === declared.length
    && HERMES_HOOKS.every((hook, index) => declared[index] === hook);
  const manifestMatchesDeclared = manifest.length === declared.length
    && manifest.every((hook, index) => hook === declared[index]);
  const registeredMatchesDeclared = registered.length === declared.length
    && registered.every((hook, index) => hook === declared[index]);
  const hookSubset = parsed && typeof parsed.adapterHooksPresent === 'boolean'
    ? parsed.adapterHooksPresent
    : registered.every((hook) => HERMES_HOOKS.includes(hook));
  const diagnosticOk = result.status === 0
    && parsed?.ok === true
    && expectedHooks
    && manifestMatchesDeclared
    && registeredMatchesDeclared
    && hookSubset
    && registeredTools === 0;
  return {
    ok: diagnosticOk,
    code: diagnosticOk ? 'ok' : 'diagnostic_failed',
    declaredHooks: declared,
    manifestHooks: manifest,
    registeredHooks: registered,
    registeredTools,
    matchesExpectedHooks: expectedHooks,
    manifestMatchesDeclared,
    registeredMatchesDeclared,
    hookSubset,
    stdout: result.stdout,
    stderr: result.stderr,
    pluginDir
  };
}

function discoverHermesPython(options = {}) {
  const candidates = [];
  if (options.command) candidates.push(options.command);
  const pluginDir = options.pluginDir || hermesPluginDir(options);
  const pluginParent = pluginDir ? path.resolve(pluginDir, '..', '..') : '';
  const profileDir = pluginParent && path.basename(path.dirname(pluginParent)) === 'profiles' ? pluginParent : '';
  const hermesHome = options.hermesHome || (profileDir ? path.resolve(profileDir, '..', '..') : pluginParent);
  for (const base of [profileDir, hermesHome].filter(Boolean)) {
    candidates.push(
      path.join(base, 'venv', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python'),
      path.join(base, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python')
    );
  }
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || '';
}

module.exports = {
  AGENT_LIFECYCLE_ADAPTER_VERSION,
  AGENT_LIFECYCLE_HARNESSES,
  CLAUDE_HOOK_EVENTS,
  CODEX_HOOK_EVENTS,
  HERMES_HOOKS,
  MANAGED_OWNER,
  MANAGED_SIGNATURE,
  MAX_NATIVE_PAYLOAD_BYTES,
  codexHookSupport,
  copyTemplate,
  defaultWriterPath,
  discoverHermesPython,
  doctorAgentLifecycle,
  ensureWriter,
  hermesSupport,
  hermesListShowsEnabled,
  hermesPluginDir,
  installAgentLifecycle,
  installClaudeLifecycle,
  installCodexLifecycle,
  installHermesLifecycle,
  installOpenCodeLifecycle,
  installSupportForHarness,
  mapClaudeLifecycleEvent,
  mapCodexLifecycleEvent,
  mapHermesLifecycleEvent,
  mapOpenCodeLifecycleEvent,
  opencodeSupport,
  probeCommandVersion,
  runDoctorHermesImport,
  runHermesPluginCommand,
  shellQuote,
  supportForHarness,
  testAgentLifecycle,
  uninstallAgentLifecycle,
  uninstallClaudeLifecycle,
  uninstallCodexLifecycle,
  uninstallHermesLifecycle,
  uninstallOpenCodeLifecycle,
  writerCommand
};

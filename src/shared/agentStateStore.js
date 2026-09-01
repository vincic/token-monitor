'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  agentSessionKey,
  expireAgentStates,
  isAgentStateExpired,
  normalizeAgentActivity,
  sha256Hex
} = require('./agentActivity');

const AGENT_STATE_STORE_VERSION = 1;
const MAX_AGENT_STATE_FILES = 512;
const MAX_AGENT_STATE_FILE_BYTES = 16 * 1024;
const DARWIN_SYSTEM_ALIASES = new Map([
  ['/etc', '/private/etc'],
  ['/tmp', '/private/tmp'],
  ['/var', '/private/var']
]);

function defaultAgentStateRoot(options = {}) {
  if (options.root) return options.root;
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const homeDir = options.homeDir || os.homedir?.() || process.cwd();
  if (platform === 'win32') {
    return path.join(env.LOCALAPPDATA || env.APPDATA || path.join(homeDir, 'AppData', 'Local'), 'Token Monitor', 'agent-state');
  }
  return path.join(env.XDG_STATE_HOME || path.join(homeDir, '.local', 'state'), 'token-monitor', 'agent-state');
}

function safeCall(fn, fallback) {
  try { return fn(); } catch (_) { return fallback; }
}

function currentUid(options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, 'uid')) return options.uid;
  if (typeof options.getuid === 'function') return options.getuid();
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function modeBits(stat) {
  return Number(stat?.mode || 0) & 0o777;
}

function fsRealpath(fsApi, targetPath) {
  const native = fsApi.realpathSync?.native;
  if (typeof native === 'function') return native.call(fsApi.realpathSync, targetPath);
  return fsApi.realpathSync(targetPath);
}

function darwinSystemAliasTarget(fsApi, candidate, target, options = {}) {
  if ((options.platform || process.platform) !== 'darwin') return '';
  const expected = DARWIN_SYSTEM_ALIASES.get(candidate);
  if (!expected || candidate === target) return '';
  const stat = safeCall(() => fsApi.lstatSync(candidate), null);
  if (!stat || !stat.isSymbolicLink?.() || stat.uid !== 0) return '';
  const real = safeCall(() => fsRealpath(fsApi, candidate), '');
  return real === expected ? real : '';
}

function canonicalPathForDarwinSystemAliases(fsApi, targetPath, options = {}) {
  let resolved = path.resolve(targetPath);
  if ((options.platform || process.platform) !== 'darwin') return resolved;
  const root = path.parse(resolved).root;
  const parts = resolved.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    const replacement = darwinSystemAliasTarget(fsApi, current, resolved, options);
    if (!replacement) continue;
    resolved = path.join(replacement, path.relative(current, resolved));
    break;
  }
  return resolved;
}

function isPosixPermissionsPlatform(options = {}) {
  return (options.platform || process.platform) !== 'win32';
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

function validateExistingAncestors(fsApi, root, options = {}) {
  const canonicalRoot = canonicalPathForDarwinSystemAliases(fsApi, root, options);
  const paths = existingPathComponents(canonicalRoot);
  for (const candidate of paths) {
    const stat = safeCall(() => fsApi.lstatSync(candidate), null);
    if (!stat) continue;
    if (stat.isSymbolicLink?.()) return false;
    if (candidate === canonicalRoot) return stat.isDirectory?.() === true;
    if (!stat.isDirectory?.()) return false;
  }
  return true;
}

function createRootUnderValidatedAncestors(fsApi, root, options = {}) {
  for (const candidate of existingPathComponents(canonicalPathForDarwinSystemAliases(fsApi, root, options))) {
    const existing = safeCall(() => fsApi.lstatSync(candidate), null);
    if (existing) {
      if (existing.isSymbolicLink?.() || !existing.isDirectory?.()) return false;
      continue;
    }
    safeCall(() => fsApi.mkdirSync(candidate, { mode: 0o700 }), null);
    const created = safeCall(() => fsApi.lstatSync(candidate), null);
    if (!created || created.isSymbolicLink?.() || !created.isDirectory?.()) return false;
  }
  return true;
}

function rootIsSafe(fsApi, root, options = {}) {
  const canonicalRoot = canonicalPathForDarwinSystemAliases(fsApi, root, options);
  if (!validateExistingAncestors(fsApi, canonicalRoot, options)) return false;
  const stat = safeCall(() => fsApi.lstatSync(canonicalRoot), null);
  if (!stat) return true;
  if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
  if (!isPosixPermissionsPlatform(options)) return true;
  const uid = currentUid(options);
  if (uid !== null && uid !== undefined && stat.uid !== uid) return false;
  return (modeBits(stat) & 0o077) === 0;
}

function ensureRoot(fsApi, root, options = {}) {
  const canonicalRoot = canonicalPathForDarwinSystemAliases(fsApi, root, options);
  if (!validateExistingAncestors(fsApi, canonicalRoot, options)) return false;
  if (!createRootUnderValidatedAncestors(fsApi, canonicalRoot, options)) return false;
  const stat = safeCall(() => fsApi.lstatSync(canonicalRoot), null);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) return false;
  if (isPosixPermissionsPlatform(options)) {
    const uid = currentUid(options);
    if (uid !== null && uid !== undefined && stat.uid !== uid) return false;
    if ((modeBits(stat) & 0o077) !== 0) return false;
  }
  return rootIsSafe(fsApi, canonicalRoot, options);
}

function filenameForAgentSession(harness, profile, sessionIdOrKey) {
  const key = String(sessionIdOrKey || '').startsWith('sha256:')
    ? String(sessionIdOrKey)
    : agentSessionKey(harness, profile, sessionIdOrKey);
  if (!key) return '';
  return `${sha256Hex(`${harness}\0${profile}\0${key}`)}.json`;
}

function ownedJsonFilePath(root, name) {
  if (!/^[a-f0-9]{64}\.json$/.test(String(name || ''))) return '';
  return path.join(root, name);
}

function temporarySnapshotPath(root, name) {
  const timeNs = typeof process.hrtime?.bigint === 'function' ? process.hrtime.bigint().toString() : `${Date.now()}000000`;
  return path.join(root, `.${name}.${process.pid}.${timeNs}.${crypto.randomBytes(16).toString('hex')}.tmp`);
}

function cleanupLegacySnapshotTemps(fsApi, root, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const legacy = new RegExp(`^\\.${escaped}\\.${process.pid}(?:\\.\\d+)?\\.tmp$`);
  const entries = safeCall(() => fsApi.readdirSync(root, { withFileTypes: true }), []);
  for (const entry of entries) {
    if (!entry.isFile() || !legacy.test(entry.name)) continue;
    safeCall(() => fsApi.rmSync(path.join(root, entry.name), { force: true }), null);
  }
}

function normalizeStoreDocument(value, options = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.storeVersion !== AGENT_STATE_STORE_VERSION) return null;
  const state = normalizeAgentActivity(value.state, { ...options, allowRawSessionId: true });
  return state ? { storeVersion: AGENT_STATE_STORE_VERSION, state } : null;
}

function readStoreFile(fsApi, filePath, options = {}) {
  const stat = safeCall(() => fsApi.lstatSync(filePath), null);
  if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_AGENT_STATE_FILE_BYTES) return null;
  const content = safeCall(() => fsApi.readFileSync(filePath, 'utf8'), '');
  if (!content || Buffer.byteLength(content, 'utf8') > MAX_AGENT_STATE_FILE_BYTES) return null;
  const parsed = safeCall(() => JSON.parse(content), null);
  const document = normalizeStoreDocument(parsed, options);
  if (!document) return null;
  if (isAgentStateExpired(document.state, options)) return { expired: true };
  return document;
}

function createAgentStateStore(options = {}) {
  const fsApi = options.fs || fs;
  const root = defaultAgentStateRoot(options);
  const storageRoot = canonicalPathForDarwinSystemAliases(fsApi, root, options);
  const platform = options.platform || process.platform;

  function writeSnapshot(state) {
    const normalized = normalizeAgentActivity(state, { ...options, allowRawSessionId: true });
    if (!normalized) return { ok: false, error: 'invalid_record' };
    if (!ensureRoot(fsApi, storageRoot, options)) return { ok: false, error: 'unsafe_root' };
    const fileName = filenameForAgentSession(normalized.harness, normalized.profile, normalized.sessionId);
    const filePath = ownedJsonFilePath(storageRoot, fileName);
    if (!filePath) return { ok: false, error: 'invalid_identity' };
    const existing = safeCall(() => fsApi.lstatSync(filePath), null);
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) return { ok: false, error: 'unsafe_file' };
    const temporary = temporarySnapshotPath(storageRoot, fileName);
    const body = `${JSON.stringify({ storeVersion: AGENT_STATE_STORE_VERSION, state: normalized })}\n`;
    try {
      fsApi.writeFileSync(temporary, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      if (platform !== 'win32') safeCall(() => fsApi.chmodSync(temporary, 0o600), null);
      fsApi.renameSync(temporary, filePath);
      cleanupLegacySnapshotTemps(fsApi, storageRoot, fileName);
      return { ok: true, filePath, state: normalized };
    } catch (error) {
      safeCall(() => fsApi.rmSync(temporary, { force: true }), null);
      return { ok: false, error: error.code || 'write_failed', message: error.message };
    } finally {
      safeCall(() => fsApi.rmSync(temporary, { force: true }), null);
    }
  }

  function readAll(readOptions = {}) {
    if (!rootIsSafe(fsApi, storageRoot, options)) return [];
    const entries = safeCall(() => fsApi.readdirSync(storageRoot, { withFileTypes: true }), []);
    const states = [];
    let scanned = 0;
    for (const entry of entries) {
      if (scanned >= (readOptions.maxFiles ?? MAX_AGENT_STATE_FILES)) break;
      scanned += 1;
      if (!entry.isFile()) continue;
      const filePath = ownedJsonFilePath(storageRoot, entry.name);
      if (!filePath) continue;
      const document = readStoreFile(fsApi, filePath, { ...options, ...readOptions });
      if (!document) continue;
      if (document.expired) {
        safeCall(() => fsApi.rmSync(filePath, { force: true }), null);
        continue;
      }
      states.push(document.state);
    }
    return expireAgentStates(states, { ...options, ...readOptions });
  }

  function remove(identity) {
    const harness = identity?.harness;
    const profile = identity?.profile;
    const session = identity?.sessionKey || identity?.sessionId;
    const fileName = filenameForAgentSession(harness, profile, session);
    const filePath = ownedJsonFilePath(storageRoot, fileName);
    if (!filePath) return { ok: false, error: 'invalid_identity' };
    const stat = safeCall(() => fsApi.lstatSync(filePath), null);
    if (stat && stat.isFile() && !stat.isSymbolicLink()) safeCall(() => fsApi.rmSync(filePath, { force: true }), null);
    return { ok: true };
  }

  function clear() {
    if (!rootIsSafe(fsApi, storageRoot, options)) return { ok: false, error: 'unsafe_root' };
    const entries = safeCall(() => fsApi.readdirSync(storageRoot, { withFileTypes: true }), []);
    for (const entry of entries.slice(0, MAX_AGENT_STATE_FILES)) {
      const filePath = ownedJsonFilePath(storageRoot, entry.name);
      if (!filePath || !entry.isFile()) continue;
      const stat = safeCall(() => fsApi.lstatSync(filePath), null);
      if (stat?.isFile() && !stat.isSymbolicLink()) safeCall(() => fsApi.rmSync(filePath, { force: true }), null);
    }
    return { ok: true };
  }

  function record(state) {
    return writeSnapshot(state);
  }

  function prepare() {
    if (ensureRoot(fsApi, storageRoot, options)) return { ok: true, root, failOpen: false };
    return { ok: false, error: 'unsafe_root', root, failOpen: true };
  }

  return {
    clear,
    prepare,
    read: readAll,
    record,
    remove,
    root
  };
}

module.exports = {
  AGENT_STATE_STORE_VERSION,
  MAX_AGENT_STATE_FILE_BYTES,
  MAX_AGENT_STATE_FILES,
  createAgentStateStore,
  defaultAgentStateRoot,
  filenameForAgentSession
};

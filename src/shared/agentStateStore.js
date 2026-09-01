'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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

function validateExistingAncestors(fsApi, root) {
  const paths = existingPathComponents(root);
  for (const candidate of paths) {
    const stat = safeCall(() => fsApi.lstatSync(candidate), null);
    if (!stat) continue;
    if (stat.isSymbolicLink?.()) return false;
    if (candidate === path.resolve(root)) return stat.isDirectory?.() === true;
    if (!stat.isDirectory?.()) return false;
  }
  return true;
}

function rootIsSafe(fsApi, root, options = {}) {
  if (!validateExistingAncestors(fsApi, root)) return false;
  const stat = safeCall(() => fsApi.lstatSync(root), null);
  if (!stat) return true;
  if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
  if (!isPosixPermissionsPlatform(options)) return true;
  const uid = currentUid(options);
  if (uid !== null && uid !== undefined && stat.uid !== uid) return false;
  return (modeBits(stat) & 0o077) === 0;
}

function ensureRoot(fsApi, root, options = {}) {
  if (!validateExistingAncestors(fsApi, root)) return false;
  safeCall(() => fsApi.mkdirSync(root, { recursive: true, mode: 0o700 }), null);
  const stat = safeCall(() => fsApi.lstatSync(root), null);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) return false;
  if (isPosixPermissionsPlatform(options)) {
    const uid = currentUid(options);
    if (uid !== null && uid !== undefined && stat.uid !== uid) return false;
    if ((modeBits(stat) & 0o077) !== 0) {
      safeCall(() => fsApi.chmodSync(root, 0o700), null);
    }
  }
  return rootIsSafe(fsApi, root, options);
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
  const platform = options.platform || process.platform;

  function writeSnapshot(state) {
    const normalized = normalizeAgentActivity(state, { ...options, allowRawSessionId: true });
    if (!normalized) return { ok: false, error: 'invalid_record' };
    if (!ensureRoot(fsApi, root, options)) return { ok: false, error: 'unsafe_root' };
    const fileName = filenameForAgentSession(normalized.harness, normalized.profile, normalized.sessionId);
    const filePath = ownedJsonFilePath(root, fileName);
    if (!filePath) return { ok: false, error: 'invalid_identity' };
    const existing = safeCall(() => fsApi.lstatSync(filePath), null);
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) return { ok: false, error: 'unsafe_file' };
    const temporary = path.join(root, `.${fileName}.${process.pid}.${Date.now()}.tmp`);
    const body = `${JSON.stringify({ storeVersion: AGENT_STATE_STORE_VERSION, state: normalized })}\n`;
    try {
      fsApi.writeFileSync(temporary, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      if (platform !== 'win32') safeCall(() => fsApi.chmodSync(temporary, 0o600), null);
      fsApi.renameSync(temporary, filePath);
      return { ok: true, filePath, state: normalized };
    } catch (error) {
      safeCall(() => fsApi.rmSync(temporary, { force: true }), null);
      return { ok: false, error: error.code || 'write_failed', message: error.message };
    }
  }

  function readAll(readOptions = {}) {
    if (!rootIsSafe(fsApi, root, options)) return [];
    const entries = safeCall(() => fsApi.readdirSync(root, { withFileTypes: true }), []);
    const states = [];
    let scanned = 0;
    for (const entry of entries) {
      if (scanned >= (readOptions.maxFiles ?? MAX_AGENT_STATE_FILES)) break;
      scanned += 1;
      if (!entry.isFile()) continue;
      const filePath = ownedJsonFilePath(root, entry.name);
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
    const filePath = ownedJsonFilePath(root, fileName);
    if (!filePath) return { ok: false, error: 'invalid_identity' };
    const stat = safeCall(() => fsApi.lstatSync(filePath), null);
    if (stat && stat.isFile() && !stat.isSymbolicLink()) safeCall(() => fsApi.rmSync(filePath, { force: true }), null);
    return { ok: true };
  }

  function clear() {
    if (!rootIsSafe(fsApi, root, options)) return { ok: false, error: 'unsafe_root' };
    const entries = safeCall(() => fsApi.readdirSync(root, { withFileTypes: true }), []);
    for (const entry of entries.slice(0, MAX_AGENT_STATE_FILES)) {
      const filePath = ownedJsonFilePath(root, entry.name);
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
    if (ensureRoot(fsApi, root, options)) return { ok: true, root, failOpen: false };
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

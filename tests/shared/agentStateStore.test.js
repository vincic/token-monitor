'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { agentSessionKey } = require('../../src/shared/agentActivity');
const {
  MAX_AGENT_STATE_FILE_BYTES,
  createAgentStateStore,
  defaultAgentStateRoot,
  filenameForAgentSession
} = require('../../src/shared/agentStateStore');

const NOW = Date.parse('2026-08-31T12:00:00.000Z');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tm-agent-state-'));
}

function state(extra = {}) {
  return {
    schemaVersion: 1,
    harness: 'codex',
    profile: 'work',
    sessionId: 'session-a',
    event: 'turn_started',
    observedAt: '2026-08-31T11:59:45.000Z',
    fidelity: 'exact',
    ...extra
  };
}

function fakeStat({ type = 'dir', mode = 0o700, uid = 1000, size = 0 } = {}) {
  return {
    mode,
    uid,
    size,
    isDirectory: () => type === 'dir',
    isFile: () => type === 'file',
    isSymbolicLink: () => type === 'symlink'
  };
}

function fakeFsForRoot(root, {
  rootMode = 0o700,
  rootUid = 1000,
  rootType = 'dir',
  symlinkAncestor = '',
  ancestorMode = 0o700,
  ancestorUid = 1000
} = {}) {
  const resolvedRoot = path.resolve(root);
  const stats = new Map();
  const parsed = path.parse(resolvedRoot);
  let current = parsed.root;
  stats.set(current, fakeStat({ mode: ancestorMode, uid: ancestorUid }));
  const parts = resolvedRoot.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    stats.set(current, fakeStat({ type: current === symlinkAncestor ? 'symlink' : 'dir', mode: ancestorMode, uid: ancestorUid }));
  }
  if (rootType !== 'missing') stats.set(resolvedRoot, fakeStat({ type: rootType, mode: rootMode, uid: rootUid }));
  const files = new Map();
  return {
    chmods: [],
    lstatSync(filePath) {
      const resolved = path.resolve(filePath);
      if (stats.has(resolved)) return stats.get(resolved);
      if (files.has(resolved)) return fakeStat({ type: 'file', mode: 0o600, uid: rootUid, size: Buffer.byteLength(files.get(resolved), 'utf8') });
      const error = new Error('not found');
      error.code = 'ENOENT';
      throw error;
    },
    mkdirSync(dirPath) {
      const resolved = path.resolve(dirPath);
      if (!stats.has(resolved)) stats.set(resolved, fakeStat({ mode: 0o700, uid: rootUid }));
    },
    chmodSync(filePath, mode) {
      const resolved = path.resolve(filePath);
      this.chmods.push({ path: resolved, mode });
      if (stats.has(resolved)) stats.set(resolved, fakeStat({ mode, uid: rootUid }));
    },
    writeFileSync(filePath, body) { files.set(path.resolve(filePath), String(body)); },
    renameSync(from, to) {
      files.set(path.resolve(to), files.get(path.resolve(from)));
      files.delete(path.resolve(from));
    },
    rmSync(filePath) { files.delete(path.resolve(filePath)); },
    readdirSync() { return []; },
    readFileSync(filePath) { return files.get(path.resolve(filePath)); }
  };
}

test('default root follows XDG state and has a Windows-safe fallback', () => {
  assert.equal(
    defaultAgentStateRoot({ env: { XDG_STATE_HOME: '/tmp/state' }, homeDir: '/home/alice', platform: 'linux' }),
    path.join('/tmp/state', 'token-monitor', 'agent-state')
  );
  assert.equal(
    defaultAgentStateRoot({ env: {}, homeDir: '/home/alice', platform: 'linux' }),
    path.join('/home/alice', '.local', 'state', 'token-monitor', 'agent-state')
  );
  assert.equal(
    defaultAgentStateRoot({ env: { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, homeDir: 'C:\\Users\\a', platform: 'win32' }),
    path.join('C:\\Users\\a\\AppData\\Local', 'Token Monitor', 'agent-state')
  );
});

test('record writes an atomic hashed snapshot with restrictive permissions', () => {
  const root = tempRoot();
  const store = createAgentStateStore({ root, nowMs: NOW });
  const result = store.record(state({ prompt: 'private' }));

  assert.equal(result.ok, true);
  assert.match(path.basename(result.filePath), /^[a-f0-9]{64}\.json$/);
  const files = fs.readdirSync(root);
  assert.equal(files.length, 1);
  assert.doesNotMatch(JSON.stringify(JSON.parse(fs.readFileSync(result.filePath, 'utf8'))), /private|session-a/);
  if (process.platform !== 'win32') assert.equal((fs.statSync(result.filePath).mode & 0o777), 0o600);

  const read = store.read({ nowMs: NOW });
  assert.equal(read.length, 1);
  assert.equal(read[0].sessionId, agentSessionKey('codex', 'work', 'session-a'));
});

test('store filenames hash the full raw session id before capping', () => {
  const prefix = 'x'.repeat(128);
  const first = filenameForAgentSession('codex', 'work', `${prefix}a`);
  const second = filenameForAgentSession('codex', 'work', `${prefix}b`);

  assert.match(first, /^[a-f0-9]{64}\.json$/);
  assert.match(second, /^[a-f0-9]{64}\.json$/);
  assert.notEqual(first, second);
});

test('ordinary write failures return a safe result instead of throwing', () => {
  const root = tempRoot();
  const store = createAgentStateStore({
    root,
    nowMs: NOW,
    fs: {
      ...fs,
      writeFileSync() { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); }
    }
  });

  assert.deepEqual(store.record(state()), { ok: false, error: 'ENOSPC', message: 'disk full' });
});

test('prepare creates and verifies the owner-only root without writing a record', () => {
  const base = tempRoot();
  const root = path.join(base, 'missing', 'agent-state');
  const store = createAgentStateStore({ root, nowMs: NOW });

  assert.deepEqual(store.prepare(), { ok: true, root, failOpen: false });
  assert.equal(fs.statSync(root).isDirectory(), true);
  if (process.platform !== 'win32') assert.equal((fs.statSync(root).mode & 0o777), 0o700);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('prepare reports fail-open status for unsafe roots', { skip: process.platform === 'win32' }, () => {
  const real = tempRoot();
  const root = path.join(os.tmpdir(), `tm-agent-state-prepare-link-${process.pid}-${Math.random().toString(16).slice(2)}`);
  fs.symlinkSync(real, root, 'dir');
  const store = createAgentStateStore({ root, nowMs: NOW });

  assert.deepEqual(store.prepare(), { ok: false, error: 'unsafe_root', root, failOpen: true });
  assert.deepEqual(store.read({ nowMs: NOW }), []);
});

test('read ignores malformed, unknown-version, oversized, and non-regular files', () => {
  const root = tempRoot();
  const store = createAgentStateStore({ root, nowMs: NOW });
  store.record(state({ sessionId: 'good' }));
  fs.writeFileSync(path.join(root, '0'.repeat(64) + '.json'), '{bad json');
  fs.writeFileSync(path.join(root, '1'.repeat(64) + '.json'), JSON.stringify({ storeVersion: 2, state: state() }));
  fs.writeFileSync(path.join(root, '2'.repeat(64) + '.json'), 'x'.repeat(MAX_AGENT_STATE_FILE_BYTES + 1));
  fs.mkdirSync(path.join(root, '3'.repeat(64) + '.json'));
  fs.writeFileSync(path.join(root, 'not-owned.txt'), JSON.stringify({ storeVersion: 1, state: state({ sessionId: 'bad' }) }));

  const read = store.read({ nowMs: NOW });
  assert.equal(read.length, 1);
  assert.equal(read[0].sessionId, agentSessionKey('codex', 'work', 'good'));
});

test('expired records are dropped and explicit remove/clear touch only owned regular files', () => {
  const root = tempRoot();
  const store = createAgentStateStore({ root, nowMs: NOW });
  const expiredPath = path.join(root, '4'.repeat(64) + '.json');
  fs.writeFileSync(expiredPath, JSON.stringify({
    storeVersion: 1,
    state: {
      schemaVersion: 1,
      harness: 'codex',
      profile: 'work',
      sessionId: agentSessionKey('codex', 'work', 'old'),
      event: 'turn_started',
      mode: 'working',
      observedAt: '2026-08-31T11:58:00.000Z',
      fidelity: 'exact'
    }
  }));
  store.record(state({ sessionId: 'live' }));
  fs.writeFileSync(path.join(root, 'keep.txt'), 'keep');

  assert.equal(store.read({ nowMs: NOW }).length, 1);
  assert.equal(fs.existsSync(expiredPath), false);
  assert.equal(store.remove({ harness: 'codex', profile: 'work', sessionId: 'live' }).ok, true);
  assert.deepEqual(store.read({ nowMs: NOW }), []);
  assert.equal(store.clear().ok, true);
  assert.equal(fs.readFileSync(path.join(root, 'keep.txt'), 'utf8'), 'keep');
});

test('store refuses symlink roots and files', { skip: process.platform === 'win32' }, () => {
  const real = tempRoot();
  const root = path.join(os.tmpdir(), `tm-agent-state-link-${process.pid}-${Math.random().toString(16).slice(2)}`);
  fs.symlinkSync(real, root, 'dir');
  const store = createAgentStateStore({ root, nowMs: NOW });
  assert.deepEqual(store.record(state()), { ok: false, error: 'unsafe_root' });

  const safe = tempRoot();
  const file = path.join(safe, 'a'.repeat(64) + '.json');
  fs.writeFileSync(path.join(safe, 'target.json'), '{}');
  fs.symlinkSync(path.join(safe, 'target.json'), file);
  const safeStore = createAgentStateStore({ root: safe, nowMs: NOW });
  assert.equal(safeStore.read({ nowMs: NOW }).length, 0);
});

test('store accepts macOS-style system-owned permissive ancestors when final root is private', () => {
  const root = path.join(os.tmpdir(), 'tm-agent-state-macos-ancestor', 'agent-state');
  const fsApi = fakeFsForRoot(root, { ancestorMode: 0o755, ancestorUid: 0, rootType: 'missing', rootUid: 501 });
  const store = createAgentStateStore({ root, nowMs: NOW, fs: fsApi, getuid: () => 501, platform: 'darwin' });

  const result = store.record(state());

  assert.equal(result.ok, true);
  assert.equal(fsApi.chmods.some((entry) => entry.path === path.resolve(root)), false);
  assert.equal(fsApi.lstatSync(root).mode & 0o777, 0o700);
  assert.equal(fsApi.lstatSync(root).uid, 501);
});

test('store refuses a permissive existing root without chmodding it', () => {
  const root = path.join(os.tmpdir(), 'tm-agent-state-owned');
  const fsApi = fakeFsForRoot(root, { rootMode: 0o755, rootUid: 1000 });
  const store = createAgentStateStore({ root, nowMs: NOW, fs: fsApi, getuid: () => 1000, platform: 'linux' });

  const result = store.record(state());

  assert.deepEqual(result, { ok: false, error: 'unsafe_root' });
  assert.equal(fsApi.chmods.some((entry) => entry.path === path.resolve(root)), false);
});

test('store refuses a symlinked existing ancestor component', () => {
  const root = path.join(os.tmpdir(), 'tm-agent-state-link-parent', 'agent-state');
  const symlinkAncestor = path.resolve(path.dirname(root));
  const fsApi = fakeFsForRoot(root, { symlinkAncestor });
  const store = createAgentStateStore({ root, nowMs: NOW, fs: fsApi, getuid: () => 1000, platform: 'linux' });

  assert.deepEqual(store.record(state()), { ok: false, error: 'unsafe_root' });
  assert.deepEqual(store.read({ nowMs: NOW }), []);
});

test('store refuses a pre-existing root owned by another uid', () => {
  const root = path.join(os.tmpdir(), 'tm-agent-state-wrong-owner');
  const fsApi = fakeFsForRoot(root, { rootUid: 2000 });
  const store = createAgentStateStore({ root, nowMs: NOW, fs: fsApi, getuid: () => 1000, platform: 'linux' });

  assert.deepEqual(store.record(state()), { ok: false, error: 'unsafe_root' });
  assert.deepEqual(store.clear(), { ok: false, error: 'unsafe_root' });
});

test('Windows-mode store accepts normal roots with non-POSIX mode bits', () => {
  const root = path.join(os.tmpdir(), 'tm-agent-state-win-mode');
  const fsApi = fakeFsForRoot(root, { rootMode: 0o777, rootUid: 2000 });
  const store = createAgentStateStore({ root, nowMs: NOW, fs: fsApi, getuid: () => 1000, platform: 'win32' });

  const result = store.record(state());

  assert.equal(result.ok, true);
  assert.equal(fsApi.chmods.some((entry) => entry.path === path.resolve(root)), false);
  assert.deepEqual(store.clear(), { ok: true });
});

test('Windows-mode store still refuses symlink and non-directory roots', () => {
  for (const rootType of ['symlink', 'file']) {
    const root = path.join(os.tmpdir(), `tm-agent-state-win-${rootType}`);
    const fsApi = fakeFsForRoot(root, { rootType, rootMode: 0o777, rootUid: 2000 });
    const store = createAgentStateStore({ root, nowMs: NOW, fs: fsApi, platform: 'win32' });

    assert.deepEqual(store.record(state()), { ok: false, error: 'unsafe_root' });
    assert.deepEqual(store.read({ nowMs: NOW }), []);
  }
});

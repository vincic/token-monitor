'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const {
  analyzeCodexHooks,
  CLAUDE_HOOK_EVENTS,
  CODEX_HOOK_EVENTS,
  HERMES_HOOKS,
  copyTemplate,
  doctorAgentLifecycle,
  ensureWriter,
  hermesListShowsEnabled,
  hermesPluginDir,
  installClaudeLifecycle,
  installCodexLifecycle,
  installHermesLifecycle,
  installOpenCodeLifecycle,
  mapClaudeLifecycleEvent,
  mapCodexLifecycleEvent,
  mapHermesLifecycleEvent,
  mapOpenCodeLifecycleEvent,
  parseCodexManagedHooks,
  parseCodexManagedTrustEntries,
  parseCodexTrustedHookState,
  runDoctorHermesImport,
  shellQuote,
  uninstallClaudeLifecycle,
  uninstallCodexLifecycle,
  uninstallHermesLifecycle,
  uninstallOpenCodeLifecycle,
  writerCommand
} = require('../../src/shared/agentLifecycleAdapters');
const { createAgentStateStore } = require('../../src/shared/agentStateStore');

const NOW = Date.parse('2026-08-31T12:00:00.000Z');

function tempRoot(name = 'tm-agent-life-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), name));
}

function missingTempStateRoot(name = 'tm-agent-life-state-') {
  return path.join(os.tmpdir(), `${name}${process.pid}-${Math.random().toString(16).slice(2)}`, 'agent-state');
}

function payload(extra = {}) {
  return {
    session_id: 'session-a',
    profile_name: 'work',
    timestamp: '2026-08-31T11:59:45.000Z',
    ...extra
  };
}

function stateSummaries(root) {
  return createAgentStateStore({ root }).read()
    .map((state) => ({
      harness: state.harness,
      profile: state.profile,
      event: state.event,
      toolName: state.toolName || '',
      surface: state.surface || ''
    }))
    .sort((a, b) => `${a.event}:${a.toolName}`.localeCompare(`${b.event}:${b.toolName}`));
}

function makeDirSymlink(t, target, link) {
  try {
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip(`directory symlinks unavailable: ${error.code}`);
      return false;
    }
    throw error;
  }
  return true;
}

function makeFileSymlink(t, target, link) {
  try {
    fs.symlinkSync(target, link, 'file');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip(`file symlinks unavailable: ${error.code}`);
      return false;
    }
    throw error;
  }
  return true;
}

function codexAppServerKey(configPath, hook) {
  return `${configPath}:hooks.${hook.event}[${hook.outerIndex}].hooks[${hook.hookIndex}]`;
}

function codexEscapedAppServerKey(hook) {
  const event = hook.event === 'SessionStart' ? 'session_start' : hook.event;
  return `C:\\Users\\me\\.codex\\config.toml:${event}:1:${hook.hookIndex}`;
}

function runInstalledHermesDiagnostic(t, options = {}) {
  const homeDir = tempRoot();
  const hermesHome = path.join(homeDir, '.hermes');
  const installed = installHermesLifecycle({
    hermesHome,
    profiles: ['default'],
    hermesVersion: '0.20.5',
    commandRunner: () => ({ status: 0, stdout: '', stderr: '' })
  });
  assert.equal(installed.ok, true);
  const pluginDir = path.join(hermesHome, 'plugins', 'token-monitor-agent-state');
  if (options.mutate) options.mutate(pluginDir);
  const env = { ...process.env };
  if (options.validHooks) env.TOKEN_MONITOR_HERMES_VALID_HOOKS = options.validHooks.join(',');
  const run = childProcess.spawnSync('python3', [path.join(pluginDir, 'diagnostics.py')], {
    cwd: pluginDir,
    env,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024
  });
  if (run.error?.code === 'ENOENT') {
    t.skip('python3 unavailable');
    return null;
  }
  return { run, output: JSON.parse(run.stdout) };
}

test('Claude and Codex mapping allowlist event fields', () => {
  const claude = mapClaudeLifecycleEvent('PreToolUse', payload({
    tool_name: 'bash',
    prompt: 'secret',
    path: '/private/path'
  }), { nowMs: NOW });
  assert.equal(claude.harness, 'claude');
  assert.equal(claude.event, 'tool_started');
  assert.equal(claude.toolName, 'bash');
  assert.equal(Object.hasOwn(claude, 'prompt'), false);
  assert.equal(Object.hasOwn(claude, 'path'), false);

  const codex = mapCodexLifecycleEvent('PostToolUse', payload({ success: false }), { nowMs: NOW });
  assert.equal(codex.harness, 'codex');
  assert.equal(codex.event, 'error');
  assert.equal(mapCodexLifecycleEvent('PreCompact', payload(), { nowMs: NOW }).event, 'heartbeat');
  assert.equal(mapCodexLifecycleEvent('SubagentStart', payload(), { nowMs: NOW }).event, 'session_resumed');
});

test('mapping rejects malformed and oversized identity', () => {
  assert.equal(mapClaudeLifecycleEvent('SessionStart', { profile_name: 'work' }, { nowMs: NOW }), null);
  assert.equal(mapCodexLifecycleEvent('SessionStart', payload({ session_id: 's'.repeat(4097) }), { nowMs: NOW }), null);
  assert.equal(mapOpenCodeLifecycleEvent('session.created', {}, { nowMs: NOW }), null);
  assert.equal(mapHermesLifecycleEvent('on_session_start', { session_id: 'x' }, { nowMs: NOW }), null);
});

test('OpenCode maps generic and dedicated tool hooks with safe surface enrichment', () => {
  assert.equal(mapOpenCodeLifecycleEvent('session.created', payload(), { nowMs: NOW }).event, 'session_started');
  assert.equal(mapOpenCodeLifecycleEvent('permission.asked', payload(), { nowMs: NOW }).event, 'approval_requested');
  const before = mapOpenCodeLifecycleEvent('tool.execute.before', payload({ tool: { name: 'edit', args: { secret: true } } }), { nowMs: NOW, env: {} });
  assert.equal(before.event, 'tool_started');
  assert.equal(before.toolName, 'edit');
  assert.equal(before.surface, 'opencode');
  assert.equal(Object.hasOwn(before, 'args'), false);
  assert.equal(mapOpenCodeLifecycleEvent('tool.execute.after', payload({ failed: true }), { nowMs: NOW }).event, 'error');
  assert.equal(mapOpenCodeLifecycleEvent('session.status', payload({ status: 'idle' }), { nowMs: NOW }).event, 'turn_completed');
  assert.equal(mapOpenCodeLifecycleEvent('session.status', payload({ status: 'busy' }), { nowMs: NOW }).event, 'heartbeat');
  assert.equal(mapOpenCodeLifecycleEvent('session.created', payload(), { nowMs: NOW, env: { HERDR: '1' } }).surface, 'herdr');
});

test('Hermes mapping uses profile identity and fleet-common hooks only', () => {
  assert.deepEqual(HERMES_HOOKS.includes('on_session_activate'), false);
  const started = mapHermesLifecycleEvent('pre_llm_call', payload(), { nowMs: NOW });
  assert.equal(started.harness, 'hermes');
  assert.equal(started.profile, 'work');
  assert.equal(started.event, 'turn_started');
  assert.equal(mapHermesLifecycleEvent('post_approval_response', payload({ approved: false }), { nowMs: NOW }).event, 'error');
});

test('shared writer template runs as a subprocess with no stdout and writes a state file', () => {
  const root = tempRoot();
  const script = path.join(process.cwd(), 'integrations', 'agent-lifecycle', 'agent-event.js');
  const native = JSON.stringify({ sessionID: 'native-session-id', profile_name: 'work', tool_name: 'shell', prompt: 'secret', timestamp: new Date().toISOString() });
  const run = childProcess.spawnSync(process.execPath, [script, '--harness', 'codex', '--native-event', 'PreToolUse', '--state-root', root, '--payload-json', native], {
    encoding: 'utf8'
  });
  assert.equal(run.status, 0);
  assert.equal(run.stdout, '');
  const states = createAgentStateStore({ root }).read();
  assert.equal(states.length, 1);
  assert.equal(states[0].event, 'tool_started');
  assert.equal(states[0].toolName, 'shell');
  assert.equal(Object.hasOwn(states[0], 'prompt'), false);
  assert.match(states[0].sessionId, /^sha256:[a-f0-9]{64}$/);
});

test('generated Claude shell command preserves literal argv under /bin/sh', () => {
  if (process.platform === 'win32') return;
  const root = tempRoot("tm agent-life shell ' $(touch ");
  const sideEffect = path.join(root, 'side-effect');
  const argvPath = path.join(root, 'argv.json');
  const writerPath = path.join(root, "writer space ' $(touch ignored) `touch ignored2`; .js");
  fs.writeFileSync(writerPath, `
const fs = require('node:fs');
fs.writeFileSync(process.env.ARGV_OUT, JSON.stringify(process.argv.slice(2)));
`);
  const special = `spaces apostrophe' dollar$(touch ${sideEffect}) backtick\`touch ${sideEffect}\` semi;touch ${sideEffect}`;
  const command = writerCommand('claude', 'PreToolUse', {
    nodePath: process.execPath,
    writerPath,
    stateRoot: special,
    profile: special
  });
  const run = childProcess.spawnSync('/bin/sh', ['-c', command], {
    encoding: 'utf8',
    env: { ...process.env, ARGV_OUT: argvPath }
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(fs.existsSync(sideEffect), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(argvPath, 'utf8')), [
    '--harness',
    'claude',
    '--native-event',
    'PreToolUse',
    '--state-root',
    special,
    '--profile',
    special
  ]);
});

test('shell quoting rejects NUL and newlines and keeps Windows metacharacters quoted', () => {
  assert.throws(() => shellQuote('bad\narg'));
  assert.throws(() => shellQuote('bad\0arg'));
  assert.match(shellQuote('a&b %PATH% !x!', { platform: 'win32' }), /^".*"$/);
  assert.match(writerCommand('codex', 'SessionStart', { platform: 'win32', nodePath: 'C:\\Program Files\\nodejs\\node.exe', writerPath: 'C:\\Users\\Me\\agent event.js' }), /^"C:\\Program Files\\nodejs\\node\.exe"/);
});

test('shared writer fails open for hostile payloads and malformed input', () => {
  const script = path.join(process.cwd(), 'integrations', 'agent-lifecycle', 'agent-event.js');
  for (const input of ['{bad', JSON.stringify(payload({ session_id: 's'.repeat(4097) }))]) {
    const root = tempRoot();
    const run = childProcess.spawnSync(process.execPath, [script, '--harness', 'codex', '--native-event', 'SessionStart', '--state-root', root, '--payload-json', input], {
      encoding: 'utf8',
      maxBuffer: 1024 * 64
    });
    assert.equal(run.status, 0);
    assert.equal(run.stdout, '');
    assert.deepEqual(fs.existsSync(root) ? fs.readdirSync(root) : [], []);
  }
});

test('shared writer rejects CLI state roots below symlinked ancestors without touching the target', (t) => {
  const homeDir = tempRoot();
  const target = path.join(homeDir, 'target');
  const link = path.join(homeDir, 'link');
  fs.mkdirSync(target);
  if (!makeDirSymlink(t, target, link)) return;
  const root = path.join(link, 'nested');
  const script = path.join(process.cwd(), 'integrations', 'agent-lifecycle', 'agent-event.js');
  const native = JSON.stringify({ sessionID: 'native-session-id', profile_name: 'work' });

  const run = childProcess.spawnSync(process.execPath, [script, '--harness', 'claude', '--native-event', 'SessionStart', '--state-root', root, '--payload-json', native], {
    encoding: 'utf8',
    maxBuffer: 1024 * 64
  });

  assert.equal(run.status, 0);
  assert.equal(run.stdout, '');
  assert.deepEqual(fs.readdirSync(target), []);
  assert.equal(fs.existsSync(path.join(target, 'nested')), false);
});

test('shared writer rejects env state roots below symlinked ancestors without touching the target', (t) => {
  const homeDir = tempRoot();
  const target = path.join(homeDir, 'target');
  const link = path.join(homeDir, 'link');
  fs.mkdirSync(target);
  if (!makeDirSymlink(t, target, link)) return;
  const root = path.join(link, 'nested');
  const script = path.join(process.cwd(), 'integrations', 'agent-lifecycle', 'agent-event.js');
  const native = JSON.stringify({ sessionID: 'native-session-id', profile_name: 'work' });

  const run = childProcess.spawnSync(process.execPath, [script, '--harness', 'codex', '--native-event', 'SessionStart', '--payload-json', native], {
    encoding: 'utf8',
    env: { ...process.env, TOKEN_MONITOR_AGENT_STATE_ROOT: root },
    maxBuffer: 1024 * 64
  });

  assert.equal(run.status, 0);
  assert.equal(run.stdout, '');
  assert.deepEqual(fs.readdirSync(target), []);
  assert.equal(fs.existsSync(path.join(target, 'nested')), false);
});

test('shared writer rejects unsafe root types and modes without chmodding targets', (t) => {
  const homeDir = tempRoot();
  const script = path.join(process.cwd(), 'integrations', 'agent-lifecycle', 'agent-event.js');
  const native = JSON.stringify({ sessionID: 'native-session-id', profile_name: 'work' });
  const symlinkTarget = path.join(homeDir, 'symlink-target');
  const symlinkRoot = path.join(homeDir, 'symlink-root');
  const fileRoot = path.join(homeDir, 'file-root');
  fs.mkdirSync(symlinkTarget, { mode: 0o755 });
  fs.writeFileSync(fileRoot, 'not a directory');
  if (!makeDirSymlink(t, symlinkTarget, symlinkRoot)) return;
  const roots = [symlinkRoot, fileRoot];
  if (process.platform !== 'win32') {
    const permissiveRoot = path.join(homeDir, 'permissive-root');
    fs.mkdirSync(permissiveRoot, { mode: 0o755 });
    fs.chmodSync(permissiveRoot, 0o755);
    roots.push(permissiveRoot);
  }

  for (const root of roots) {
    const run = childProcess.spawnSync(process.execPath, [script, '--harness', 'claude', '--native-event', 'SessionStart', '--state-root', root, '--payload-json', native], {
      encoding: 'utf8',
      maxBuffer: 1024 * 64
    });
    assert.equal(run.status, 0);
    assert.equal(run.stdout, '');
  }
  assert.deepEqual(fs.readdirSync(symlinkTarget), []);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(symlinkTarget).mode & 0o777, 0o755);
    assert.equal(fs.statSync(path.join(homeDir, 'permissive-root')).mode & 0o777, 0o755);
  }
});

test('shared writer creates private final roots below permissive system ancestors', () => {
  const root = missingTempStateRoot();
  const script = path.join(process.cwd(), 'integrations', 'agent-lifecycle', 'agent-event.js');
  const native = JSON.stringify({ sessionID: 'native-session-id', profile_name: 'work' });

  const run = childProcess.spawnSync(process.execPath, [script, '--harness', 'codex', '--native-event', 'SessionStart', '--state-root', root, '--payload-json', native], {
    encoding: 'utf8',
    maxBuffer: 1024 * 64
  });

  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, '');
  assert.equal(stateSummaries(root).length, 1);
  if (process.platform !== 'win32') assert.equal(fs.statSync(root).mode & 0o777, 0o700);
});

test('Claude install preserves existing hooks, backs up, is idempotent, and uninstalls only managed entries', () => {
  const homeDir = tempRoot();
  const settingsPath = path.join(homeDir, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: 'sidepulse' }] }] }, keep: true }));

  assert.equal(installClaudeLifecycle({ homeDir, stateRoot: path.join(homeDir, 'state'), nowMs: NOW }).ok, true);
  const installed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(installed.keep, true);
  assert.equal(installed.hooks.SessionStart.length, 2);
  assert.ok(installed.hooks.SessionStart.some((entry) => JSON.stringify(entry).includes('sidepulse')));
  assert.ok(fs.readdirSync(path.dirname(settingsPath)).some((name) => name.includes('.bak.')));

  installClaudeLifecycle({ homeDir, stateRoot: path.join(homeDir, 'state'), nowMs: NOW });
  const afterSecond = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(afterSecond.hooks.SessionStart.filter((entry) => JSON.stringify(entry).includes('token-monitor-agent-lifecycle:v1')).length, 1);

  assert.equal(uninstallClaudeLifecycle({ homeDir, nowMs: NOW }).changed, true);
  const uninstalled = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.deepEqual(uninstalled.hooks.SessionStart, [{ hooks: [{ command: 'sidepulse' }] }]);

  fs.writeFileSync(settingsPath, '{bad json');
  assert.equal(installClaudeLifecycle({ homeDir }).code, 'invalid_json');
});

test('Claude doctor requires a complete current managed hook set', () => {
  const homeDir = tempRoot();
  const stateRoot = path.join(homeDir, 'state');
  const writerPath = path.join(homeDir, 'writer.js');
  assert.equal(installClaudeLifecycle({ homeDir, stateRoot, writerPath, nowMs: NOW }).ok, true);

  const complete = doctorAgentLifecycle({ harnesses: ['claude'], homeDir, stateRoot, writerPath });
  assert.equal(complete.ok, true);
  assert.equal(complete.results[0].capability, 'exact');
  assert.deepEqual(complete.results[0].configuredEvents, CLAUDE_HOOK_EVENTS);
  assert.deepEqual(complete.results[0].missingEvents, []);
  assert.deepEqual(complete.results[0].partialEvents, []);

  const settingsPath = path.join(homeDir, '.claude', 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  settings.hooks.PreToolUse = [{
    matcher: '*',
    hooks: [{
      type: 'command',
      command: 'node /tmp/stale-agent-event.js -- token-monitor-agent-lifecycle:v1',
      tokenMonitorManaged: 'token-monitor-agent-lifecycle:v1',
      tokenMonitorOwner: 'Token Monitor agent lifecycle',
      tokenMonitorEvent: 'PreToolUse'
    }]
  }];
  delete settings.hooks.Stop;
  settings.hooks.SessionEnd.push({ matcher: '*', hooks: [{ type: 'command', command: 'unrelated' }] });
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);

  const partial = doctorAgentLifecycle({ harnesses: ['claude'], homeDir, stateRoot, writerPath });
  assert.equal(partial.ok, false);
  assert.equal(partial.results[0].capability, 'presence_only');
  assert.deepEqual(partial.results[0].missingEvents, ['Stop']);
  assert.deepEqual(partial.results[0].partialEvents, ['PreToolUse']);
  assert.deepEqual(partial.results[0].wrongCommandEvents, ['PreToolUse']);
  assert.equal(partial.results[0].installed, false);
});

test('Claude doctor reports not_configured when no managed hook or writer is present', () => {
  const homeDir = tempRoot();
  const settingsPath = path.join(homeDir, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: 'sidepulse' }] }] } }));

  const result = doctorAgentLifecycle({ harnesses: ['claude'], homeDir, stateRoot: path.join(homeDir, 'state'), writerPath: path.join(homeDir, 'missing-writer.js') });

  assert.equal(result.ok, false);
  assert.equal(result.results[0].capability, 'not_configured');
  assert.equal(result.results[0].installed, false);
});

test('Codex install writes native nested hooks, preserves unrelated state, and trusts only Token Monitor commands', () => {
  const homeDir = tempRoot();
  const configPath = path.join(homeDir, '.codex', 'config.toml');
  const writerPath = path.join(homeDir, 'agent event.js');
  const stateRoot = path.join(homeDir, 'state');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, [
    'model = "gpt-5"',
    '',
    '[[hooks.SessionStart]]',
    'matcher = "*"',
    '[[hooks.SessionStart.hooks]]',
    'type = "command"',
    'command = "sidepulse"',
    '',
    '[features]',
    'experimental = true',
    'hooks = false',
    '',
    '[hooks.state."sidepulse.SessionStart.0.0"]',
    'trusted_hash = "sidepulse-hash"',
    '',
    '[hooks.state."SessionStart.0.0"]',
    'trusted_hash = "unrelated-index-hash"',
    ''
  ].join('\n'));

  const commandRunner = (command, args, runOptions) => {
    assert.equal(command, 'codex');
    assert.deepEqual(args, ['app-server', '--stdio']);
    assert.doesNotMatch(runOptions.input, /dangerously-bypass-hook-trust/);
    const requests = runOptions.input.trim().split(/\n/).map((line) => JSON.parse(line));
    assert.deepEqual(requests.map((request) => ({ id: request.id, method: request.method })), [
      { id: 1, method: 'initialize' },
      { id: undefined, method: 'initialized' },
      { id: 2, method: 'hooks/list' }
    ]);
    assert.equal(requests[0].params.clientInfo.name, 'SidePulse Token Monitor');
    assert.equal(requests[0].params.clientInfo.version, '2.0.0');
    assert.equal(requests[0].params.capabilities, null);
    assert.deepEqual(requests[1].params, {});
    assert.ok(requests[2].params.cwds.includes(process.cwd()));
    assert.ok(requests[2].params.cwds.includes(path.dirname(configPath)));
    const managed = parseCodexManagedHooks(fs.readFileSync(configPath, 'utf8'));
    return {
      status: 0,
      stdout: [
        'stderr-like non-json line',
        JSON.stringify({ jsonrpc: '2.0', method: 'window/logMessage', params: { message: 'ignored notification' } }),
        JSON.stringify({ jsonrpc: '2.0', id: 1, result: { capabilities: { ignored: true } } }),
        JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        result: {
          data: [
            { cwd: homeDir, hooks: [{ key: 'sidepulse.SessionStart.0.0', command: 'sidepulse', currentHash: 'new-sidepulse-hash' }] },
            { cwd: process.cwd(), hooks: managed.map((hook) => ({ key: codexAppServerKey(configPath, hook), command: hook.command, current_hash: `hash-${hook.event}` })) },
            { cwd: '/tmp/other', hooks: [{ key: 'other.PostToolUse.2.0', command: 'other-command', currentHash: 'other-hash' }] }
          ]
        }
      })
      ].join('\n') + '\n'
    };
  };

  const result = installCodexLifecycle({ homeDir, codexConfigPath: configPath, codexVersion: '0.150.1', stateRoot, writerPath, commandRunner });
  assert.equal(result.ok, true);
  assert.equal(result.trustConfigured, true);
  const installed = fs.readFileSync(configPath, 'utf8');
  assert.match(installed, /model = "gpt-5"/);
  assert.match(installed, /\[features\]\nhooks = true\nexperimental = true/);
  assert.match(installed, /command = '''/);
  assert.doesNotMatch(installed, /^\s*args\s*=/m);
  assert.doesNotMatch(installed, /dangerously-bypass-hook-trust/);
  assert.equal((installed.match(/hooks = true/g) || []).length, 1);
  assert.ok(CODEX_HOOK_EVENTS.every((event) => installed.includes(`[[hooks.${event}]]\nmatcher = "*"`)));
  assert.ok(CODEX_HOOK_EVENTS.every((event) => installed.includes(`[[hooks.${event}.hooks]]\ntype = "command"\nasync = false\ncommand = '''`)));
  assert.match(installed, /\[hooks\.state\."sidepulse\.SessionStart\.0\.0"\]\ntrusted_hash = "sidepulse-hash"/);
  assert.match(installed, /\[hooks\.state\."SessionStart\.0\.0"\]\ntrusted_hash = "unrelated-index-hash"/);
  assert.doesNotMatch(installed, /new-sidepulse-hash|other-hash/);
  const trust = parseCodexTrustedHookState(installed);
  const managed = parseCodexManagedHooks(installed);
  const managedTrustEntries = parseCodexManagedTrustEntries(installed);
  assert.equal(managed.length, CODEX_HOOK_EVENTS.length);
  assert.equal(managedTrustEntries.length, CODEX_HOOK_EVENTS.length);
  assert.equal(managed.every((hook) => hook.command === writerCommand('codex', hook.event, { writerPath, stateRoot })), true);
  assert.equal(managed.every((hook) => hook.async === false), true);
  assert.equal(CODEX_HOOK_EVENTS.every((event) => {
    const hook = managed.find((candidate) => candidate.event === event);
    const exactKey = codexAppServerKey(configPath, hook);
    return trust.get(exactKey) === `hash-${event}` && managedTrustEntries.some((entry) => entry.event === event && entry.key === exactKey && entry.command === hook.command);
  }), true);
  assert.equal(managed.some((hook) => trust.has(hook.stateKey)), false);

  const doctor = doctorAgentLifecycle({ harnesses: ['codex'], homeDir, codexConfigPath: configPath, codexVersion: '0.150.1', stateRoot, writerPath });
  assert.equal(doctor.ok, true);
  assert.equal(doctor.results[0].capability, 'exact');
  assert.deepEqual(doctor.results[0].untrustedEvents, []);

  const analyzed = analyzeCodexHooks(installed, { writerPath, stateRoot });
  assert.equal(analyzed.complete, true);
  assert.equal(analyzed.trusted, true);

  assert.equal(installCodexLifecycle({ homeDir, codexConfigPath: configPath, version: '0.1.0' }).ok, false);
  assert.equal(uninstallCodexLifecycle({ homeDir, codexConfigPath: configPath }).changed, true);
  const uninstalled = fs.readFileSync(configPath, 'utf8');
  assert.doesNotMatch(uninstalled, /token-monitor-agent-lifecycle/);
  assert.match(uninstalled, /command = "sidepulse"/);
  assert.match(uninstalled, /\[hooks\.state\."sidepulse\.SessionStart\.0\.0"\]\ntrusted_hash = "sidepulse-hash"/);
  assert.match(uninstalled, /\[hooks\.state\."SessionStart\.0\.0"\]\ntrusted_hash = "unrelated-index-hash"/);
});

test('Codex trust discovery accepts duplicate identical app-server hook entries for multiple cwds', () => {
  const homeDir = tempRoot();
  const configPath = path.join(homeDir, '.codex', 'config.toml');
  const writerPath = path.join(homeDir, 'agent-event.js');
  const stateRoot = path.join(homeDir, 'state');
  const commandRunner = () => {
    const managed = parseCodexManagedHooks(fs.readFileSync(configPath, 'utf8'));
    const hooks = managed.map((hook) => ({ key: codexAppServerKey(configPath, hook), command: hook.command, currentHash: `hash-${hook.event}` }));
    return {
      status: 0,
      stdout: `${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { data: [{ cwd: homeDir, hooks }, { cwd: process.cwd(), hooks }] } })}\n`
    };
  };

  const result = installCodexLifecycle({ homeDir, codexConfigPath: configPath, codexVersion: '0.150.1', stateRoot, writerPath, commandRunner });

  assert.equal(result.ok, true);
  assert.equal(result.trustConfigured, true);
  assert.equal(result.trustedKeys.length, CODEX_HOOK_EVENTS.length);
  const trust = parseCodexTrustedHookState(fs.readFileSync(configPath, 'utf8'));
  assert.equal(trust.size, CODEX_HOOK_EVENTS.length);
});

test('Codex trust discovery accepts complete hooks/list stdout before app-server timeout', () => {
  const homeDir = tempRoot();
  const configPath = path.join(homeDir, '.codex', 'config.toml');
  const writerPath = path.join(homeDir, 'agent-event.js');
  const stateRoot = path.join(homeDir, 'state');
  const timeout = Object.assign(new Error('spawnSync codex ETIMEDOUT'), { code: 'ETIMEDOUT' });
  const commandRunner = (command, args, runOptions) => {
    assert.equal(command, 'codex');
    assert.deepEqual(args, ['app-server', '--stdio']);
    assert.equal(runOptions.timeout, 5000);
    const managed = parseCodexManagedHooks(fs.readFileSync(configPath, 'utf8'));
    return {
      error: timeout,
      status: null,
      stdout: [
        JSON.stringify({ jsonrpc: '2.0', method: 'window/logMessage', params: { message: 'still alive' } }),
        JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05' } }),
        JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          result: {
            data: [{
              hooks: managed.map((hook) => ({
                key: codexAppServerKey(configPath, hook),
                command: hook.command,
                currentHash: `timeout-hash-${hook.event}`
              }))
            }]
          }
        })
      ].join('\n') + '\n'
    };
  };

  const result = installCodexLifecycle({ homeDir, codexConfigPath: configPath, codexVersion: '0.150.1', stateRoot, writerPath, commandRunner });
  const trust = parseCodexTrustedHookState(fs.readFileSync(configPath, 'utf8'));

  assert.equal(result.ok, true);
  assert.equal(result.trustConfigured, true);
  assert.equal(result.trustWarning, 'codex_app_server_timed_out_after_response');
  assert.equal(result.trustTerminatedAfterResponse, true);
  assert.equal(result.trustTerminationCode, 'ETIMEDOUT');
  assert.equal(trust.size, CODEX_HOOK_EVENTS.length);
  assert.equal([...trust.values()].every((hash) => hash.startsWith('timeout-hash-')), true);
});

test('Codex trust discovery rejects app-server timeout without complete hooks/list response', () => {
  const homeDir = tempRoot();
  const configPath = path.join(homeDir, '.codex', 'config.toml');
  const writerPath = path.join(homeDir, 'agent-event.js');
  const stateRoot = path.join(homeDir, 'state');
  const timeout = Object.assign(new Error('spawnSync codex ETIMEDOUT'), { code: 'ETIMEDOUT' });
  const commandRunner = () => ({
    error: timeout,
    status: null,
    stdout: `${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05' } })}\n`
  });

  const result = installCodexLifecycle({ homeDir, codexConfigPath: configPath, codexVersion: '0.150.1', stateRoot, writerPath, commandRunner });
  const installed = fs.readFileSync(configPath, 'utf8');

  assert.equal(result.ok, true);
  assert.equal(result.trustConfigured, false);
  assert.equal(result.trustCode, 'codex_app_server_unavailable');
  assert.deepEqual(parseCodexManagedTrustEntries(installed), []);
  assert.deepEqual([...parseCodexTrustedHookState(installed).keys()], []);
});

test('Codex reinstall fallback removes prior managed exact trust and leaves no orphan for uninstall', () => {
  const homeDir = tempRoot();
  const configPath = path.join(homeDir, '.codex', 'config.toml');
  const writerPath = path.join(homeDir, 'agent-event.js');
  const stateRoot = path.join(homeDir, 'state');
  const sidepulseKey = 'sidepulse.SessionStart.0.0';
  const sidepulseSimilarKey = 'sidepulse.SessionStart.0.00';
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, [
    'model = "gpt-5"',
    '',
    '[hooks.state."sidepulse.SessionStart.0.0"]',
    'trusted_hash = "sidepulse-hash"',
    '',
    '[hooks.state."sidepulse.SessionStart.0.00"]',
    'trusted_hash = "sidepulse-similar-hash"',
    ''
  ].join('\n'));

  let failDiscovery = false;
  const timeout = Object.assign(new Error('spawnSync codex ETIMEDOUT'), { code: 'ETIMEDOUT' });
  const commandRunner = () => {
    if (failDiscovery) {
      return {
        error: timeout,
        status: null,
        stdout: `${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05' } })}\n`
      };
    }
    const managed = parseCodexManagedHooks(fs.readFileSync(configPath, 'utf8'));
    return {
      status: 0,
      stdout: `${JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        result: {
          hooks: managed.map((hook) => ({
            key: `${configPath}:managed:${hook.event}:${hook.outerIndex}:${hook.hookIndex}`,
            command: hook.command,
            currentHash: `hash-${hook.event}`
          }))
        }
      })}\n`
    };
  };

  const trustedInstall = installCodexLifecycle({ homeDir, codexConfigPath: configPath, codexVersion: '0.150.1', stateRoot, writerPath, commandRunner });
  assert.equal(trustedInstall.trustConfigured, true);
  const previouslyManagedKeys = trustedInstall.trustedKeys;
  assert.equal(previouslyManagedKeys.length, CODEX_HOOK_EVENTS.length);

  failDiscovery = true;
  const fallbackInstall = installCodexLifecycle({ homeDir, codexConfigPath: configPath, codexVersion: '0.150.1', stateRoot, writerPath, commandRunner });
  const fallback = fs.readFileSync(configPath, 'utf8');
  const fallbackTrust = parseCodexTrustedHookState(fallback);

  assert.equal(fallbackInstall.ok, true);
  assert.equal(fallbackInstall.trustConfigured, false);
  assert.equal(fallbackInstall.trustCode, 'codex_app_server_unavailable');
  assert.deepEqual(parseCodexManagedTrustEntries(fallback), []);
  for (const key of previouslyManagedKeys) assert.equal(fallbackTrust.has(key), false);
  assert.equal(fallbackTrust.get(sidepulseKey), 'sidepulse-hash');
  assert.equal(fallbackTrust.get(sidepulseSimilarKey), 'sidepulse-similar-hash');

  const uninstalledResult = uninstallCodexLifecycle({ homeDir, codexConfigPath: configPath });
  const uninstalled = fs.readFileSync(configPath, 'utf8');
  const uninstalledTrust = parseCodexTrustedHookState(uninstalled);

  assert.equal(uninstalledResult.changed, true);
  assert.doesNotMatch(uninstalled, /token-monitor-agent-lifecycle/);
  assert.deepEqual(parseCodexManagedTrustEntries(uninstalled), []);
  for (const key of previouslyManagedKeys) assert.equal(uninstalledTrust.has(key), false);
  assert.equal(uninstalledTrust.get(sidepulseKey), 'sidepulse-hash');
  assert.equal(uninstalledTrust.get(sidepulseSimilarKey), 'sidepulse-similar-hash');
});

test('Codex trust discovery rejects conflicting duplicate app-server hook entries', () => {
  const homeDir = tempRoot();
  const configPath = path.join(homeDir, '.codex', 'config.toml');
  const writerPath = path.join(homeDir, 'agent-event.js');
  const stateRoot = path.join(homeDir, 'state');
  const commandRunner = () => {
    const managed = parseCodexManagedHooks(fs.readFileSync(configPath, 'utf8'));
    const hooks = managed.map((hook) => ({ key: codexAppServerKey(configPath, hook), command: hook.command, currentHash: `hash-${hook.event}` }));
    const conflict = { ...hooks[0], currentHash: 'different-hash' };
    return {
      status: 0,
      stdout: `${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { data: [{ cwd: homeDir, hooks }, { cwd: process.cwd(), hooks: [conflict] }] } })}\n`
    };
  };

  const result = installCodexLifecycle({ homeDir, codexConfigPath: configPath, codexVersion: '0.150.1', stateRoot, writerPath, commandRunner });

  assert.equal(result.ok, true);
  assert.equal(result.trustConfigured, false);
  assert.equal(result.trustCode, 'trust_discovery_conflict');
  const config = fs.readFileSync(configPath, 'utf8');
  assert.deepEqual(parseCodexManagedTrustEntries(config), []);
  assert.deepEqual([...parseCodexTrustedHookState(config).keys()], []);
});

test('Codex reinstall atomically refreshes exact managed trust keys', () => {
  const homeDir = tempRoot();
  const configPath = path.join(homeDir, '.codex', 'config.toml');
  const writerPath = path.join(homeDir, 'agent-event.js');
  const stateRoot = path.join(homeDir, 'state');
  let generation = 1;
  const commandRunner = () => {
    const managed = parseCodexManagedHooks(fs.readFileSync(configPath, 'utf8'));
    return {
      status: 0,
      stdout: `${JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        result: {
          data: [{
            hooks: managed.map((hook) => ({
              key: `${configPath}:gen-${generation}:hooks.${hook.event}[${hook.outerIndex}].hooks[${hook.hookIndex}]`,
              command: hook.command,
              currentHash: `hash-${generation}-${hook.event}`
            }))
          }]
        }
      })}\n`
    };
  };

  assert.equal(installCodexLifecycle({ homeDir, codexConfigPath: configPath, codexVersion: '0.150.1', stateRoot, writerPath, commandRunner }).trustConfigured, true);
  const first = fs.readFileSync(configPath, 'utf8');
  assert.match(first, /gen-1/);
  generation = 2;
  assert.equal(installCodexLifecycle({ homeDir, codexConfigPath: configPath, codexVersion: '0.150.1', stateRoot, writerPath, commandRunner }).trustConfigured, true);
  const second = fs.readFileSync(configPath, 'utf8');

  assert.doesNotMatch(second, /gen-1/);
  assert.match(second, /gen-2/);
  assert.equal(parseCodexManagedTrustEntries(second).length, CODEX_HOOK_EVENTS.length);
  assert.equal([...parseCodexTrustedHookState(second).keys()].every((key) => key.includes('gen-2')), true);
});

test('Codex analyzer treats missing or wrong nested hook async as partial, not exact', () => {
  const homeDir = tempRoot();
  const writerPath = path.join(homeDir, 'agent-event.js');
  const stateRoot = path.join(homeDir, 'state');
  const commandRunner = () => ({ status: 0, stdout: `${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { hooks: [] } })}\n` });
  const configPath = path.join(homeDir, '.codex', 'config.toml');

  installCodexLifecycle({ homeDir, codexConfigPath: configPath, codexVersion: '0.150.1', stateRoot, writerPath, commandRunner });
  const installed = fs.readFileSync(configPath, 'utf8');
  const missingAsync = installed.replace(/\nasync = false\n/, '\n');
  const wrongAsync = installed.replace(/\nasync = false\n/, '\nasync = true\n');

  for (const config of [missingAsync, wrongAsync]) {
    const analyzed = analyzeCodexHooks(config, { writerPath, stateRoot });
    assert.equal(analyzed.complete, false);
    assert.deepEqual(analyzed.partialEvents, ['SessionStart']);
    assert.deepEqual(analyzed.configuredEvents, CODEX_HOOK_EVENTS.filter((event) => event !== 'SessionStart'));
  }

  fs.writeFileSync(configPath, wrongAsync);
  const doctor = doctorAgentLifecycle({ harnesses: ['codex'], homeDir, codexConfigPath: configPath, codexVersion: '0.150.1', stateRoot, writerPath });
  assert.equal(doctor.results[0].capability, 'presence_only');
  assert.equal(doctor.results[0].hooksConfigured, false);
  assert.deepEqual(doctor.results[0].partialEvents, ['SessionStart']);
});

test('Codex install reports unconfigured trust when app-server omits current Token Monitor hashes', () => {
  const homeDir = tempRoot();
  const configPath = path.join(homeDir, '.codex', 'config.toml');
  const writerPath = path.join(homeDir, 'agent-event.js');
  const stateRoot = path.join(homeDir, 'state');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, 'model = "gpt-5"\n');

  const result = installCodexLifecycle({
    homeDir,
    codexConfigPath: configPath,
    codexVersion: '0.150.1',
    stateRoot,
    writerPath,
    commandRunner: () => ({
      status: 0,
      stdout: `${JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        result: {
          providers: [
            { name: 'sidepulse', hooks: [{ key: 'sidepulse.SessionStart.0.0', command: 'sidepulse', currentHash: 'sidepulse-hash' }] },
            { name: 'token-monitor', hooks: [{ key: 'wrong.0.0', command: 'not-token-monitor', currentHash: 'wrong-hash' }] }
          ]
        }
      })}\n`
    })
  });

  assert.equal(result.ok, true);
  assert.equal(result.trustConfigured, false);
  assert.equal(result.trustCode, 'trust_discovery_incomplete');
  const installed = fs.readFileSync(configPath, 'utf8');
  assert.match(installed, /token-monitor-agent-lifecycle/);
  assert.doesNotMatch(installed, /wrong-hash|sidepulse-hash/);
  const doctor = doctorAgentLifecycle({ harnesses: ['codex'], homeDir, codexConfigPath: configPath, codexVersion: '0.150.1', stateRoot, writerPath });
  assert.equal(doctor.ok, false);
  assert.equal(doctor.results[0].capability, 'presence_only');
  assert.deepEqual(doctor.results[0].untrustedEvents, CODEX_HOOK_EVENTS);
  assert.match(doctor.results[0].trustRepairAction, /install command again/);
});

test('Codex trust state parser decodes quoted table keys exactly and rejects malformed escapes', () => {
  const windowsKey = 'C:\\Users\\me\\.codex\\config.toml:session_start:1:0';
  const quotedBracketKey = 'quoted "key" [section]:SessionStart:1:0';
  const unicodeKey = 'unicode東京:PostToolUse:1:0';
  const config = [
    `[hooks.state.${JSON.stringify(windowsKey)}]`,
    'trusted_hash = "windows-hash"',
    '',
    `[hooks.state.${JSON.stringify(quotedBracketKey)}]`,
    'trusted_hash = "quoted-hash"',
    '',
    '[hooks.state."unicode\\u6771\\u4eac:PostToolUse:1:0"]',
    'trusted_hash = "unicode-hash"',
    '',
    '[hooks.state."bad\\qescape"]',
    'trusted_hash = "bad-hash"',
    '',
    '[hooks.state."unterminated\\"]',
    'trusted_hash = "unterminated-hash"',
    ''
  ].join('\n');

  const trust = parseCodexTrustedHookState(config);

  assert.equal(trust.get(windowsKey), 'windows-hash');
  assert.equal(trust.get(quotedBracketKey), 'quoted-hash');
  assert.equal(trust.get(unicodeKey), 'unicode-hash');
  assert.equal(trust.has('bad\\qescape'), false);
  assert.equal(trust.has('unterminated\\'), false);
  assert.deepEqual([...trust.keys()], [windowsKey, quotedBracketKey, unicodeKey]);
});

test('Codex install and doctor round-trip escaped exact app-server trust keys', () => {
  const homeDir = tempRoot();
  const configPath = path.join(homeDir, '.codex', 'config.toml');
  const writerPath = path.join(homeDir, 'agent event.js');
  const stateRoot = path.join(homeDir, 'state with spaces');
  const commandRunner = () => {
    const managed = parseCodexManagedHooks(fs.readFileSync(configPath, 'utf8'));
    return {
      status: 0,
      stdout: `${JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        result: {
          hooks: managed.map((hook) => ({
            key: codexEscapedAppServerKey(hook),
            command: hook.command,
            currentHash: `hash-${hook.event}`
          }))
        }
      })}\n`
    };
  };

  const result = installCodexLifecycle({ homeDir, codexConfigPath: configPath, codexVersion: '0.150.1', stateRoot, writerPath, commandRunner });
  const installed = fs.readFileSync(configPath, 'utf8');
  const trust = parseCodexTrustedHookState(installed);
  const sessionStart = CODEX_HOOK_EVENTS.includes('SessionStart')
    ? parseCodexManagedHooks(installed).find((hook) => hook.event === 'SessionStart')
    : null;
  const exactSessionStartKey = codexEscapedAppServerKey(sessionStart);

  assert.equal(result.ok, true);
  assert.equal(result.trustConfigured, true);
  assert.ok(installed.includes('[hooks.state."C:\\\\Users\\\\me\\\\.codex\\\\config.toml:session_start:1:0"]'));
  assert.equal(trust.get(exactSessionStartKey), 'hash-SessionStart');
  assert.equal(trust.size, CODEX_HOOK_EVENTS.length);

  const doctor = doctorAgentLifecycle({ harnesses: ['codex'], homeDir, codexConfigPath: configPath, codexVersion: '0.150.1', stateRoot, writerPath });
  assert.equal(doctor.ok, true);
  assert.equal(doctor.results[0].capability, 'exact');
  assert.deepEqual(doctor.results[0].untrustedEvents, []);
  assert.ok(doctor.results[0].trustedEvents.includes('SessionStart'));
});

test('Codex uninstall removes only owned escaped exact trust key and preserves unrelated state', () => {
  const homeDir = tempRoot();
  const configPath = path.join(homeDir, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const ownedKey = 'C:\\Users\\me\\.codex\\config.toml:session_start:1:0';
  const unrelatedSimilarKey = 'C:\\Users\\me\\.codex\\config.toml:session_start:1:00';
  const unrelatedQuotedKey = 'quoted "key" [section]:session_start:1:0';
  fs.writeFileSync(configPath, [
    'model = "gpt-5"',
    '',
    `# >>> token-monitor-agent-lifecycle:v1`,
    '# owner = Token Monitor agent lifecycle',
    `# tokenMonitorTrustEntry = ${JSON.stringify({ event: 'SessionStart', command: 'token-monitor', key: ownedKey })}`,
    '[[hooks.SessionStart]]',
    'matcher = "*"',
    `# <<< token-monitor-agent-lifecycle:v1`,
    '',
    `[hooks.state.${JSON.stringify(ownedKey)}]`,
    'trusted_hash = "owned-hash"',
    '',
    `[hooks.state.${JSON.stringify(unrelatedSimilarKey)}]`,
    'trusted_hash = "similar-hash"',
    '',
    `[hooks.state.${JSON.stringify(unrelatedQuotedKey)}]`,
    'trusted_hash = "quoted-hash"',
    ''
  ].join('\n'));

  const result = uninstallCodexLifecycle({ homeDir, codexConfigPath: configPath });
  const uninstalled = fs.readFileSync(configPath, 'utf8');
  const trust = parseCodexTrustedHookState(uninstalled);

  assert.equal(result.changed, true);
  assert.doesNotMatch(uninstalled, /token-monitor-agent-lifecycle/);
  assert.equal(trust.has(ownedKey), false);
  assert.equal(trust.get(unrelatedSimilarKey), 'similar-hash');
  assert.equal(trust.get(unrelatedQuotedKey), 'quoted-hash');
});

test('Codex install validates config before creating writer or backups', () => {
  const homeDir = tempRoot();
  const configPath = path.join(homeDir, '.codex', 'config.toml');
  const writerPath = path.join(homeDir, 'writer', 'agent-event.js');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, 'model = "gpt-5"\n\n[features\nhooks = false\n');

  const result = installCodexLifecycle({
    homeDir,
    codexConfigPath: configPath,
    writerPath,
    codexVersion: '0.150.1',
    stateRoot: path.join(homeDir, 'state'),
    nowMs: NOW
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid_toml');
  assert.equal(fs.existsSync(writerPath), false);
  assert.equal(fs.existsSync(path.dirname(writerPath)), false);
  assert.equal(fs.readFileSync(configPath, 'utf8'), 'model = "gpt-5"\n\n[features\nhooks = false\n');
  assert.deepEqual(fs.readdirSync(path.dirname(configPath)).filter((name) => name.includes('.bak.')), []);
});

test('OpenCode install refuses unmanaged collision and uninstalls owned plugin only', () => {
  const homeDir = tempRoot();
  const configDir = path.join(homeDir, 'oc');
  const pluginPath = path.join(configDir, 'plugins', 'token-monitor-agent-state.js');
  fs.mkdirSync(path.dirname(pluginPath), { recursive: true });
  fs.writeFileSync(pluginPath, 'module.exports = {};\n');
  assert.equal(installOpenCodeLifecycle({ opencodeConfigDir: configDir, opencodeVersion: '1.18.25' }).code, 'unmanaged_collision');

  fs.rmSync(pluginPath);
  assert.equal(installOpenCodeLifecycle({ opencodeConfigDir: configDir, opencodeVersion: '1.18.25' }).ok, true);
  assert.match(fs.readFileSync(pluginPath, 'utf8'), /export const TokenMonitorAgentState/);
  assert.equal(uninstallOpenCodeLifecycle({ opencodeConfigDir: configDir }).changed, true);
  assert.equal(fs.existsSync(pluginPath), false);
});

test('OpenCode install refuses directory and symlink plugin destinations without reading them', (t) => {
  const homeDir = tempRoot();
  const dirConfig = path.join(homeDir, 'oc-dir');
  const dirPluginPath = path.join(dirConfig, 'plugins', 'token-monitor-agent-state.js');
  fs.mkdirSync(dirPluginPath, { recursive: true });
  const dirResult = installOpenCodeLifecycle({ opencodeConfigDir: dirConfig, opencodeVersion: '1.18.25' });
  assert.equal(dirResult.ok, false);
  assert.equal(dirResult.code, 'unsafe_destination');
  assert.equal(dirResult.path, dirPluginPath);
  const dirDoctor = doctorAgentLifecycle({ harnesses: ['opencode'], opencodeConfigDir: dirConfig, opencodeVersion: '1.18.25', stateRoot: path.join(homeDir, 'state') });
  assert.equal(dirDoctor.ok, false);
  assert.equal(dirDoctor.results[0].pluginOk, false);
  assert.equal(dirDoctor.results[0].code, 'unsafe_destination');

  const linkConfig = path.join(homeDir, 'oc-link');
  const linkPluginPath = path.join(linkConfig, 'plugins', 'token-monitor-agent-state.js');
  const target = path.join(homeDir, 'target-plugin.js');
  fs.mkdirSync(path.dirname(linkPluginPath), { recursive: true });
  fs.writeFileSync(target, '// token-monitor-agent-lifecycle:v1\n');
  if (!makeFileSymlink(t, target, linkPluginPath)) return;
  const linkResult = installOpenCodeLifecycle({ opencodeConfigDir: linkConfig, opencodeVersion: '1.18.25' });
  assert.equal(linkResult.ok, false);
  assert.equal(linkResult.code, 'unsafe_destination');
  const linkDoctor = doctorAgentLifecycle({ harnesses: ['opencode'], opencodeConfigDir: linkConfig, opencodeVersion: '1.18.25', stateRoot: path.join(homeDir, 'state') });
  assert.equal(linkDoctor.ok, false);
  assert.equal(linkDoctor.results[0].pluginOk, false);
  assert.equal(linkDoctor.results[0].code, 'unsafe_destination');
  assert.equal(fs.readFileSync(target, 'utf8'), '// token-monitor-agent-lifecycle:v1\n');
});

test('OpenCode install renders configured default root and plugin writes there without env', async () => {
  const homeDir = tempRoot();
  const configDir = path.join(homeDir, 'oc');
  const stateRoot = missingTempStateRoot('tm-agent-life-opencode-state-');
  const fallbackRoot = path.join(homeDir, 'fallback-state');
  const installed = installOpenCodeLifecycle({ opencodeConfigDir: configDir, opencodeVersion: '1.18.25', stateRoot });
  assert.equal(installed.ok, true);
  assert.equal(installOpenCodeLifecycle({ opencodeConfigDir: configDir, opencodeVersion: '1.18.25', stateRoot }).changed, false);
  assert.equal(installOpenCodeLifecycle({ opencodeConfigDir: configDir, opencodeVersion: '1.18.25', stateRoot, dryRun: true }).changed, false);
  assert.match(fs.readFileSync(installed.pluginPath, 'utf8'), new RegExp(`const CONFIGURED_DEFAULT_ROOT = ${JSON.stringify(stateRoot).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')};`));
  const doctor = doctorAgentLifecycle({ harnesses: ['opencode'], opencodeConfigDir: configDir, opencodeVersion: '1.18.25', stateRoot });
  assert.equal(doctor.ok, true);
  assert.equal(doctor.results[0].configuredRootMatches, true);
  const mismatch = doctorAgentLifecycle({ harnesses: ['opencode'], opencodeConfigDir: configDir, opencodeVersion: '1.18.25', stateRoot: path.join(homeDir, 'other-state') });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.results[0].configuredRootMatches, false);
  fs.rmSync(stateRoot, { recursive: true, force: true });

  const previousStateRoot = process.env.TOKEN_MONITOR_AGENT_STATE_ROOT;
  const previousXdgState = process.env.XDG_STATE_HOME;
  delete process.env.TOKEN_MONITOR_AGENT_STATE_ROOT;
  process.env.XDG_STATE_HOME = fallbackRoot;
  try {
    const mod = await import(`${pathToFileURL(installed.pluginPath)}?custom-root`);
    const plugin = await mod.TokenMonitorAgentState({ profile: 'ctx-profile' });
    await plugin.event({ event: { type: 'session.created', sessionID: 'oc-session-a', profile: 'work' } });
  } finally {
    if (previousStateRoot == null) delete process.env.TOKEN_MONITOR_AGENT_STATE_ROOT;
    else process.env.TOKEN_MONITOR_AGENT_STATE_ROOT = previousStateRoot;
    if (previousXdgState == null) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousXdgState;
  }
  assert.equal(stateSummaries(stateRoot).length, 1);
  if (process.platform !== 'win32') assert.equal(fs.statSync(stateRoot).mode & 0o777, 0o700);
  assert.equal(fs.existsSync(path.join(fallbackRoot, 'token-monitor', 'agent-state')), false);
});

test('OpenCode installed plugin imports as ESM and handles 1.18.18/1.18.25 native callback shapes', async () => {
  for (const version of ['1.18.18', '1.18.25']) {
    const homeDir = tempRoot();
    const configDir = path.join(homeDir, 'oc');
    const stateRoot = path.join(homeDir, 'state');
    const installed = installOpenCodeLifecycle({ opencodeConfigDir: configDir, opencodeVersion: version });
    assert.equal(installed.ok, true);
    const esmCopy = path.join(homeDir, `plugin-${version}.mjs`);
    fs.copyFileSync(installed.pluginPath, esmCopy);
    const mod = await import(`${pathToFileURL(esmCopy)}?v=${version}`);
    assert.equal(typeof mod.TokenMonitorAgentState, 'function');
    const plugin = await mod.TokenMonitorAgentState({ profile: 'ctx-profile' });
    assert.equal(typeof plugin.event, 'function');
    assert.equal(typeof plugin['tool.execute.before'], 'function');

    const previous = process.env.TOKEN_MONITOR_AGENT_STATE_ROOT;
    process.env.TOKEN_MONITOR_AGENT_STATE_ROOT = stateRoot;
    try {
      await plugin.event({ event: { type: 'session.created', sessionID: 'oc-session-a', profile: 'work' } });
      await plugin['tool.execute.before']({ sessionID: 'oc-session-b', profile: 'work', tool: { name: 'bash', input: { secret: true } }, callID: 'call-1' }, {});
      await plugin['tool.execute.after']({ sessionID: 'oc-session-c', profile: 'work', tool: 'edit', callID: 'call-2' }, { success: false });
    } finally {
      if (previous == null) delete process.env.TOKEN_MONITOR_AGENT_STATE_ROOT;
      else process.env.TOKEN_MONITOR_AGENT_STATE_ROOT = previous;
    }
    assert.deepEqual(stateSummaries(stateRoot), [
      { harness: 'opencode', profile: 'work', event: 'error', toolName: 'edit', surface: 'opencode' },
      { harness: 'opencode', profile: 'work', event: 'session_started', toolName: '', surface: 'opencode' },
      { harness: 'opencode', profile: 'work', event: 'tool_started', toolName: 'bash', surface: 'opencode' }
    ]);
  }
});

test('OpenCode plugin uses unique temp snapshots and cleans stale temps for same-session callbacks', async (t) => {
  const homeDir = tempRoot();
  const configDir = path.join(homeDir, 'oc');
  const stateRoot = path.join(homeDir, 'state');
  const installed = installOpenCodeLifecycle({ opencodeConfigDir: configDir, opencodeVersion: '1.18.25' });
  assert.equal(installed.ok, true);
  const esmCopy = path.join(homeDir, 'opencode-temp-collision-plugin.mjs');
  fs.copyFileSync(installed.pluginPath, esmCopy);
  const script = path.join(homeDir, 'opencode-temp-collision-test.mjs');
  fs.writeFileSync(script, `
import fs from 'node:fs';
import path from 'node:path';
import { TokenMonitorAgentState } from ${JSON.stringify(pathToFileURL(esmCopy).href)};

process.env.TOKEN_MONITOR_AGENT_STATE_ROOT = ${JSON.stringify(stateRoot)};
const plugin = await TokenMonitorAgentState({ profile: "work" });
await plugin.event({ event: { type: "session.created", sessionID: "same-session", profile: "work" } });
const file = fs.readdirSync(${JSON.stringify(stateRoot)}).find((name) => name.endsWith(".json"));
fs.writeFileSync(path.join(${JSON.stringify(stateRoot)}, "." + file + "." + process.pid + ".tmp"), "stale");
fs.writeFileSync(path.join(${JSON.stringify(stateRoot)}, "." + file + "." + process.pid + ".123.tmp"), "stale");
await Promise.all([
  plugin["tool.execute.before"]({ sessionID: "same-session", profile: "work", tool: "bash" }, {}),
  plugin["tool.execute.after"]({ sessionID: "same-session", profile: "work", tool: "bash" }, { success: false })
]);
await plugin.event({ event: { type: "session.idle", sessionID: "same-session", profile: "work" } });
const entries = fs.readdirSync(${JSON.stringify(stateRoot)}).sort();
const state = JSON.parse(fs.readFileSync(path.join(${JSON.stringify(stateRoot)}, file), "utf8")).state;
console.log(JSON.stringify({ entries, event: state.event }));
`);
  const run = childProcess.spawnSync(process.execPath, [script], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (run.error?.code === 'EPERM' && !run.stdout) {
    t.skip('sandbox suppressed child process stdout');
    return;
  }
  assert.equal(run.status, 0, run.stderr);
  const output = JSON.parse(run.stdout);
  assert.equal(output.event, 'turn_completed');
  assert.equal(output.entries.length, 1);
  assert.equal(output.entries[0].endsWith('.json'), true);
});

test('OpenCode installed plugin fails open on symlinked env and configured state roots', async (t) => {
  const homeDir = tempRoot();
  const configDir = path.join(homeDir, 'oc');
  const envTarget = path.join(homeDir, 'env-target');
  const envLink = path.join(homeDir, 'env-link');
  const unsafeRoot = path.join(homeDir, 'unsafe-root');
  const customTarget = path.join(homeDir, 'custom-target');
  const customLink = path.join(homeDir, 'custom-link');
  fs.mkdirSync(envTarget, { mode: 0o755 });
  fs.mkdirSync(unsafeRoot, { mode: 0o755 });
  fs.mkdirSync(customTarget, { mode: 0o755 });
  if (!makeDirSymlink(t, envTarget, envLink)) return;
  if (!makeDirSymlink(t, customTarget, customLink)) return;
  if (process.platform !== 'win32') {
    fs.chmodSync(envTarget, 0o755);
    fs.chmodSync(unsafeRoot, 0o755);
    fs.chmodSync(customTarget, 0o755);
  }

  const installed = installOpenCodeLifecycle({ opencodeConfigDir: configDir, opencodeVersion: '1.18.25', stateRoot: path.join(customLink, 'nested') });
  assert.equal(installed.ok, true);
  const script = path.join(homeDir, 'opencode-symlink-root-test.mjs');
  fs.writeFileSync(script, `
import { TokenMonitorAgentState } from ${JSON.stringify(pathToFileURL(installed.pluginPath).href)};

const envPlugin = await TokenMonitorAgentState({ profile: "work" });
process.env.TOKEN_MONITOR_AGENT_STATE_ROOT = ${JSON.stringify(envLink)};
await envPlugin.event({ event: { type: "session.created", sessionID: "env-session", profile: "work" } });

${process.platform !== 'win32' ? `
process.env.TOKEN_MONITOR_AGENT_STATE_ROOT = ${JSON.stringify(unsafeRoot)};
await envPlugin.event({ event: { type: "session.created", sessionID: "unsafe-session", profile: "work" } });
` : ''}

delete process.env.TOKEN_MONITOR_AGENT_STATE_ROOT;
const customPlugin = await TokenMonitorAgentState({ profile: "work" });
await customPlugin.event({ event: { type: "session.created", sessionID: "custom-session", profile: "work" } });
`);
  const run = childProcess.spawnSync(process.execPath, [script], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, '');
  assert.deepEqual(fs.readdirSync(envTarget), []);
  assert.equal(fs.existsSync(path.join(customTarget, 'nested')), false);
  if (process.platform !== 'win32') {
    assert.deepEqual(fs.readdirSync(unsafeRoot), []);
    assert.equal(fs.statSync(envTarget).mode & 0o777, 0o755);
    assert.equal(fs.statSync(unsafeRoot).mode & 0o777, 0o755);
    assert.equal(fs.statSync(customTarget).mode & 0o777, 0o755);
  }
});

test('Hermes installed plugin registers live hooks and writes metadata snapshots from kwargs callbacks', () => {
  const homeDir = tempRoot();
  const hermesHome = path.join(homeDir, '.hermes');
  const stateRoot = path.join(homeDir, 'state');
  const installed = installHermesLifecycle({
    hermesHome,
    profiles: ['default'],
    hermesVersion: '0.20.5',
    commandRunner: () => ({ status: 0, stdout: '', stderr: '' })
  });
  assert.equal(installed.ok, true);
  const pluginDir = path.join(hermesHome, 'plugins', 'token-monitor-agent-state');
  const script = path.join(homeDir, 'hermes-plugin-live-test.py');
  fs.writeFileSync(script, `
import importlib.util
import json
import os
import sys
from pathlib import Path

plugin_dir = Path(${JSON.stringify(pluginDir)})
state_root = Path(${JSON.stringify(stateRoot)})
os.environ["TOKEN_MONITOR_AGENT_STATE_ROOT"] = str(state_root)

spec = importlib.util.spec_from_file_location(
    "token_monitor_agent_state_live",
    plugin_dir / "__init__.py",
    submodule_search_locations=[str(plugin_dir)],
)
mod = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = mod
spec.loader.exec_module(mod)

class Ctx:
    def __init__(self, profile_name):
        self.profile_name = profile_name
        self.hooks = {}
        self.tools = []
    def register_hook(self, hook_name, callback):
        self.hooks[hook_name] = callback
    def register_tool(self, *args, **kwargs):
        self.tools.append([args, kwargs])

def read_states():
    states = []
    for path in sorted(state_root.glob("*.json")):
        states.append(json.loads(path.read_text(encoding="utf-8"))["state"])
    return states

work = Ctx("work")
personal = Ctx("personal")
mod.register(work)
mod.register(personal)

work.hooks["pre_llm_call"](turn_id="unmapped-turn", prompt="secret", path="/private")
after_unmapped = read_states()
work.hooks["on_session_start"](session_id="session-a", cwd="/private/project")
work.hooks["pre_tool_call"](session_id="session-a", turn_id="turn-a", tool={"name": "bash", "input": {"secret": True}}, path="/private")
work.hooks["post_tool_call"](turn_id="turn-a", tool_name="bash", success=False)
after_correlated = read_states()
work.hooks["on_session_end"](session_id="session-a")
after_end = read_states()
work.hooks["post_llm_call"](turn_id="turn-a")
after_cleared = read_states()
personal.hooks["on_session_start"](session_id="session-a")

missing_profile = Ctx("")
mod.register(missing_profile)
missing_profile.hooks["on_session_start"](session_id="session-b")

before_error = len(list(state_root.glob("*.json"))) if state_root.exists() else 0
mod.write_hook = lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("boom"))
work.hooks["api_request_error"](session_id="session-a", error="hidden")
after_error = len(list(state_root.glob("*.json"))) if state_root.exists() else 0

print(json.dumps({
    "registered": list(work.hooks.keys()),
    "tools": len(work.tools) + len(personal.tools) + len(missing_profile.tools),
    "afterUnmapped": after_unmapped,
    "afterCorrelated": after_correlated,
    "afterEnd": after_end,
    "afterCleared": after_cleared,
    "beforeError": before_error,
    "afterError": after_error,
    "states": read_states(),
}))
`);
  const run = childProcess.spawnSync('python3', [script], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (run.error?.code === 'ENOENT') return;
  assert.equal(run.status, 0, run.stderr);
  const output = JSON.parse(run.stdout);
  assert.deepEqual(output.registered, HERMES_HOOKS);
  assert.equal(output.tools, 0);
  assert.equal(output.afterUnmapped.length, 0);
  assert.equal(output.afterCorrelated.length, 1);
  assert.equal(output.afterCorrelated[0].event, 'error');
  assert.equal(output.afterCorrelated[0].toolName, 'bash');
  assert.equal(output.afterEnd.length, 1);
  assert.equal(output.afterEnd[0].event, 'session_ended');
  assert.deepEqual(output.afterCleared, output.afterEnd);
  assert.equal(output.beforeError, output.afterError);
  assert.equal(output.states.length, 2);
  assert.deepEqual([...new Set(output.states.map((state) => state.profile))].sort(), ['personal', 'work']);
  assert.equal(new Set(output.states.map((state) => state.sessionId)).size, 2);
  assert.ok(output.states.every((state) => state.harness === 'hermes' && state.surface === 'hermes'));
  assert.ok(output.states.every((state) => !Object.hasOwn(state, 'path') && !Object.hasOwn(state, 'prompt') && !Object.hasOwn(state, 'cwd')));
});

test('Hermes callbacks use unique temp snapshots and later same-session events win despite stale temps', () => {
  const homeDir = tempRoot();
  const hermesHome = path.join(homeDir, '.hermes');
  const stateRoot = path.join(homeDir, 'state');
  const installed = installHermesLifecycle({
    hermesHome,
    profiles: ['default'],
    hermesVersion: '0.20.5',
    commandRunner: () => ({ status: 0, stdout: '', stderr: '' })
  });
  assert.equal(installed.ok, true);
  const pluginDir = path.join(hermesHome, 'plugins', 'token-monitor-agent-state');
  const script = path.join(homeDir, 'hermes-temp-collision-test.py');
  fs.writeFileSync(script, `
import importlib.util
import json
import os
import sys
import threading
from pathlib import Path

plugin_dir = Path(${JSON.stringify(pluginDir)})
state_root = Path(${JSON.stringify(stateRoot)})
os.environ["TOKEN_MONITOR_AGENT_STATE_ROOT"] = str(state_root)

spec = importlib.util.spec_from_file_location(
    "token_monitor_agent_state_temp_collision",
    plugin_dir / "__init__.py",
    submodule_search_locations=[str(plugin_dir)],
)
mod = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = mod
spec.loader.exec_module(mod)

class Ctx:
    profile_name = "work"
    def __init__(self):
        self.hooks = {}
    def register_hook(self, hook_name, callback):
        self.hooks[hook_name] = callback

ctx = Ctx()
mod.register(ctx)
ctx.hooks["on_session_start"](session_id="same-session")
file_name = next(path.name for path in state_root.glob("*.json"))
(state_root / f".{file_name}.{os.getpid()}.tmp").write_text("stale", encoding="utf-8")
(state_root / f".{file_name}.{os.getpid()}.123.tmp").write_text("stale", encoding="utf-8")

threads = [
    threading.Thread(target=ctx.hooks["pre_tool_call"], kwargs={"session_id": "same-session", "tool_name": "bash"}),
    threading.Thread(target=ctx.hooks["post_tool_call"], kwargs={"session_id": "same-session", "tool_name": "bash", "success": False}),
]
for thread in threads:
    thread.start()
for thread in threads:
    thread.join()
ctx.hooks["on_session_end"](session_id="same-session")

entries = sorted(path.name for path in state_root.iterdir())
state = json.loads((state_root / file_name).read_text(encoding="utf-8"))["state"]
print(json.dumps({"entries": entries, "event": state["event"]}))
`);
  const run = childProcess.spawnSync('python3', [script], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (run.error?.code === 'ENOENT') return;
  assert.equal(run.status, 0, run.stderr);
  const output = JSON.parse(run.stdout);
  assert.equal(output.event, 'session_ended');
  assert.equal(output.entries.length, 1);
  assert.equal(output.entries[0].endsWith('.json'), true);
});

test('Hermes custom state root is persisted locally and used by package callbacks without env', () => {
  const homeDir = tempRoot();
  const hermesHome = path.join(homeDir, '.hermes');
  const stateRoot = missingTempStateRoot('tm-agent-life-hermes-state-');
  const fallbackState = path.join(homeDir, 'fallback-state');
  const installed = installHermesLifecycle({
    hermesHome,
    profiles: ['default'],
    hermesVersion: '0.20.5',
    stateRoot,
    commandRunner: () => ({ status: 0, stdout: '', stderr: '' })
  });
  assert.equal(installed.ok, true);
  const pluginDir = path.join(hermesHome, 'plugins', 'token-monitor-agent-state');
  const settingsPath = path.join(pluginDir, 'settings.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), {
    storeVersion: 1,
    tokenMonitorManaged: 'token-monitor-agent-lifecycle:v1',
    stateRoot
  });
  if (process.platform !== 'win32') assert.equal(fs.statSync(settingsPath).mode & 0o777, 0o600);
  assert.equal(installHermesLifecycle({
    hermesHome,
    profiles: ['default'],
    hermesVersion: '0.20.5',
    stateRoot,
    commandRunner: () => ({ status: 0, stdout: '', stderr: '' })
  }).results[0].changed, false);

  const script = path.join(homeDir, 'hermes-plugin-custom-root-test.py');
  fs.writeFileSync(script, `
import importlib.util
import json
import os
import sys
from pathlib import Path

plugin_dir = Path(${JSON.stringify(pluginDir)})
os.environ.pop("TOKEN_MONITOR_AGENT_STATE_ROOT", None)
os.environ["XDG_STATE_HOME"] = ${JSON.stringify(fallbackState)}

spec = importlib.util.spec_from_file_location(
    "token_monitor_agent_state_custom_root",
    plugin_dir / "__init__.py",
    submodule_search_locations=[str(plugin_dir)],
)
mod = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = mod
spec.loader.exec_module(mod)

class Ctx:
    profile_name = "work"
    def __init__(self):
        self.hooks = {}
    def register_hook(self, hook_name, callback):
        self.hooks[hook_name] = callback

ctx = Ctx()
mod.register(ctx)
ctx.hooks["on_session_start"](sessionID="hermes-session-a")
print(json.dumps({"files": sorted(path.name for path in Path(${JSON.stringify(stateRoot)}).glob("*.json"))}))
`);
  const run = childProcess.spawnSync('python3', [script], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (run.error?.code === 'ENOENT') return;
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).files.length, 1);
  if (process.platform !== 'win32') assert.equal(fs.statSync(stateRoot).mode & 0o777, 0o700);
  assert.equal(fs.existsSync(path.join(fallbackState, 'token-monitor', 'agent-state')), false);
});

test('Hermes package callbacks fail open on symlinked env and configured state roots', (t) => {
  const homeDir = tempRoot();
  const hermesHome = path.join(homeDir, '.hermes');
  const envTarget = path.join(homeDir, 'env-target');
  const envLink = path.join(homeDir, 'env-link');
  const unsafeRoot = path.join(homeDir, 'unsafe-root');
  const customTarget = path.join(homeDir, 'custom-target');
  const customLink = path.join(homeDir, 'custom-link');
  fs.mkdirSync(envTarget, { mode: 0o755 });
  fs.mkdirSync(unsafeRoot, { mode: 0o755 });
  fs.mkdirSync(customTarget, { mode: 0o755 });
  if (!makeDirSymlink(t, envTarget, envLink)) return;
  if (!makeDirSymlink(t, customTarget, customLink)) return;
  if (process.platform !== 'win32') {
    fs.chmodSync(envTarget, 0o755);
    fs.chmodSync(unsafeRoot, 0o755);
    fs.chmodSync(customTarget, 0o755);
  }

  const installed = installHermesLifecycle({
    hermesHome,
    profiles: ['default'],
    hermesVersion: '0.20.5',
    stateRoot: path.join(customLink, 'nested'),
    commandRunner: () => ({ status: 0, stdout: '', stderr: '' })
  });
  assert.equal(installed.ok, true);
  const pluginDir = path.join(hermesHome, 'plugins', 'token-monitor-agent-state');
  const script = path.join(homeDir, 'hermes-symlink-root-test.py');
  fs.writeFileSync(script, `
import importlib.util
import os
import sys
from pathlib import Path

plugin_dir = Path(${JSON.stringify(pluginDir)})
spec = importlib.util.spec_from_file_location(
    "token_monitor_agent_state_symlink_root",
    plugin_dir / "__init__.py",
    submodule_search_locations=[str(plugin_dir)],
)
mod = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = mod
spec.loader.exec_module(mod)

class Ctx:
    profile_name = "work"
    def __init__(self):
        self.hooks = {}
    def register_hook(self, hook_name, callback):
        self.hooks[hook_name] = callback

ctx = Ctx()
mod.register(ctx)
os.environ["TOKEN_MONITOR_AGENT_STATE_ROOT"] = ${JSON.stringify(envLink)}
ctx.hooks["on_session_start"](session_id="env-session")
${process.platform !== 'win32' ? `
os.environ["TOKEN_MONITOR_AGENT_STATE_ROOT"] = ${JSON.stringify(unsafeRoot)}
ctx.hooks["on_session_start"](session_id="unsafe-session")
` : ''}
os.environ.pop("TOKEN_MONITOR_AGENT_STATE_ROOT", None)
ctx.hooks["on_session_start"](session_id="custom-session")
`);
  const run = childProcess.spawnSync('python3', [script], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (run.error?.code === 'ENOENT') return;
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, '');
  assert.deepEqual(fs.readdirSync(envTarget), []);
  assert.equal(fs.existsSync(path.join(customTarget, 'nested')), false);
  if (process.platform !== 'win32') {
    assert.deepEqual(fs.readdirSync(unsafeRoot), []);
    assert.equal(fs.statSync(envTarget).mode & 0o777, 0o755);
    assert.equal(fs.statSync(unsafeRoot).mode & 0o777, 0o755);
    assert.equal(fs.statSync(customTarget).mode & 0o777, 0o755);
  }
});

test('Hermes install is per-profile, rejects traversal, and uninstalls only owned plugin dir', () => {
  const homeDir = tempRoot();
  const hermesHome = path.join(homeDir, '.hermes');
  const calls = [];
  const commandRunner = (command, args) => {
    calls.push([command, args]);
    return { status: 0, stdout: '', stderr: '' };
  };
  const result = installHermesLifecycle({ hermesHome, profiles: ['default', '../bad'], hermesVersion: '0.20.5', commandRunner });
  assert.equal(result.ok, false);
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[1].code, 'invalid_profile');
  const pluginDir = path.join(hermesHome, 'plugins', 'token-monitor-agent-state');
  assert.equal(fs.existsSync(path.join(pluginDir, 'plugin.yaml')), true);
  assert.doesNotMatch(fs.readFileSync(path.join(pluginDir, 'plugin.yaml'), 'utf8'), /on_session_activate/);
  assert.deepEqual(calls[0], ['hermes', ['plugins', 'enable', 'token-monitor-agent-state']]);
  assert.equal(uninstallHermesLifecycle({ hermesHome, profiles: ['default'], commandRunner }).ok, true);
  assert.equal(fs.existsSync(pluginDir), false);
  assert.deepEqual(calls.at(-1), ['hermes', ['plugins', 'disable', 'token-monitor-agent-state']]);
});

test('Hermes named profile path, enable commands, dry-run, rollback and coexistence are safe', () => {
  const homeDir = tempRoot();
  const hermesHome = path.join(homeDir, '.hermes');
  assert.equal(hermesPluginDir({ hermesHome, profile: 'research' }), path.join(hermesHome, 'profiles', 'research', 'plugins', 'token-monitor-agent-state'));
  assert.equal(hermesPluginDir({ hermesHome, profile: '../bad' }), '');
  fs.mkdirSync(path.join(hermesHome, 'profiles', 'research', 'plugins', 'herdr-agent-state'), { recursive: true });

  const calls = [];
  const commandRunner = (command, args) => {
    calls.push([command, args]);
    return { status: 0, stdout: 'token-monitor-agent-state enabled\n', stderr: '' };
  };
  const dry = installHermesLifecycle({
    hermesHome,
    profiles: ['research'],
    dryRun: true,
    commandRunner: (command, args) => {
      assert.equal(command, 'hermes');
      assert.deepEqual(args, ['--version']);
      return { status: 0, stdout: 'hermes 0.20.5\n', stderr: '' };
    }
  });
  assert.equal(dry.results[0].changed, true);
  assert.deepEqual(calls, []);

  const installed = installHermesLifecycle({ hermesHome, profiles: ['research'], hermesVersion: '0.20.5', commandRunner });
  assert.equal(installed.ok, true);
  assert.deepEqual(calls[0], ['hermes', ['--profile', 'research', 'plugins', 'enable', 'token-monitor-agent-state']]);
  assert.equal(fs.existsSync(path.join(hermesHome, 'profiles', 'research', 'plugins', 'herdr-agent-state')), true);

  const before = fs.readdirSync(path.join(hermesHome, 'profiles', 'research', 'plugins')).sort();
  const failed = installHermesLifecycle({
    hermesHome,
    profiles: ['fail'],
    hermesVersion: '0.20.5',
    commandRunner: () => ({ status: 1, stdout: '', stderr: 'nope' })
  });
  assert.equal(failed.ok, false);
  assert.equal(fs.existsSync(path.join(hermesHome, 'profiles', 'fail', 'plugins', 'token-monitor-agent-state')), false);
  assert.deepEqual(fs.readdirSync(path.join(hermesHome, 'profiles', 'research', 'plugins')).sort(), before);
});

test('Hermes plugin list parser accepts live plain rows and conservative legacy rows', () => {
  assert.equal(hermesListShowsEnabled('enabled user 2.0.0 token-monitor-agent-state\n', 'token-monitor-agent-state'), true);
  assert.equal(hermesListShowsEnabled('disabled user 2.0.0 token-monitor-agent-state\n', 'token-monitor-agent-state'), false);
  assert.equal(hermesListShowsEnabled('token-monitor-agent-state enabled\n', 'token-monitor-agent-state'), true);
  assert.equal(hermesListShowsEnabled('token-monitor-agent-state disabled\n', 'token-monitor-agent-state'), false);
  assert.equal(hermesListShowsEnabled('enabled user 2.0.0 token-monitor-agent-state-extra\n', 'token-monitor-agent-state'), false);
});

test('copyTemplate dry-run and installs report byte-level idempotence', () => {
  const homeDir = tempRoot();
  const dest = path.join(homeDir, 'agent-event.js');
  let copied = copyTemplate('integrations/agent-lifecycle/agent-event.js', dest, { dryRun: true });
  assert.equal(copied.changed, true);
  copyTemplate('integrations/agent-lifecycle/agent-event.js', dest);
  copied = copyTemplate('integrations/agent-lifecycle/agent-event.js', dest, { dryRun: true });
  assert.equal(copied.changed, false);
  fs.appendFileSync(dest, '\n');
  copied = copyTemplate('integrations/agent-lifecycle/agent-event.js', dest, { dryRun: true });
  assert.equal(copied.changed, true);
});

test('shared writer refuses unmanaged collisions and backs up managed changes', () => {
  const homeDir = tempRoot();
  const dest = path.join(homeDir, 'agent-event.js');
  fs.writeFileSync(dest, 'console.log("mine");\n');
  const dryCollision = ensureWriter({ writerPath: dest, dryRun: true });
  assert.equal(dryCollision.ok, false);
  assert.equal(dryCollision.code, 'unmanaged_collision');
  assert.equal(fs.readdirSync(homeDir).some((name) => name.includes('.bak.')), false);
  assert.equal(installClaudeLifecycle({ homeDir, writerPath: dest, dryRun: true }).code, 'unmanaged_collision');
  assert.equal(installCodexLifecycle({ homeDir, writerPath: dest, codexVersion: '0.150.1', dryRun: true }).code, 'unmanaged_collision');

  fs.writeFileSync(dest, '// token-monitor-agent-lifecycle:v1\nconsole.log("old");\n');
  const planned = ensureWriter({ writerPath: dest, dryRun: true, nowMs: NOW });
  assert.equal(planned.ok, true);
  assert.equal(planned.changed, true);
  assert.equal(fs.readdirSync(homeDir).some((name) => name.includes('.bak.')), false);
  const installed = ensureWriter({ writerPath: dest, nowMs: NOW });
  assert.equal(installed.ok, true);
  assert.equal(installed.changed, true);
  assert.match(installed.backup, /\.bak\./);
  assert.equal(fs.readdirSync(homeDir).filter((name) => name.includes('.bak.')).length, 1);
  const second = ensureWriter({ writerPath: dest, nowMs: NOW });
  assert.equal(second.changed, false);
  assert.equal(fs.readdirSync(homeDir).filter((name) => name.includes('.bak.')).length, 1);
});

test('actual-platform writer accepts os.tmpdir destinations on macOS', { skip: process.platform !== 'darwin' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-agent-life-darwin-writer-'));
  const dest = path.join(root, 'agent-event.js');

  const result = ensureWriter({ writerPath: dest });

  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(dest), true);
});

test('actual-platform Codex config under os.tmpdir reports TOML errors on macOS', { skip: process.platform !== 'darwin' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-agent-life-darwin-config-'));
  const configPath = path.join(root, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, 'invalid toml\n');

  const result = installCodexLifecycle({
    homeDir: root,
    codexConfigPath: configPath,
    codexVersion: '0.150.1',
    stateRoot: path.join(root, 'state')
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid_toml');
});

test('shared writer and Claude/Codex config paths fail cleanly on unsafe destination types', (t) => {
  const homeDir = tempRoot();
  const writerDir = path.join(homeDir, 'agent-event.js');
  fs.mkdirSync(writerDir);
  const writer = ensureWriter({ writerPath: writerDir, dryRun: true });
  assert.equal(writer.ok, false);
  assert.equal(writer.code, 'unsafe_destination');

  const claudeSettingsPath = path.join(homeDir, '.claude', 'settings.json');
  fs.mkdirSync(claudeSettingsPath, { recursive: true });
  const claude = installClaudeLifecycle({ homeDir, claudeSettingsPath, stateRoot: path.join(homeDir, 'state') });
  assert.equal(claude.ok, false);
  assert.equal(claude.code, 'unsafe_destination');
  const claudeDoctor = doctorAgentLifecycle({ harnesses: ['claude'], homeDir, claudeSettingsPath, stateRoot: path.join(homeDir, 'state') });
  assert.equal(claudeDoctor.ok, false);
  assert.equal(claudeDoctor.results[0].settingsOk, false);
  assert.equal(claudeDoctor.results[0].code, 'unsafe_destination');

  const codexConfigPath = path.join(homeDir, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(codexConfigPath), { recursive: true });
  const target = path.join(homeDir, 'codex-target.toml');
  fs.writeFileSync(target, '# >>> token-monitor-agent-lifecycle:v1\n');
  if (!makeFileSymlink(t, target, codexConfigPath)) return;
  const codex = installCodexLifecycle({ homeDir, codexConfigPath, codexVersion: '0.150.1', stateRoot: path.join(homeDir, 'state') });
  assert.equal(codex.ok, false);
  assert.equal(codex.code, 'unsafe_destination');
  const codexDoctor = doctorAgentLifecycle({ harnesses: ['codex'], homeDir, codexConfigPath, codexVersion: '0.150.1', stateRoot: path.join(homeDir, 'state') });
  assert.equal(codexDoctor.ok, false);
  assert.equal(codexDoctor.results[0].configOk, false);
  assert.equal(codexDoctor.results[0].code, 'unsafe_destination');
});

test('install gates exact adapters on detected or explicit support unless forced', () => {
  const homeDir = tempRoot();
  const unavailable = () => ({ status: 127, stdout: '', stderr: 'missing', error: Object.assign(new Error('missing'), { code: 'ENOENT' }) });
  assert.equal(installCodexLifecycle({ homeDir, commandRunner: unavailable }).ok, false);
  assert.equal(installCodexLifecycle({ homeDir, codexVersion: '0.1.0', commandRunner: unavailable }).code, 'codex_unsupported');
  const forced = installCodexLifecycle({ homeDir, codexVersion: '0.1.0', forceUnsupported: true, commandRunner: unavailable });
  assert.equal(forced.ok, true);
  assert.equal(forced.forced, true);

  const detected = installOpenCodeLifecycle({
    opencodeConfigDir: path.join(homeDir, 'oc-auto'),
    commandRunner: (command, args) => {
      assert.equal(command, 'opencode');
      assert.deepEqual(args, ['--version']);
      return { status: 0, stdout: 'opencode 1.18.18\n', stderr: '' };
    }
  });
  assert.equal(detected.ok, true);
  assert.equal(detected.version, '1.18.18');
});

test('dry-run install still probes versions and refuses unavailable adapters unless forced', () => {
  const homeDir = tempRoot();
  const calls = [];
  const unavailable = (command, args) => {
    calls.push([command, args]);
    return { status: 127, stdout: '', stderr: 'missing', error: Object.assign(new Error('missing'), { code: 'ENOENT' }) };
  };
  const refused = installCodexLifecycle({ homeDir, dryRun: true, commandRunner: unavailable });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'codex_unsupported');
  assert.deepEqual(calls, [['codex', ['--version']]]);
  assert.equal(installOpenCodeLifecycle({ opencodeConfigDir: path.join(homeDir, 'oc-refused'), dryRun: true, commandRunner: unavailable }).code, 'opencode_unsupported');
  assert.equal(installHermesLifecycle({ hermesHome: path.join(homeDir, '.hermes-refused'), dryRun: true, commandRunner: unavailable }).code, 'hermes_unsupported');

  const forced = installOpenCodeLifecycle({
    opencodeConfigDir: path.join(homeDir, 'oc-forced'),
    dryRun: true,
    forceUnsupported: true,
    commandRunner: unavailable
  });
  assert.equal(forced.ok, true);
  assert.equal(forced.forced, true);
  assert.equal(fs.existsSync(path.join(homeDir, 'oc-forced')), false);
});

test('Hermes dry-run probes version but does not enable plugins or write files', () => {
  const homeDir = tempRoot();
  const hermesHome = path.join(homeDir, '.hermes');
  const calls = [];
  const dry = installHermesLifecycle({
    hermesHome,
    profiles: ['default'],
    dryRun: true,
    commandRunner: (command, args) => {
      calls.push([command, args]);
      return { status: 0, stdout: 'hermes 0.20.5\n', stderr: '' };
    }
  });
  assert.equal(dry.ok, true);
  assert.deepEqual(calls, [['hermes', ['--version']]]);
  assert.equal(fs.existsSync(hermesHome), false);
  assert.equal(dry.results[0].command.dryRun, true);
});

test('Hermes doctor lists enabled plugin and runs import diagnostics with discovered venv python', () => {
  const homeDir = tempRoot();
  const hermesHome = path.join(homeDir, '.hermes');
  const stateRoot = path.join(homeDir, 'state');
  const calls = [];
  const installRunner = (command, args) => {
    calls.push([command, args]);
    return { status: 0, stdout: '', stderr: '' };
  };
  assert.equal(installHermesLifecycle({ hermesHome, profiles: ['default', 'research'], hermesVersion: '0.20.5', commandRunner: installRunner, stateRoot }).ok, true);
  const python = path.join(hermesHome, 'venv', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python');
  fs.mkdirSync(path.dirname(python), { recursive: true });
  fs.writeFileSync(python, '');
  const doctorRunner = (command, args) => {
    calls.push([command, args]);
    if (command === 'hermes') return { status: 0, stdout: 'enabled user 2.0.0 token-monitor-agent-state\nenabled user 2.0.0 herdr-agent-state\n', stderr: '' };
    assert.equal(command, python);
    assert.equal(path.basename(args[0]), 'diagnostics.py');
    return { status: 0, stdout: JSON.stringify({ ok: true, declaredHooks: HERMES_HOOKS }) };
  };
  const doctor = doctorAgentLifecycle({ harnesses: ['hermes'], hermesHome, profiles: ['default', 'research'], hermesVersion: '0.20.5', commandRunner: doctorRunner, stateRoot });
  assert.equal(doctor.ok, true);
  assert.equal(doctor.results.length, 2);
  assert.equal(doctor.results.every((result) => result.capability === 'exact' && result.listedEnabled && result.diagnostic.ok), true);
  assert.equal(doctor.results.every((result) => result.configuredRoot === stateRoot && result.configuredRootMatches), true);
  assert.deepEqual(calls.filter((call) => call[0] === 'hermes' && call[1].includes('list')).map((call) => call[1]), [
    ['plugins', 'list', '--plain', '--no-bundled'],
    ['--profile', 'research', 'plugins', 'list', '--plain', '--no-bundled']
  ]);

  const mismatch = doctorAgentLifecycle({ harnesses: ['hermes'], hermesHome, profiles: ['default'], hermesVersion: '0.20.5', commandRunner: doctorRunner, stateRoot: path.join(homeDir, 'other-state') });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.results[0].configuredRootMatches, false);
});

test('configured adapter state roots reject unsafe values', () => {
  const homeDir = tempRoot();
  assert.equal(installOpenCodeLifecycle({
    opencodeConfigDir: path.join(homeDir, 'oc'),
    opencodeVersion: '1.18.25',
    stateRoot: `bad\n${homeDir}`
  }).code, 'invalid_state_root');
  assert.equal(installHermesLifecycle({
    hermesHome: path.join(homeDir, '.hermes'),
    hermesVersion: '0.20.5',
    stateRoot: 'x'.repeat(4097),
    commandRunner: () => ({ status: 0, stdout: '', stderr: '' })
  }).code, 'invalid_state_root');
  assert.equal(doctorAgentLifecycle({ harnesses: ['opencode'], stateRoot: 'bad\0root' }).code, 'invalid_state_root');
});

test('doctor reports unknown harnesses as failed results', () => {
  const result = doctorAgentLifecycle({ harnesses: ['typo'], stateRoot: path.join(tempRoot(), 'state') });
  assert.equal(result.ok, false);
  assert.deepEqual(result.results, [{ ok: false, harness: 'typo', code: 'unknown_harness' }]);
});

test('Hermes import diagnostic accepts live valid hook supersets', (t) => {
  const result = runInstalledHermesDiagnostic(t, {
    validHooks: [...HERMES_HOOKS, 'on_session_activate']
  });
  if (!result) return;
  assert.equal(result.run.status, 0, result.run.stderr);
  assert.equal(result.output.ok, true);
  assert.equal(result.output.adapterHooksPresent, true);
  assert.equal(result.output.registeredTools, 0);
  assert.deepEqual(result.output.declaredHooks, HERMES_HOOKS);
  assert.deepEqual(result.output.manifestHooks, HERMES_HOOKS);
  assert.deepEqual(result.output.registeredHooks, HERMES_HOOKS);
  assert.deepEqual(result.output.extraLiveHooks, ['on_session_activate']);
});

test('Hermes import diagnostic rejects missing live adapter hooks', (t) => {
  const missing = HERMES_HOOKS.at(-1);
  const result = runInstalledHermesDiagnostic(t, {
    validHooks: HERMES_HOOKS.filter((hook) => hook !== missing)
  });
  if (!result) return;
  assert.equal(result.run.status, 1);
  assert.equal(result.output.ok, false);
  assert.equal(result.output.adapterHooksPresent, false);
  assert.deepEqual(result.output.missingFromLive, [missing]);
});

test('Hermes import diagnostic rejects plugin declared and registered hook mismatch', (t) => {
  const result = runInstalledHermesDiagnostic(t, {
    validHooks: [...HERMES_HOOKS, 'on_session_activate'],
    mutate: (pluginDir) => {
      const initPath = path.join(pluginDir, '__init__.py');
      const source = fs.readFileSync(initPath, 'utf8');
      fs.writeFileSync(initPath, source.replace('for hook_name in HERMES_HOOKS:', 'for hook_name in HERMES_HOOKS[:-1]:'));
    }
  });
  if (!result) return;
  assert.equal(result.run.status, 1);
  assert.equal(result.output.ok, false);
  assert.equal(result.output.manifestMatchesDeclared, true);
  assert.equal(result.output.registeredMatchesDeclared, false);
  assert.deepEqual(result.output.registeredHooks, HERMES_HOOKS.slice(0, -1));
});

test('Node Hermes doctor import accepts diagnostics with live valid hook supersets', () => {
  const homeDir = tempRoot();
  const pluginDir = path.join(homeDir, 'plugins', 'token-monitor-agent-state');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'diagnostics.py'), 'print("stub")\n');
  const result = runDoctorHermesImport({
    pluginDir,
    python: 'python',
    commandRunner: () => ({
      status: 0,
      stdout: JSON.stringify({
        ok: true,
        declaredHooks: HERMES_HOOKS,
        manifestHooks: HERMES_HOOKS,
        registeredHooks: HERMES_HOOKS,
        registeredTools: 0,
        adapterHooksPresent: true,
        extraLiveHooks: ['on_session_activate']
      }),
      stderr: ''
    })
  });
  assert.equal(result.ok, true);
  assert.equal(result.hookSubset, true);
  assert.equal(result.registeredTools, 0);
});

test('Node Hermes doctor import rejects missing live hook diagnostics', () => {
  const homeDir = tempRoot();
  const pluginDir = path.join(homeDir, 'plugins', 'token-monitor-agent-state');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'diagnostics.py'), 'print("stub")\n');
  const result = runDoctorHermesImport({
    pluginDir,
    python: 'python',
    commandRunner: () => ({
      status: 1,
      stdout: JSON.stringify({
        ok: false,
        declaredHooks: HERMES_HOOKS,
        manifestHooks: HERMES_HOOKS,
        registeredHooks: HERMES_HOOKS,
        registeredTools: 0,
        adapterHooksPresent: false,
        missingFromLive: [HERMES_HOOKS.at(-1)]
      }),
      stderr: ''
    })
  });
  assert.equal(result.ok, false);
  assert.equal(result.hookSubset, false);
});

test('Node Hermes doctor import rejects undeclared hooks and tools', () => {
  const homeDir = tempRoot();
  const pluginDir = path.join(homeDir, 'plugins', 'token-monitor-agent-state');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'diagnostics.py'), 'print("stub")\n');
  const result = runDoctorHermesImport({
    pluginDir,
    python: 'python',
    commandRunner: () => ({
      status: 0,
      stdout: JSON.stringify({
        ok: true,
        declaredHooks: HERMES_HOOKS,
        manifestHooks: HERMES_HOOKS,
        registeredHooks: [...HERMES_HOOKS, 'on_session_activate'],
        registeredTools: 1,
        adapterHooksPresent: true
      }),
      stderr: ''
    })
  });
  assert.equal(result.ok, false);
  assert.equal(result.registeredMatchesDeclared, false);
  assert.equal(result.registeredTools, 1);
});

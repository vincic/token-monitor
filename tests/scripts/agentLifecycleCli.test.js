'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const test = require('node:test');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tm-agent-life-cli-'));
}

test('agent-lifecycle CLI installs, doctors and uninstalls against temp HOME', () => {
  const home = tempRoot();
  const stateRoot = path.join(home, 'state');
  const script = path.join(process.cwd(), 'scripts', 'agent-lifecycle.js');
  const install = childProcess.spawnSync(process.execPath, [script, 'install', '--harness', 'opencode', '--home', home, '--state-root', stateRoot, '--opencode-version', '1.18.25', '--json'], { encoding: 'utf8' });
  assert.equal(install.status, 0);
  assert.equal(fs.existsSync(path.join(home, '.config', 'opencode', 'plugins', 'token-monitor-agent-state.js')), true);

  const doctor = childProcess.spawnSync(process.execPath, [script, 'doctor', '--harness', 'opencode', '--home', home, '--state-root', stateRoot, '--opencode-version', '1.18.25', '--json'], { encoding: 'utf8' });
  assert.equal(doctor.status, 0);

  const uninstall = childProcess.spawnSync(process.execPath, [script, 'uninstall', '--harness', 'opencode', '--home', home, '--json'], { encoding: 'utf8' });
  assert.equal(uninstall.status, 0);
  assert.equal(fs.existsSync(path.join(home, '.config', 'opencode', 'plugins', 'token-monitor-agent-state.js')), false);
});

test('agent-lifecycle test uses singular harness and profile flags in snapshots', () => {
  const home = tempRoot();
  const stateRoot = path.join(home, 'state');
  const script = path.join(process.cwd(), 'scripts', 'agent-lifecycle.js');
  const run = childProcess.spawnSync(process.execPath, [script, 'test', '--harness', 'claude', '--profile', 'work', '--state-root', stateRoot, '--json'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const state = run.stdout
    ? JSON.parse(run.stdout).record.state
    : JSON.parse(fs.readFileSync(path.join(stateRoot, fs.readdirSync(stateRoot)[0]), 'utf8')).state;
  assert.equal(state.harness, 'claude');
  assert.equal(state.profile, 'work');
  assert.equal(state.event, 'heartbeat');
  assert.equal(state.fidelity, 'exact');
  assert.equal(Object.hasOwn(state, 'deviceId'), false);
});

test('agent-lifecycle test refuses multiple harnesses or profiles clearly', (t) => {
  const script = path.join(process.cwd(), 'scripts', 'agent-lifecycle.js');
  const multipleHarnesses = childProcess.spawnSync(process.execPath, [script, 'test', '--harness', 'claude', '--harness', 'codex', '--json'], { encoding: 'utf8' });
  if (multipleHarnesses.error?.code === 'EPERM' && !multipleHarnesses.stdout) {
    t.skip('sandbox suppressed child process stdout');
    return;
  }
  assert.equal(multipleHarnesses.status, 1);
  assert.equal(JSON.parse(multipleHarnesses.stdout).code, 'multiple_harnesses_unsupported');

  const multipleProfiles = childProcess.spawnSync(process.execPath, [script, 'test', '--profile', 'work', '--profile', 'personal', '--json'], { encoding: 'utf8' });
  assert.equal(multipleProfiles.status, 1);
  assert.equal(JSON.parse(multipleProfiles.stdout).code, 'multiple_profiles_unsupported');
});

test('agent-lifecycle doctor reports unknown harness and exits nonzero', (t) => {
  const home = tempRoot();
  const script = path.join(process.cwd(), 'scripts', 'agent-lifecycle.js');
  const run = childProcess.spawnSync(process.execPath, [script, 'doctor', '--harness', 'typo', '--home', home, '--state-root', path.join(home, 'state'), '--json'], { encoding: 'utf8' });
  if (run.error?.code === 'EPERM' && !run.stdout) {
    t.skip('sandbox suppressed child process stdout');
    return;
  }
  assert.equal(run.status, 1);
  const body = JSON.parse(run.stdout);
  assert.equal(body.ok, false);
  assert.deepEqual(body.results, [{ ok: false, harness: 'typo', code: 'unknown_harness' }]);
});

test('agent-lifecycle CLI returns nonzero JSON for unsafe config paths', (t) => {
  const home = tempRoot();
  const script = path.join(process.cwd(), 'scripts', 'agent-lifecycle.js');
  const settingsPath = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(settingsPath, { recursive: true });
  const run = childProcess.spawnSync(process.execPath, [
    script,
    'install',
    '--harness',
    'claude',
    '--home',
    home,
    '--claude-settings',
    settingsPath,
    '--state-root',
    path.join(home, 'state'),
    '--json'
  ], { encoding: 'utf8' });
  if (run.error?.code === 'EPERM' && !run.stdout) {
    t.skip('sandbox suppressed child process stdout');
    return;
  }
  assert.equal(run.status, 1);
  const body = JSON.parse(run.stdout);
  assert.equal(Array.isArray(body), true);
  assert.equal(body[0].ok, false);
  assert.equal(body[0].code, 'unsafe_destination');
  assert.equal(run.stderr, '');
});

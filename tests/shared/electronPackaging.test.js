'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('Electron package excludes Python bytecode from integrations', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
  assert.ok(pkg.build.files.includes('integrations/**/*'));
  assert.ok(pkg.build.files.includes('!integrations/**/__pycache__/**'));
  assert.ok(pkg.build.files.includes('!integrations/**/*.pyc'));
  const hermesSettings = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'integrations', 'hermes', 'token-monitor-agent-state', 'settings.json'), 'utf8'));
  assert.equal(hermesSettings.tokenMonitorManaged, 'token-monitor-agent-lifecycle:v1');
  assert.equal(hermesSettings.stateRoot, '');
});

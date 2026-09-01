'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const mainSource = fs.readFileSync(path.join(root, 'src/electron/main.js'), 'utf8');
const rendererSource = fs.readFileSync(path.join(root, 'src/electron/renderer/app.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(root, 'src/electron/renderer/index.html'), 'utf8');
const i18nSource = fs.readFileSync(path.join(root, 'src/electron/renderer/i18n.js'), 'utf8');

test('main process keeps SidePulse disabled by default and macOS-gated', () => {
  assert.match(mainSource, /sidepulseEnabled: parseBoolean\(process\.env\.TOKEN_MONITOR_SIDEPULSE_ENABLED, false\)/);
  assert.match(mainSource, /sidepulseSocketPath: normalizeSidePulseSocketPath\(process\.env\.TOKEN_MONITOR_SIDEPULSE_SOCKET\)/);
  assert.match(mainSource, /return process\.platform === 'darwin' && settings\?\.sidepulseEnabled === true;/);
});

test('authenticated raw stats feed SidePulse before renderer overlays', () => {
  assert.match(mainSource, /setLatestHubStatsCache\(parsed\.data\.stats, 'client'[\s\S]*ingestSidePulseStats\(parsed\.data\.stats\);[\s\S]*composeLocalSyncStats/);
  assert.match(mainSource, /if \(!options\.skipSidePulse\) ingestSidePulseStats\(latestStats\);[\s\S]*const visibleStats = electronPresentationStats\(latestStats\);/);
  assert.match(mainSource, /skipSidePulse: true/);
});

test('renderer exposes localized SidePulse settings controls', () => {
  for (const id of ['sidepulseEnabledInput', 'sidepulseSocketInput', 'sidepulseStatus']) {
    assert.match(htmlSource, new RegExp(`id="${id}"`));
    assert.match(rendererSource, new RegExp(`${id}: document\\.getElementById\\('${id}'\\)`));
  }
  assert.match(rendererSource, /saveSettings\(\{ sidepulseEnabled: els\.sidepulseEnabledInput\.checked \}\)/);
  assert.match(rendererSource, /saveSettings\(\{ sidepulseSocketPath: els\.sidepulseSocketInput\.value\.trim\(\) \}\)/);
  assert.equal((i18nSource.match(/settings\.sidepulse\.title/g) || []).length, 5);
});

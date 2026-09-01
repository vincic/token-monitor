#!/usr/bin/env node
'use strict';

const path = require('node:path');
const {
  doctorAgentLifecycle,
  installAgentLifecycle,
  testAgentLifecycle,
  uninstallAgentLifecycle
} = require('../src/shared/agentLifecycleAdapters');

function parseArgs(argv) {
  const options = { harnesses: [], profiles: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index] || '';
    if (arg === '--harness') options.harnesses.push(next());
    else if (arg === '--profile') options.profiles.push(next());
    else if (arg === '--home') options.homeDir = path.resolve(next());
    else if (arg === '--state-root') options.stateRoot = path.resolve(next());
    else if (arg === '--writer-path') options.writerPath = path.resolve(next());
    else if (arg === '--hermes-home') options.hermesHome = path.resolve(next());
    else if (arg === '--opencode-config-dir') options.opencodeConfigDir = path.resolve(next());
    else if (arg === '--claude-settings') options.claudeSettingsPath = path.resolve(next());
    else if (arg === '--codex-config') options.codexConfigPath = path.resolve(next());
    else if (arg === '--version') options.version = next();
    else if (arg === '--codex-version') options.codexVersion = next();
    else if (arg === '--opencode-version') options.opencodeVersion = next();
    else if (arg === '--hermes-version') options.hermesVersion = next();
    else if (arg === '--force-unsupported') options.forceUnsupported = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--json') options.json = true;
  }
  if (options.harnesses.length === 1) options.harness = options.harnesses[0];
  if (!options.harnesses.length) delete options.harnesses;
  if (options.profiles.length === 1) options.profile = options.profiles[0];
  if (!options.profiles.length) delete options.profiles;
  return options;
}

function printResult(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const rows = Array.isArray(result) ? result : (result.results || [result]);
  for (const row of rows) {
    process.stdout.write(`${row.harness || 'agent-lifecycle'}: ${row.ok === false ? 'failed' : 'ok'}${row.code ? ` (${row.code})` : ''}\n`);
  }
}

function usage() {
  process.stderr.write('Usage: npm run agent-lifecycle -- <install|uninstall|doctor|test> [--harness name] [--profile name] [--home dir] [--state-root dir] [--force-unsupported] [--dry-run] [--json]\n');
}

function main() {
  const command = process.argv[2];
  const options = parseArgs(process.argv.slice(3));
  let result;
  try {
    if (command === 'test' && options.harnesses?.length > 1) {
      result = { ok: false, code: 'multiple_harnesses_unsupported', message: 'test accepts at most one --harness value' };
    } else if (command === 'test' && options.profiles?.length > 1) {
      result = { ok: false, code: 'multiple_profiles_unsupported', message: 'test accepts at most one --profile value' };
    } else if (command === 'install') result = installAgentLifecycle(options);
    else if (command === 'uninstall') result = uninstallAgentLifecycle(options);
    else if (command === 'doctor') result = doctorAgentLifecycle(options);
    else if (command === 'test') result = testAgentLifecycle(options);
    else {
      usage();
      process.exitCode = 2;
      return;
    }
  } catch (error) {
    result = { ok: false, code: 'uncaught_exception', message: error.message };
  }
  printResult(result, options.json);
  const failed = Array.isArray(result) ? result.some((item) => item.ok === false) : result.ok === false;
  if (failed) process.exitCode = 1;
}

main();

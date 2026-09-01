#!/usr/bin/env node
'use strict';

const childProcess = require('node:child_process');
const readline = require('node:readline');

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 30000;
const MAX_CWDS = 16;
const MAX_CWD_CHARS = 4096;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

function parseArgs(argv) {
  const options = { codexCommand: 'codex', cwds: [], timeoutMs: DEFAULT_TIMEOUT_MS };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index] || '';
    if (arg === '--codex-command') options.codexCommand = next();
    else if (arg === '--cwd') options.cwds.push(next());
    else if (arg === '--timeout-ms') options.timeoutMs = Number(next());
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) options.timeoutMs = DEFAULT_TIMEOUT_MS;
  options.timeoutMs = Math.min(Math.max(Math.trunc(options.timeoutMs), 100), MAX_TIMEOUT_MS);
  options.codexCommand = typeof options.codexCommand === 'string' && options.codexCommand.trim()
    ? options.codexCommand.trim()
    : 'codex';
  options.cwds = options.cwds
    .filter((cwd) => typeof cwd === 'string' && cwd && !cwd.includes('\0'))
    .map((cwd) => cwd.slice(0, MAX_CWD_CHARS))
    .slice(0, MAX_CWDS);
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  let child;
  let finished = false;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let timer;

  const finish = (result) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    if (child && !child.killed) child.kill('SIGTERM');
    if (child?.stdin) child.stdin.destroy();
    if (child?.stdout) child.stdout.destroy();
    if (child?.stderr) child.stderr.destroy();
    process.stdout.write(`${JSON.stringify(result)}\n`, () => {
      process.exit(result.ok === false ? 1 : 0);
    });
  };

  const fail = (code, reason) => {
    finish({ ok: false, code, reason: String(reason || code).slice(0, 512) });
  };

  const send = (message) => {
    if (!child || child.stdin.destroyed) return false;
    try {
      return child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      fail('codex_app_server_stdin_failed', error.message);
      return false;
    }
  };

  try {
    child = childProcess.spawn(options.codexCommand, ['app-server', '--stdio'], {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch (error) {
    fail('codex_app_server_unavailable', error.message);
    return;
  }

  timer = setTimeout(() => fail('codex_app_server_timeout', 'Codex app-server hooks/list timed out.'), options.timeoutMs);

  const shutdown = () => {
    if (finished) return;
    fail('interrupted', 'Codex hook trust discovery was interrupted.');
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  child.once('error', (error) => fail('codex_app_server_unavailable', error.message));
  child.stdin.on('error', (error) => fail('codex_app_server_stdin_failed', error.message));
  child.stdout.on('data', (chunk) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > MAX_STDOUT_BYTES && !finished) {
      fail('codex_app_server_stdout_limit', 'Codex app-server stdout exceeded the response limit.');
    }
  });
  child.once('close', (code) => {
    if (!finished) fail('codex_app_server_closed', `Codex app-server closed before hooks/list completed (${code ?? 'unknown'}).`);
  });
  child.stderr.on('data', (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes > MAX_STDERR_BYTES && !finished) {
      fail('codex_app_server_stderr_limit', 'Codex app-server stderr exceeded the diagnostic limit.');
    }
  });

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  let initialized = false;
  rl.on('line', (line) => {
    if (finished) return;
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
      fail('codex_app_server_response_too_large', 'Codex app-server returned an oversized response line.');
      return;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch (_) {
      return;
    }
    if (!message || typeof message !== 'object') return;
    if (message.id === 1 && !initialized) {
      initialized = true;
      send({ jsonrpc: '2.0', method: 'initialized', params: {} });
      send({ jsonrpc: '2.0', id: 2, method: 'hooks/list', params: { cwds: options.cwds } });
      return;
    }
    if (message.id !== 2) return;
    if (message.error) {
      fail('codex_app_server_error', message.error.message || message.error.code || 'Codex app-server hooks/list failed.');
      return;
    }
    finish({ ok: true, result: message.result || {} });
  });

  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      clientInfo: { name: 'SidePulse Token Monitor', version: '2.0.0' },
      capabilities: null
    }
  });
}

main();

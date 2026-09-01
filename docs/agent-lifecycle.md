# Agent lifecycle adapters

Token Monitor can collect short-lived lifecycle state from local agent harnesses and merge it with the existing device record.

## Privacy and schema

Adapters write schema version 1 raw snapshots into the local agent state directory. Accepted snapshot fields are limited to:

```text
schemaVersion, harness, profile, sessionId, event, toolName, surface, adapterVersion, observedAt, fidelity
```

The adapters must not write prompts, messages, transcript paths, working directories, tool arguments, tool results, approval details, emails, credentials, `mode`, or `deviceId`. The runtime normalizes and hash-scopes raw `sessionId` values on read. On the wire, `sessionId` is only a `sha256:` opaque value scoped by harness and profile.

The optional macOS SidePulse output consumes only authenticated aggregate `stats.agentActivity.states`. It never reads usage sessions and never forwards prompts, messages, project names, paths, tool arguments, tool results, provider account ids, emails, or credentials. The SidePulse `session_id` is a deterministic Token Monitor hash over device, harness, profile, and the already-opaque lifecycle session id, so sessions remain distinct across devices and profiles without exposing the raw provider identity.

Enable it from the widget settings or with:

```bash
TOKEN_MONITOR_SIDEPULSE_ENABLED=1
TOKEN_MONITOR_SIDEPULSE_SOCKET=~/.local/state/sidepulse/agent-monitor/events.sock
```

It sends one JSON message to the SidePulse Unix socket and closes the connection. Token Monitor never writes LED files directly. Run it as a canary alongside existing direct SidePulse hooks first; after SidePulse shows the same transitions from Token Monitor, uninstall the direct hooks to avoid duplicate events. Rollback is disabling `SidePulse output` or setting `TOKEN_MONITOR_SIDEPULSE_ENABLED=0`, then restoring direct hooks if you removed them.

State files are written under the existing safe state root with a 0700 directory, 0600 temporary files, atomic rename, and 64-hex hashed filenames. Hook subprocesses fail open, produce no stdout, cap native input at 1 MiB, and reject malformed JSON or missing identity.

Supported common events are:

```text
session_started, session_resumed, turn_started, tool_started, tool_finished,
approval_requested, approval_resolved, turn_completed, session_ended, error,
heartbeat
```

## CLI

Use the project script:

```bash
npm run agent-lifecycle -- doctor --json
npm run agent-lifecycle -- install --harness claude
npm run agent-lifecycle -- uninstall --harness claude
npm run agent-lifecycle -- test --state-root /tmp/token-monitor-agent-state
```

Every command accepts explicit test and fleet paths:

```bash
npm run agent-lifecycle -- install --harness codex --home /tmp/home --state-root /tmp/state --dry-run
npm run agent-lifecycle -- install --harness opencode --opencode-config-dir /tmp/opencode --state-root /tmp/state
npm run agent-lifecycle -- install --harness hermes --hermes-home /tmp/hermes --profile default --profile research
```

Installers create timestamped backups before changing existing configuration. Managed files and config entries include the `token-monitor-agent-lifecycle:v1` ownership signature. Uninstall removes only entries or plugin directories carrying that signature. Unmanaged destination collisions are refused.

Claude and Codex share one stable writer at the Token Monitor agent-lifecycle path. A managed but different writer is backed up before replacement; an unmanaged file at that destination is refused, including during dry-run. Harness uninstall leaves the shared writer in place because the other harness may still reference it. Do not remove the shared writer unless a dedicated cleanup command first proves no managed Claude or Codex configuration still points at it.

Install and doctor auto-detect Codex, OpenCode, and Hermes versions with `<command> --version` when a version flag is not supplied. Unknown or unverified exact adapters are refused by default. Use `--force-unsupported` only for a deliberately tested local fleet override; forced installs are reported as such. Claude remains configuration-based.

## Claude Code

Claude Code integration merges managed hook entries into `~/.claude/settings.json` and preserves unrelated hooks. Existing SidePulse hooks are left in place for canary runs. Uninstall removes only Token Monitor managed entries.

Mapped events:

```text
SessionStart -> session_started
UserPromptSubmit -> turn_started
PreToolUse -> tool_started
PostToolUse -> tool_finished
PostToolUseFailure -> error only on explicit terminal failure, otherwise tool_finished
PermissionRequest -> approval_requested
Stop -> turn_completed
SessionEnd -> session_ended
```

Permission resolution is recorded only when the native payload carries an explicit resolution fact.

## Codex

Codex integration writes a managed TOML hook block and preserves unrelated TOML. It ensures `[features] hooks = true` without duplicate `hooks` keys. Native hook tables are written only for supported versions in the current fleet range, Codex `0.139.0` through `0.150.1`; unsupported versions report `presence_only` capability instead of pretending exact lifecycle support.

Mapped events include:

```text
SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest,
Stop, PreCompact, PostCompact, SubagentStart, SubagentStop
```

`PreCompact` and `PostCompact` map to `heartbeat`. Trust refresh is reported by doctor tooling only; install does not silently bypass Codex trust.

## OpenCode

OpenCode installs a dependency-free native ESM plugin at:

```text
~/.config/opencode/plugins/token-monitor-agent-state.js
```

Use `--opencode-config-dir` for `OPENCODE_CONFIG_DIR` style layouts. The plugin exports the named async factory `TokenMonitorAgentState`, matching the OpenCode `1.18.18` and `1.18.25` plugin contract. It handles generic `event: async ({ event }) => ...` callbacks for:

```text
session.created, session.status, session.idle, session.error,
permission.asked, permission.replied
```

Tool execution uses dedicated plugin hooks:

```text
tool.execute.before, tool.execute.after
```

The plugin derives session identity from documented payload variants. If no session id is present, it emits nothing. Only the tool name is preserved. The default surface is `opencode`; `t3code` and `herdr` are used only when explicit environment or payload evidence is present.

## Hermes

Hermes installs the default profile plugin under `HERMES_HOME` and named profile plugins under the profile directory. Use repeated `--profile` flags:

```bash
npm run agent-lifecycle -- install --harness hermes --profile default --profile research
```

Profile names must be plain path segments; traversal is refused. The default profile directory is:

```text
~/.hermes/plugins/token-monitor-agent-state
```

Named profile directories are:

```text
~/.hermes/profiles/<profile>/plugins/token-monitor-agent-state
```

After copying the managed plugin, install enables it with the Hermes CLI:

```text
hermes plugins enable token-monitor-agent-state
hermes --profile <profile> plugins enable token-monitor-agent-state
```

Uninstall disables the plugin before removing the managed directory. Dry-run reports content changes but does not call Hermes. Doctor checks version support, managed ownership, `hermes plugins list` enabled state per profile, plugin diagnostics through discovered `venv/bin/python` / `.venv/bin/python`, and a synthetic state write.

Only hooks common to Hermes `0.19.0` and `0.20.5` are declared:

```text
on_session_start, on_session_reset, on_session_end, on_session_finalize,
pre_llm_call, post_llm_call, pre_tool_call, post_tool_call,
pre_approval_request, post_approval_response, api_request_error
```

`on_session_activate` is intentionally not declared. The plugin uses `ctx.profile_name`, durable session identity, safe surface, and tool name only. Missing session or profile emits nothing. Existing `herdr-agent-state` plugins are preserved.

## Capability fidelity

Doctor reports exact lifecycle capability for Claude, Codex, Hermes, and OpenCode only when the corresponding adapter and version checks pass. Antigravity and Copilot currently remain `presence_only` through existing source detection until stable hook APIs are proven; they cannot produce active, waiting, or blocked lifecycle LEDs. Herdr is origin/surface enrichment for OpenCode/Hermes, not its own harness adapter. Model providers such as Ollama, OpenRouter, DeepSeek, and other provider integrations are attribution only.

Presence-only clients do not synthesize lifecycle snapshots.

## Rollback

Run uninstall for the affected harness:

```bash
npm run agent-lifecycle -- uninstall --harness codex
npm run agent-lifecycle -- uninstall --harness hermes --profile default
```

If a manual rollback is needed, restore the timestamped `.bak.<timestamp>` file or directory next to the changed config/plugin. Do not remove SidePulse hooks as part of Token Monitor rollback unless you intentionally manage that integration separately.

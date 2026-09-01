import hashlib
import json
import os
import secrets
import time
from datetime import datetime, timezone
from pathlib import Path

ADAPTER_VERSION = "2.0.0"
HOOK_EVENTS = {
    "on_session_start": "session_started",
    "on_session_reset": "session_resumed",
    "on_session_end": "session_ended",
    "on_session_finalize": "session_ended",
    "pre_llm_call": "turn_started",
    "post_llm_call": "turn_completed",
    "pre_tool_call": "tool_started",
    "post_tool_call": "tool_finished",
    "pre_approval_request": "approval_requested",
    "post_approval_response": "approval_resolved",
    "api_request_error": "error",
}
HERMES_HOOKS = tuple(HOOK_EVENTS.keys())
MAX_PATH_CHARS = 4096


def _compact(value, limit=128):
    return value.strip()[:limit] if isinstance(value, str) else ""


def _get(obj, name):
    if isinstance(obj, dict):
        return obj.get(name)
    return getattr(obj, name, None)


def _first(*values):
    for value in values:
        text = _compact(value, 4096)
        if text:
            return text
    return ""


def _state_root():
    explicit = os.environ.get("TOKEN_MONITOR_AGENT_STATE_ROOT", "").strip()
    if _safe_path(explicit):
        return Path(explicit)
    configured = _configured_state_root()
    if configured:
        return Path(configured)
    home = Path.home()
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA") or home / "AppData" / "Local"
        return Path(base) / "Token Monitor" / "agent-state"
    return Path(os.environ.get("XDG_STATE_HOME") or home / ".local" / "state") / "token-monitor" / "agent-state"


def _safe_path(value):
    return isinstance(value, str) and bool(value) and len(value) <= MAX_PATH_CHARS and not any(char in value for char in "\0\r\n")


def _existing_path_components(target):
    path = Path(os.path.abspath(os.path.expanduser(os.fspath(target))))
    parts = []
    current = path.anchor
    if current:
        parts.append(Path(current))
    else:
        current = ""
    for part in path.parts[1:] if path.anchor else path.parts:
        current = os.path.join(str(current), part) if current else part
        parts.append(Path(current))
    return parts


def _validate_existing_ancestors(root):
    target = Path(os.path.abspath(os.path.expanduser(os.fspath(root))))
    for candidate in _existing_path_components(root):
        try:
            stat = candidate.lstat()
        except FileNotFoundError:
            continue
        except Exception:
            return False
        if os.path.islink(candidate):
            return False
        if candidate == target:
            return candidate.is_dir()
        if not candidate.is_dir():
            return False
    return True


def _root_is_safe(root):
    if not _validate_existing_ancestors(root):
        return False
    try:
        stat = root.lstat()
    except Exception:
        return False
    if os.path.islink(root) or not root.is_dir():
        return False
    if os.name == "nt":
        return True
    try:
        if hasattr(os, "getuid") and stat.st_uid != os.getuid():
            return False
        return (stat.st_mode & 0o077) == 0
    except Exception:
        return False


def _ensure_root(root):
    if not _validate_existing_ancestors(root):
        return False
    try:
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
    except Exception:
        return False
    return _root_is_safe(root)


def _write_text_exclusive(path, text):
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = os.open(path, flags, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            fd = None
            handle.write(text)
    finally:
        if fd is not None:
            os.close(fd)


def _temp_snapshot_path(root, filename):
    return root / f".{filename}.{os.getpid()}.{time.time_ns()}.{secrets.token_hex(16)}.tmp"


def _cleanup_legacy_snapshot_temps(root, filename):
    exact = f".{filename}.{os.getpid()}.tmp"
    prefix = f".{filename}.{os.getpid()}."
    try:
        entries = list(root.iterdir())
    except Exception:
        return
    for entry in entries:
        name = entry.name
        if name != exact and not (name.startswith(prefix) and name.endswith(".tmp") and name[len(prefix):-4].isdigit()):
            continue
        try:
            if entry.is_file() and not os.path.islink(entry):
                entry.unlink(missing_ok=True)
        except Exception:
            pass


def _configured_state_root():
    try:
        settings_path = Path(__file__).resolve().parent / "settings.json"
        data = json.loads(settings_path.read_text(encoding="utf-8"))
        root = data.get("stateRoot", "") if isinstance(data, dict) else ""
        return root if _safe_path(root) else ""
    except Exception:
        return ""


def session_id_from_payload(payload):
    session = _get(payload, "session") or {}
    return _first(
        _get(payload, "session_id"),
        _get(payload, "sessionId"),
        _get(payload, "sessionID"),
        _get(session, "id"),
        _get(session, "session_id"),
        _get(session, "sessionId"),
        _get(session, "sessionID"),
    )


def turn_id_from_payload(payload):
    turn = _get(payload, "turn") or _get(payload, "message") or _get(payload, "call") or {}
    return _first(
        _get(payload, "turn_id"),
        _get(payload, "turnId"),
        _get(payload, "turnID"),
        _get(turn, "id"),
        _get(turn, "turn_id"),
        _get(turn, "turnId"),
        _get(turn, "turnID"),
    )


def _tool(payload):
    tool = _get(payload, "tool") or {}
    return _first(_get(payload, "tool_name"), _get(payload, "toolName"), _get(tool, "name"), _get(tool, "id"))


def _surface(payload):
    return _first(_get(payload, "surface"), _get(payload, "origin"), _get(payload, "client"), "hermes")


def _failed(payload):
    status = str(_get(payload, "status") or _get(payload, "result") or _get(payload, "outcome") or "").lower()
    return bool(_get(payload, "error") or _get(payload, "failed") is True or _get(payload, "success") is False or status in {"error", "failed", "failure", "denied", "rejected"})


def _approval_event(payload):
    status = str(_get(payload, "status") or _get(payload, "result") or _get(payload, "outcome") or _get(payload, "decision") or "").lower()
    if _get(payload, "approved") is False or status in {"denied", "rejected", "blocked"}:
        return "error"
    return "approval_resolved"


def write_hook(hook_name, profile_name="", payload=None):
    try:
        payload = payload or {}
        event = HOOK_EVENTS.get(hook_name)
        if hook_name in {"post_llm_call", "post_tool_call"} and _failed(payload):
            event = "error"
        if hook_name == "post_approval_response":
            event = _approval_event(payload)
        sid = session_id_from_payload(payload)
        prof = _first(profile_name)
        if not sid or not prof or not event:
            return None
        harness = "hermes"
        session_key = "sha256:" + hashlib.sha256(f"{harness}\0{prof}\0{sid}".encode()).hexdigest()
        filename = hashlib.sha256(f"{harness}\0{prof}\0{session_key}".encode()).hexdigest() + ".json"
        root = _state_root()
        if not _ensure_root(root):
            return None
        state = {
            "schemaVersion": 1,
            "harness": harness,
            "profile": prof[:128],
            "sessionId": session_key,
            "event": event,
            "observedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "fidelity": "exact",
            "adapterVersion": ADAPTER_VERSION,
            "surface": _surface(payload),
        }
        tool = _tool(payload)
        if tool:
            state["toolName"] = tool[:128]
        target = root / filename
        try:
            existing = target.lstat()
            if os.path.islink(target) or not target.is_file():
                return None
        except FileNotFoundError:
            pass
        tmp = _temp_snapshot_path(root, filename)
        try:
            _write_text_exclusive(tmp, json.dumps({"storeVersion": 1, "state": state}) + "\n")
            tmp.replace(target)
            _cleanup_legacy_snapshot_temps(root, filename)
        finally:
            try:
                tmp.unlink(missing_ok=True)
            except Exception:
                pass
    except Exception:
        return None
    return None

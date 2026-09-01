from .bridge import HERMES_HOOKS, session_id_from_payload, turn_id_from_payload, write_hook


def _profile_name(ctx):
    value = getattr(ctx, "profile_name", "")
    if isinstance(value, str):
        return value.strip()[:128]
    return ""


def register(ctx):
    profile_name = _profile_name(ctx)
    turn_sessions = {}

    def make_callback(hook_name):
        def callback(**kwargs):
            try:
                payload = dict(kwargs or {})
                session_id = session_id_from_payload(payload)
                turn_id = turn_id_from_payload(payload)
                if session_id and turn_id:
                    turn_sessions[turn_id] = session_id
                elif turn_id and turn_id in turn_sessions:
                    payload["session_id"] = turn_sessions[turn_id]
                    session_id = turn_sessions[turn_id]
                write_hook(hook_name, profile_name=profile_name, payload=payload)
                if hook_name in {"on_session_end", "on_session_finalize"} and session_id:
                    stale = [key for key, value in turn_sessions.items() if value == session_id]
                    for key in stale:
                        turn_sessions.pop(key, None)
            except Exception:
                return None
            return None

        return callback

    for hook_name in HERMES_HOOKS:
        ctx.register_hook(hook_name, make_callback(hook_name))

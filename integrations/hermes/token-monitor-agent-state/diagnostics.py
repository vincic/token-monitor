import importlib.util
import json
import os
import sys
from pathlib import Path


def _live_valid_hooks(fallback):
    injected = os.environ.get("TOKEN_MONITOR_HERMES_VALID_HOOKS", "")
    if injected:
        return {item.strip() for item in injected.split(",") if item.strip()}
    for module_name in ("hermes.plugins", "hermes.plugin", "hermes.hooks"):
        try:
            module = __import__(module_name, fromlist=["VALID_HOOKS"])
            hooks = getattr(module, "VALID_HOOKS", None)
            if hooks:
                return set(hooks)
        except Exception:
            pass
    return set(fallback)


def _manifest_hooks(path):
    hooks = []
    in_hooks = False
    for raw in path.read_text(encoding="utf-8").splitlines():
        stripped = raw.strip()
        if stripped == "hooks:":
            in_hooks = True
            continue
        if in_hooks and stripped.startswith("- "):
            hooks.append(stripped[2:].strip())
            continue
        if in_hooks and stripped and not raw.startswith((" ", "\t")):
            break
    return hooks


class _FakeContext:
    profile_name = "diagnostic"

    def __init__(self):
        self.hooks = []
        self.tools = []

    def register_hook(self, hook_name, callback):
        self.hooks.append((hook_name, callback))

    def register_tool(self, *args, **kwargs):
        self.tools.append((args, kwargs))


root = Path(__file__).resolve().parent
init_path = root / "__init__.py"
manifest = _manifest_hooks(root / "plugin.yaml")
spec = importlib.util.spec_from_file_location(
    "token_monitor_agent_state_diagnostic",
    init_path,
    submodule_search_locations=[str(root)],
)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
ctx = _FakeContext()
register = getattr(module, "register", None)
if callable(register):
    register(ctx)
declared = list(getattr(module, "HERMES_HOOKS", ()))
registered = [name for name, _callback in ctx.hooks]
valid_hooks = _live_valid_hooks(manifest or declared)
adapter_hooks_present = set(registered).issubset(valid_hooks)
manifest_matches_declared = manifest == declared
registered_matches_declared = registered == declared
ok = (
    callable(register)
    and manifest_matches_declared
    and registered_matches_declared
    and adapter_hooks_present
    and len(ctx.tools) == 0
)
print(json.dumps({
    "ok": ok,
    "hasRegister": callable(register),
    "declaredHooks": declared,
    "manifestHooks": manifest,
    "registeredHooks": registered,
    "validHooks": sorted(valid_hooks),
    "registeredTools": len(ctx.tools),
    "manifestMatchesDeclared": manifest_matches_declared,
    "registeredMatchesDeclared": registered_matches_declared,
    "adapterHooksPresent": adapter_hooks_present,
    "missingFromLive": sorted(set(registered) - valid_hooks),
    "extraLiveHooks": sorted(valid_hooks - set(registered)),
}))
raise SystemExit(0 if ok else 1)

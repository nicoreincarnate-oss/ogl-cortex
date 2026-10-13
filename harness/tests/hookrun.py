"""Shared helper for the hook tests. Feeds PreToolUse JSON to a hook on stdin and returns its exit code.

Every run gets a fresh OGL_STATE_DIR and OGL_NO_BUS=1, so tests never write logs or bus events outside a temp dir.
"""
import json
import os
import subprocess
import sys
import tempfile

HOOKS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "hooks")


def bash(command, cwd=None):
    p = {"session_id": "test", "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": command}}
    if cwd:
        p["cwd"] = cwd
    return p


def tool(name, tool_input, cwd=None):
    p = {"session_id": "test", "hook_event_name": "PreToolUse", "tool_name": name, "tool_input": tool_input}
    if cwd:
        p["cwd"] = cwd
    return p


def run(hook, payload, env=None, args=(), cwd=None):
    """-> (exit code, stderr, stdout)."""
    state = tempfile.mkdtemp(prefix="ogl-test-state-")
    e = dict(os.environ, OGL_NO_BUS="1", OGL_STATE_DIR=state, CTX_AGENT_NAME="tester")
    e.pop("OGL_PENTEST_OVERRIDE", None)
    e.pop("CORTEX_PENTEST_OVERRIDE", None)
    e.update(env or {})
    raw = payload if isinstance(payload, str) else json.dumps(payload)
    r = subprocess.run([sys.executable, os.path.join(HOOKS, hook), *args], input=raw, capture_output=True,
                       text=True, env=e, cwd=cwd or tempfile.gettempdir(), timeout=60)
    return r.returncode, r.stderr, r.stdout


def check(name, hook, block, allow, env=None):
    """block / allow: lists of (label, payload[, extra env]). A block case must exit 2; an allow case must exit 0.
    Returns (block_pass, block_total, allow_pass, allow_total, failures)."""
    fails, bp, ap = [], 0, 0
    for case in block:
        label, payload, *extra = case
        code, err, _ = run(hook, payload, {**(env or {}), **(extra[0] if extra else {})})
        if code == 2:
            bp += 1
        else:
            fails.append(f"[{name}] MUST-BLOCK got exit {code}: {label} {err.strip()[:160]}")
    for case in allow:
        label, payload, *extra = case
        code, err, _ = run(hook, payload, {**(env or {}), **(extra[0] if extra else {})})
        if code == 0:
            ap += 1
        else:
            fails.append(f"[{name}] MUST-ALLOW got exit {code}: {label} {err.strip()[:160]}")
    return bp, len(block), ap, len(allow), fails


def report(name, result):
    bp, bt, ap, at, fails = result
    for f in fails:
        print(f)
    print(f"{name:<22} must-block {bp}/{bt}   must-allow {ap}/{at}   {'PASS' if not fails else 'FAIL'}")
    return not fails

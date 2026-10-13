# OGL Cortex compaction kit. Pattern adapted from Glitch Cat Club, 'Controlled Compaction'. See harness/README.md (Licences).
"""Shared helpers for the compaction hooks. Standard library only."""
import json
import os
import sys
from pathlib import Path

HOOKS = Path(__file__).parent


def config():
    return json.loads((HOOKS / "compaction.json").read_text(encoding="utf-8"))


def hook_input():
    return json.loads(sys.stdin.buffer.read().decode("utf-8", "replace") or "{}")


def project_dir(data):
    return Path(os.environ.get("CLAUDE_PROJECT_DIR") or data.get("cwd") or ".")


def tail_lines(path, max_bytes=4_000_000):
    """The last few MB of the session file, as lines. A session file only ever grows."""
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - max_bytes))
            chunk = f.read()
    except OSError:
        return []
    lines = chunk.decode("utf-8", "replace").splitlines()
    return lines[1:] if size > max_bytes else lines


def context_tokens(transcript_path):
    """How full the main window is now. Reads a Claude Code session file or a Codex rollout file."""
    for line in reversed(tail_lines(transcript_path)):
        if not any(k in line for k in ('"usage"', '"compact_boundary"', '"token_count"', '"compacted"')):
            continue
        try:
            e = json.loads(line)
        except ValueError:
            continue
        p = e.get("payload") or {}
        if e.get("type") == "compacted":
            return 0
        if p.get("type") == "token_count":
            return ((p.get("info") or {}).get("last_token_usage") or {}).get("input_tokens", 0)
        if e.get("subtype") == "compact_boundary":
            return (e.get("compactMetadata") or {}).get("postTokens", 0)
        if e.get("type") == "assistant" and not e.get("isSidechain"):
            u = (e.get("message") or {}).get("usage") or {}
            return u.get("input_tokens", 0) + u.get("cache_creation_input_tokens", 0) + u.get("cache_read_input_tokens", 0)
    return 0


def marks_path(data):
    """One small JSON list per session. Lives in $OGL_STATE_DIR/compaction-marks, or .marks next to the hooks."""
    state = os.environ.get("OGL_STATE_DIR")
    base = Path(state).expanduser() / "compaction-marks" if state else HOOKS / ".marks"
    return base / f"{data.get('session_id', 'unknown')}.json"


def read_marks(data):
    try:
        return json.loads(marks_path(data).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []


def write_marks(data, marks):
    p = marks_path(data)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(marks), encoding="utf-8")


def emit(event, text):
    print(json.dumps({"hookSpecificOutput": {"hookEventName": event, "additionalContext": text}}))

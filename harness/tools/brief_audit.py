#!/usr/bin/env python3
"""brief_audit.py: did a worker touch only the files its brief named?

    python3 brief_audit.py <task_id> [--agents-dir DIR] [--projects-dir DIR] [--task-json FILE]

Reads the task's four-line brief (TASK / FILES / BAR / RETURN), takes the path-like tokens on its FILES line,
then lists every file the assignee wrote during the task's time window:

  - Write, Edit and NotebookEdit targets from the assignee's Claude Code transcripts
    (<projects-dir>/<encoded seat path>/*.jsonl)
  - every file under the assignee's own seat folder whose mtime falls in the window, which catches Bash
    writes without parsing shell (memory/, .git, node_modules, .venv and __pycache__ are skipped)

Each write is tagged IN (under a FILES path), tmp (a temp dir) or OUT. OUT is a question for the coordinator,
not a verdict: the brief may allow it in words, or the seat may have worked another task in the same window.
Read-only.

Paths on the FILES line resolve like this: absolute or ~ paths as written; "<other-seat>/..." under that
seat's folder when such a seat exists; anything else under the assignee's seat folder.

Defaults:
  --agents-dir    $CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/agents
  --projects-dir  ~/.claude/projects
  --task-json     read the task from `cortextos bus list-tasks --format json` (a file with the same JSON
                  shape, a list of tasks or {"tasks": [...]}, can stand in for it)

Exit codes: 0 no OUT writes; 3 at least one OUT write; 2 usage error or task not found.
"""
import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

HOME = Path.home()
PATHY = re.compile(r"(~?/[\w.@~/-]+|[\w.-]+/[\w.@/-]*|[\w-]+\.(?:py|sh|md|json|ts|js|yaml|yml|txt|html))")
SKIP = {".git", "node_modules", ".venv", "__pycache__", "memory"}
TMP = ("/tmp", "/private/tmp", "/var/folders")


def load_task(tid, task_json):
    if task_json:
        raw = Path(task_json).read_text()
    else:
        raw = subprocess.run(["cortextos", "bus", "list-tasks", "--format", "json"],
                             capture_output=True, text=True).stdout
    d = json.loads(raw or "[]")
    d = d if isinstance(d, list) else d.get("tasks", [])
    return next((t for t in d if t.get("id") == tid), None)


def files_line(desc):
    m = re.search(r"(?im)^[ \t]*FILES[ \t]*:[ \t]*(.*)$", desc or "")
    return m.group(1).strip() if m else ""


def allowed_paths(line, seat, agents):
    out = []
    for tok in PATHY.findall(line):
        tok = tok.rstrip(".,;")
        if tok.startswith(("~", "/")):
            p = Path(os.path.expanduser(tok))
        elif (agents / tok.split("/")[0]).is_dir() and tok.split("/")[0] != seat:
            p = agents / tok
        else:
            p = agents / seat / tok
        out.append(p.resolve() if p.exists() else p)
    return out


def when(s):
    t = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def project_dir(projects, seat_dir):
    return projects / re.sub(r"[^A-Za-z0-9]", "-", str(seat_dir))


def transcript_writes(projects, seat_dir, start, end):
    found = []
    proj = project_dir(projects, seat_dir)
    for f in sorted(proj.glob("*.jsonl")):
        if datetime.fromtimestamp(f.stat().st_mtime, tz=timezone.utc) < start:
            continue
        for line in f.open(errors="replace"):
            if '"tool_use"' not in line:
                continue
            try:
                d = json.loads(line)
                ts = when(d["timestamp"])
            except (ValueError, KeyError):
                continue
            if not (start <= ts <= end):
                continue
            for c in (d.get("message") or {}).get("content") or []:
                if isinstance(c, dict) and c.get("type") == "tool_use" and c.get("name") in ("Write", "Edit", "NotebookEdit"):
                    path = (c.get("input") or {}).get("file_path") or (c.get("input") or {}).get("notebook_path")
                    if path:
                        found.append((ts, c["name"], path))
    return found


def mtime_writes(seat_dir, start, end):
    out = []
    if not seat_dir.is_dir():
        return out
    for p in seat_dir.rglob("*"):
        try:
            rel = p.relative_to(seat_dir).parts
            if any(part in SKIP for part in rel) or not p.is_file():
                continue
            m = datetime.fromtimestamp(p.stat().st_mtime, tz=timezone.utc)
        except OSError:
            continue
        if start <= m <= end:
            out.append((m, "mtime", str(p)))
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description="List a worker's writes against its brief's FILES line.")
    ap.add_argument("task_id")
    default_agents = ""
    if os.environ.get("CTX_FRAMEWORK_ROOT") and os.environ.get("CTX_ORG"):
        default_agents = os.path.join(os.environ["CTX_FRAMEWORK_ROOT"], "orgs", os.environ["CTX_ORG"], "agents")
    ap.add_argument("--agents-dir", default=default_agents)
    ap.add_argument("--projects-dir", default=str(HOME / ".claude" / "projects"))
    ap.add_argument("--task-json")
    a = ap.parse_args(argv)
    if not a.agents_dir:
        print("brief_audit: set --agents-dir, or CTX_FRAMEWORK_ROOT and CTX_ORG", file=sys.stderr)
        return 2
    agents = Path(a.agents_dir).expanduser().resolve()
    t = load_task(a.task_id, a.task_json)
    if not t:
        print(f"brief_audit: task {a.task_id} not found", file=sys.stderr)
        return 2
    seat = t.get("assigned_to") or ""
    if not seat:
        print(f"brief_audit: task {a.task_id} has no assignee", file=sys.stderr)
        return 2
    seat_dir = agents / seat
    line = files_line(t.get("description"))
    allow = allowed_paths(line, seat, agents)
    start = when(t["created_at"])
    end = when(t["completed_at"]) if t.get("completed_at") else datetime.now(timezone.utc)
    ws = sorted(transcript_writes(Path(a.projects_dir).expanduser(), seat_dir, start, end)
                + mtime_writes(seat_dir, start, end))
    print(f"{t['id']} -> {seat}, {start:%Y-%m-%dT%H:%M:%SZ} to {end:%Y-%m-%dT%H:%M:%SZ}")
    print(f"FILES: {line or '(no FILES line)'}")
    print("allowed: " + (", ".join(str(p) for p in allow) or "(nothing)"))
    seen, outs = set(), 0
    for ts, tool, path in ws:
        p = Path(os.path.expanduser(path.replace("$HOME", str(HOME))))
        if not p.is_absolute():
            p = seat_dir / p
        p = p.resolve() if p.exists() else p
        if str(p) in seen:
            continue
        seen.add(str(p))
        inside = any(str(p) == str(x) or str(p).startswith(str(x).rstrip("/") + "/") for x in allow)
        in_tree = str(p).startswith(str(agents) + "/")
        tag = "IN " if inside else ("tmp" if str(p).startswith(TMP) and not in_tree else "OUT")
        outs += tag == "OUT"
        print(f"  {tag} {ts:%H:%M:%S} {tool:12} {p}")
    print(f"{len(seen)} distinct writes, {outs} OUT (questions for the coordinator, not verdicts)")
    return 3 if outs else 0


if __name__ == "__main__":
    sys.exit(main())

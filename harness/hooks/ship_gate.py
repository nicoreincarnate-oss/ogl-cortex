#!/usr/bin/env python3
"""OGL Cortex ship gate. PreToolUse hook for the Bash tool.

Blocks (exit 2) an outward-facing command (push, publish, deploy, release, remote copy) unless a passing pentest
report exists at security/pentest-gate-report.json in the working directory or an ancestor (up to $HOME).
"Passing" means the JSON has "status": "pass".

Claude Code blocks a PreToolUse command only on exit code 2. Any other non-zero code is a non-blocking error and the
command still runs, so every blocking path here exits 2.

Documented risk acceptance: a human writes security/pentest-risk-acceptance.md and starts the session with
OGL_PENTEST_OVERRIDE=accepted-risk in its environment. The agent cannot set the hook's environment from a command.

Environment:
  OGL_PENTEST_GATE_CMD   the command to print in the block message (how to produce the report)
  OGL_PENTEST_OVERRIDE   "accepted-risk" + a risk-acceptance file lets ship commands through
  OGL_SHIP_EXTRA_PATTERNS  extra regexes, separated by newlines, that also count as ship commands

Self-test: python3 ship_gate.py --selftest
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

REPORT = Path("security") / "pentest-gate-report.json"
ACCEPT = Path("security") / "pentest-risk-acceptance.md"

SHIP_PATTERNS = [
    r"\bgit\s+push\b",
    r"\bgh\s+release\s+create\b",
    r"\bgh\s+pr\s+merge\b",
    r"\bnpm\s+publish\b",
    r"\bpnpm\s+publish\b",
    r"\byarn\s+(?:npm\s+)?publish\b",
    r"\bvercel\b[^;&|\n]*\s--prod\b",
    r"\bvercel\s+(?:deploy|promote)\b",
    r"\bnetlify\s+deploy\b",
    r"\bfirebase\s+deploy\b",
    r"\bwrangler\s+(?:deploy|publish)\b",
    r"\bwrangler\s+pages\s+deploy\b",
    r"\bflyctl\s+deploy\b",
    r"\bfly\s+deploy\b",
    r"\brailway\s+up\b",
    r"\brender\s+deploy\b",
    r"\brsync\b[^;&|\n]*\s[\w.@-]+:",
    r"\bscp\b",
    r"\bsftp\b",
]


def patterns() -> list[str]:
    extra = [p for p in os.environ.get("OGL_SHIP_EXTRA_PATTERNS", "").splitlines() if p.strip()]
    return SHIP_PATTERNS + extra


def extract_command(payload: dict) -> str:
    tool_input = payload.get("tool_input") or {}
    return tool_input.get("command") or ""


def extract_cwd(payload: dict) -> Path:
    tool_input = payload.get("tool_input") or {}
    for value in (tool_input.get("cwd"), payload.get("cwd"), os.environ.get("CLAUDE_PROJECT_DIR")):
        if value:
            return Path(value).expanduser().resolve()
    return Path.cwd().resolve()


def is_ship_command(command: str) -> bool:
    normalized = re.sub(r"\s+", " ", command.strip())
    return any(re.search(p, normalized) for p in patterns())


def _walk(start: Path, rel: Path) -> Path | None:
    current = start if start.is_dir() else start.parent
    home = Path.home().resolve()
    for parent in [current, *current.parents]:
        if (parent / rel).exists():
            return parent / rel
        if parent == home or parent == parent.parent:
            break
    return None


def report_passes(path: Path | None) -> bool:
    if not path:
        return False
    try:
        return json.loads(path.read_text()).get("status") == "pass"
    except Exception:
        return False


def block_message() -> str:
    gate = os.environ.get("OGL_PENTEST_GATE_CMD") or "<your pentest gate command> . --output security"
    return (
        "SHIP GATE BLOCKED THIS COMMAND.\n"
        "It pushes, publishes or deploys, and no passing security/pentest-gate-report.json was found here or above.\n"
        f"Run first:\n  {gate}\n"
        "For web or API targets include the URL and any auth checks your gate supports.\n"
        "A human may accept a documented risk: write security/pentest-risk-acceptance.md and start the session with "
        "OGL_PENTEST_OVERRIDE=accepted-risk.\n"
    )


def main(raw: str) -> int:
    try:
        payload = json.loads(raw or "{}")
    except json.JSONDecodeError:
        return 2 if is_ship_command(raw) else 0
    if payload.get("tool_name", "Bash") != "Bash":
        return 0
    command = extract_command(payload)
    if not command or not is_ship_command(command):
        return 0
    cwd = extract_cwd(payload)
    override = os.environ.get("OGL_PENTEST_OVERRIDE") or os.environ.get("CORTEX_PENTEST_OVERRIDE")
    if override == "accepted-risk" and _walk(cwd, ACCEPT):
        return 0
    if report_passes(_walk(cwd, REPORT)):
        return 0
    print(block_message(), file=sys.stderr)
    return 2


def selftest() -> int:
    must_block = ["git push origin main", "vercel --prod", "vercel --prod --yes", "npx vercel --prod",
                  "cd site && vercel deploy --prod", "npm publish", "wrangler deploy", "rsync -av dist/ host:/srv/"]
    must_allow = ["git status", "vercel ls", "vercel dev", "npm test", "rsync -av a/ b/", "echo ready"]
    bad = [c for c in must_block if not is_ship_command(c)] + [c for c in must_allow if is_ship_command(c)]
    print("SELFTEST", "PASS" if not bad else f"FAIL {bad}")
    return 0 if not bad else 1


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        raise SystemExit(selftest())
    raw = sys.stdin.read()
    try:
        raise SystemExit(main(raw))
    except SystemExit:
        raise
    except Exception as exc:  # fail CLOSED on anything that looks like a ship command
        if is_ship_command(raw):
            print(f"SHIP GATE ERROR ({type(exc).__name__}): could not check this command, so it is blocked.", file=sys.stderr)
            raise SystemExit(2)
        raise SystemExit(0)

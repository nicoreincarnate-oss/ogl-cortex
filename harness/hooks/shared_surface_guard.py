#!/usr/bin/env python3
"""OGL Cortex shared-surface guard. PreToolUse hook for the Bash tool.

Blocks ONCE (exit 2) a command that changes something every seat on the machine depends on:
  - uv cache prune / clean on the shared uv cache (every uvx MCP server runs from it)
  - npm / pnpm global installs, upgrades and removals
  - brew upgrade
  - writes or deletes under ~/.claude or ~/.claude.json (~/.claude/projects is exempt for writes)
  - writes or deletes under any extra root listed in OGL_SURFACE_EXTRA_ROOTS
Read-only forms never match.

The block message names the live consumers to check and asks for a backup and a post-check plan. The agent then
releases the block with a per-seat pass token, consumed once, valid for 10 minutes:
    touch "$OGL_STATE_DIR/.surface-pass-once-$CTX_AGENT_NAME"      (default OGL_STATE_DIR: ~/.ogl-cortex/state)

An internal error fails CLOSED (exit 2) when the raw input names a guarded surface, and OPEN (exit 0) otherwise.
Every block, pass and warning is appended to $OGL_STATE_DIR/surface-guard.log and, when the cortextos CLI is on PATH,
logged as a bus event (surface_guard_block / _pass / _warn / _failclosed / _failopen).

Environment:
  CTX_AGENT_NAME           seat name, used for the pass token (default "shared")
  OGL_STATE_DIR            where tokens and the log live (default ~/.ogl-cortex/state)
  OGL_SURFACE_EXTRA_ROOTS  extra guarded roots, "path=rule:path=rule"
  OGL_NO_BUS=1             do not log bus events (tests set this)
  SURFACE_CODE_MODE=warn   python/node code analysis only warns, except writes to guarded roots, which still block

Self-test: python3 shared_surface_guard.py --selftest
"""
import json, os, re, subprocess, sys, time
sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
SEAT = re.sub(r"[^\w-]", "", os.environ.get("CTX_AGENT_NAME", "") or "") or "shared"
STATE = os.path.normpath(os.path.expanduser(os.environ.get("OGL_STATE_DIR") or "~/.ogl-cortex/state"))
TOKEN = os.path.join(STATE, f".surface-pass-once-{SEAT}")
LOG = os.path.join(STATE, "surface-guard.log")
HINT = {
    "uv_cache": "pgrep -fl 'uvx|uv run'   (every uvx MCP server runs from this cache)",
    "npm_global": "pgrep -fl 'claude|node'   (every seat runs the global claude CLI)",
    "brew_upgrade": "pgrep -fl \"$(brew --prefix)\"   (the python, node and tools the seats run)",
    "claude_config": "pgrep -x claude; lsof <file>   (every Claude Code seat reads ~/.claude)",
}
FIXED_RULES = {"npm_global", "brew_upgrade"}


def bus(event, meta):
    if os.environ.get("OGL_NO_BUS"):
        return
    try:
        subprocess.run(["cortextos", "bus", "log-event", "action", event, "info", "--meta", json.dumps(meta)],
                       capture_output=True, timeout=5)
    except Exception:
        pass


def log(line):
    try:
        os.makedirs(STATE, exist_ok=True)
        with open(LOG, "a") as f:
            f.write(time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()) + f" {SEAT} {line}\n")
    except OSError:
        pass


def selftest(surface):
    cases = [("uv cache prune --force", True), ("uv cache dir", False), ("npm ls -g", False), ("npm i -g x", True),
             ("stat ~/.claude/settings.json", False), ("cp x ~/.claude/settings.json", True),
             ("echo 'uv cache prune'", False), (f"touch {TOKEN}", False), ("brew upgrade", True), ("brew list", False),
             ("rm -rf ~/.cache/uv", True), ("UV_CACHE_DIR=/private/tmp/x uv cache prune", False),
             ("du -sh ~/.cache/uv", False)]
    bad = [c for c, want in cases if bool(surface.classify(c, "/tmp")) != want]
    print("SELFTEST", "PASS" if not bad else f"FAIL {bad}")
    sys.exit(0 if not bad else 1)


def main():
    import surface
    if "--selftest" in sys.argv:
        selftest(surface)
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)
    if data.get("tool_name") != "Bash":
        sys.exit(0)
    cmd = (data.get("tool_input") or {}).get("command", "") or ""
    hits = surface.classify(cmd, data.get("cwd"))
    for n in surface.NOTES[:3]:
        log(f"NOTE {n[:200]}")
        bus("surface_guard_note", {"seat": SEAT, "note": n[:200]})
    unparsed = [n for n in surface.NOTES if n.startswith(("inline:", "heredoc:")) and "not parseable" in n]
    if not hits and unparsed:
        log(f"WARN ['unparseable_code'] {unparsed[0][:120]!r}")
        bus("surface_guard_warn", {"seat": SEAT, "rules": ["unparseable_code"], "detail": unparsed[0][:120]})
    unres = [n for n in surface.NOTES if n.startswith("unresolved:")]
    if not hits and unres:
        log(f"WARN ['unresolved_cmdsubst_target'] {unres[0][:120]!r}")
        bus("surface_guard_warn", {"seat": SEAT, "rules": ["unresolved_cmdsubst_target"], "detail": unres[0][:120]})
    if not hits:
        sys.exit(0)
    rules = sorted({r for r, _ in hits})
    guarded_roots = {rule for _, rule in surface.ROOTS} - FIXED_RULES
    if os.environ.get("SURFACE_CODE_MODE") == "warn" and all(d.startswith("[code]") and r not in guarded_roots for r, d in hits):
        log(f"WARN {rules} {hits[0][1][:120]!r}")
        bus("surface_guard_warn", {"seat": SEAT, "rules": rules, "detail": hits[0][1][:120]})
        sys.exit(0)
    if os.path.exists(TOKEN) and time.time() - os.path.getmtime(TOKEN) < 600:
        os.remove(TOKEN)
        log(f"PASS {rules} {hits[0][1][:120]!r}")
        bus("surface_guard_pass", {"seat": SEAT, "rules": rules, "detail": hits[0][1][:120]})
        sys.exit(0)
    log(f"BLOCK {rules} {hits[0][1][:120]!r}")
    bus("surface_guard_block", {"seat": SEAT, "rules": rules, "detail": hits[0][1][:120]})
    roots = {rule: path for path, rule in surface.ROOTS}
    msg = ["SHARED-SURFACE GUARD blocked this command once. It changes something other seats use:"]
    msg += [f"  - {r}: {d}" for r, d in hits[:4]]
    msg += ["Before you re-run it:", "  1) Name the LIVE consumers. Check:"]
    msg += [f"       {HINT.get(r) or f'lsof +D {roots.get(r, r)}'}" for r in rules]
    msg += ["  2) Take a backup of what you change (cp -p <file> <file>.bak-$(date -u +%Y%m%dT%H%M%SZ)).",
            "  3) Plan the post-check that proves the consumers still work.",
            f"Then release it: mkdir -p {STATE} && touch {TOKEN}   (one command, 10 minutes) and re-run."]
    sys.stderr.write("\n".join(msg) + "\n")
    sys.exit(2)


def _scope():
    """Fail-closed scope, judged on the RAW hook input because a crash may be in the parser."""
    parts = [r"(?<![\w-])\.claude(?:\.json)?\b", r"\.cache/uv\b", r"\buv\b[^\n]*\bcache\s+(?:prune|clean)",
             r"\bbrew\s+upgrade", r"\b(?:npm|pnpm)\b[^\n]*\s(?:-g|--global)\b"]
    home = os.path.expanduser("~")
    for pair in os.environ.get("OGL_SURFACE_EXTRA_ROOTS", "").split(":"):
        path = pair.split("=", 1)[0].strip()
        if not path:
            continue
        path = os.path.expanduser(path)
        rel = os.path.relpath(path, home) if path.startswith(home + os.sep) else path
        parts.append(re.escape(rel))
    return re.compile("|".join(parts), re.I)


if __name__ == "__main__":
    raw = "" if "--selftest" in sys.argv else sys.stdin.read()
    sys.stdin = __import__("io").StringIO(raw)
    try:
        if os.environ.get("SURFACE_GUARD_SELFTEST_CRASH"):
            raise RuntimeError("selftest crash")
        main()
    except SystemExit:
        raise
    except Exception as e:
        if "--selftest" in sys.argv:
            raise
        closed = bool(_scope().search(raw))
        d = f"{'FAIL-CLOSED' if closed else 'FAIL-OPEN'} {type(e).__name__}: {str(e)[:160]}"
        log(f"WARN ['guard_exception'] {d!r}")
        bus("surface_guard_warn", {"seat": SEAT, "rules": ["guard_exception"], "detail": d})
        bus("surface_guard_failclosed" if closed else "surface_guard_failopen", {"seat": SEAT, "detail": d})
        if closed:
            sys.stderr.write(f"SHARED-SURFACE GUARD ERROR ({type(e).__name__}): it crashed on a command that names a "
                             "shared surface, so the command is blocked. Fix the guard; the pass token does not apply "
                             "to a crash.\n")
            sys.exit(2)
        sys.exit(0)

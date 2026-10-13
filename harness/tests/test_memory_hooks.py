"""Memory hooks: PreCompact checkpoint, SessionStart inject, PostCompact session facts.
None of these hooks blocks. Must-work cases check what they write or inject; must-not-break cases feed bad input
and require exit 0 with no traceback."""
import json, os, subprocess, sys, tempfile, time
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import memfixtures as fx  # noqa: E402

HOOKS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "hooks", "memory")


def hook(name, payload, seat, env=None):
    e = dict(os.environ, CLAUDE_PROJECT_DIR=seat)
    e.update(env or {})
    raw = payload if isinstance(payload, str) else json.dumps(payload)
    r = subprocess.run([sys.executable, os.path.join(HOOKS, name)], input=raw, capture_output=True, text=True, env=e, timeout=30)
    return r.returncode, r.stdout, r.stderr


def read(p):
    return open(p, encoding="utf-8").read() if os.path.exists(p) else ""


def main():
    work, broke = [], []
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    # --- PreCompact checkpoint
    seat = tempfile.mkdtemp(prefix="ogl-seat-")
    tx = fx.transcript(os.path.join(seat, "session.jsonl"))
    code, out, err = hook("precompact_checkpoint.py", {"session_id": "s1", "transcript_path": tx, "cwd": seat,
                                                        "hook_event_name": "PreCompact", "trigger": "manual"}, seat)
    latest = read(os.path.join(seat, "memory", "checkpoints", "latest.md"))
    daily = read(os.path.join(seat, "memory", f"{today}.md"))
    work.append(("checkpoint captures 5 messages from the fixture", code == 0 and "Captured 5 of 5" in latest))
    work.append(("checkpoint keeps the person's words and replies", all(k in latest for k in fx.KEPT)))
    work.append(("checkpoint drops tool output, thinking, crons, reminders, sidechains",
                 not any(d in latest for d in fx.DROPPED)))
    work.append(("daily memory gets the capture count", "(5 msgs captured)" in daily))
    work.append(("a timestamped copy is kept", len([f for f in os.listdir(os.path.join(seat, "memory", "checkpoints"))
                                                    if f.startswith("checkpoint-")]) == 1))
    # the shell-heredoc wrapper this hook replaces: python reads the script from stdin, the payload never arrives
    seat_b = tempfile.mkdtemp(prefix="ogl-seat-")
    wrapper = f"python3 - <<'PYEOF'\nimport json,sys\ntry:\n    d=json.load(sys.stdin)\nexcept Exception:\n    d={{}}\nprint(len(d))\nPYEOF\n"
    r = subprocess.run(["bash", "-c", wrapper], input=json.dumps({"transcript_path": tx}), capture_output=True, text=True)
    work.append(("regression: a heredoc wrapper loses the payload (why this hook is pure Python)", r.stdout.strip() == "0"))

    # zero capture is reported as a failure, and inject surfaces it
    code, _, _ = hook("precompact_checkpoint.py", {"session_id": "s2", "transcript_path": "/nonexistent.jsonl"}, seat_b)
    latest_b = read(os.path.join(seat_b, "memory", "checkpoints", "latest.md"))
    work.append(("0 messages is written as CHECKPOINT FAILED", code == 0 and latest_b.count("CHECKPOINT FAILED") == 1))
    work.append(("daily note says CHECKPOINT FAILED", "CHECKPOINT FAILED" in read(os.path.join(seat_b, "memory", f"{today}.md"))))
    code, out, _ = hook("sessionstart_inject.py", {"source": "startup"}, seat_b)
    work.append(("inject warns when the last checkpoint failed", code == 0 and "WARNING: the last pre-compaction checkpoint captured nothing" in out))

    for label, payload in [("empty stdin", ""), ("garbage stdin", "{not json"), ("JSON list", "[1,2]"),
                           ("transcript is a directory", {"transcript_path": seat})]:
        s = tempfile.mkdtemp(prefix="ogl-seat-")
        code, _, err = hook("precompact_checkpoint.py", payload, s)
        broke.append((f"checkpoint, {label}: exit 0, no traceback, failure recorded",
                      code == 0 and "Traceback" not in err and "CHECKPOINT FAILED" in read(os.path.join(s, "memory", "checkpoints", "latest.md"))))
    ro = tempfile.mkdtemp(prefix="ogl-seat-")
    os.chmod(ro, 0o500)
    code, _, err = hook("precompact_checkpoint.py", {"transcript_path": tx}, ro)
    os.chmod(ro, 0o700)
    broke.append(("checkpoint, read-only seat: exit 0 (never blocks compaction)", code == 0))

    # --- SessionStart inject
    code, out, _ = hook("sessionstart_inject.py", {"source": "compact", "cwd": seat}, seat)
    ctx = json.loads(out)["hookSpecificOutput"]["additionalContext"] if out.strip() else ""
    work.append(("inject hands back the checkpoint", code == 0 and "BLUE-HERON-7" in ctx))
    work.append(("inject hands back the daily tail", f"Tail of daily memory {today}" in ctx))
    work.append(("no ENTITIES.md, no reminder", "ENTITIES.md" not in ctx))
    fx.write(os.path.join(seat, "ENTITIES.md"), "# ENTITIES\n")
    code, out, _ = hook("sessionstart_inject.py", {"source": "startup"}, seat)
    work.append(("ENTITIES.md present, reminder added", "ENTITIES.md is the noun index" in out))

    old = tempfile.mkdtemp(prefix="ogl-seat-")
    yday = (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%d")
    fx.write(os.path.join(old, "memory", f"{yday}.md"), "COMPLETED: yesterday's task\n")
    ck = os.path.join(old, "memory", "checkpoints", "latest.md")
    fx.write(ck, "# old checkpoint STALE-MARK\n")
    stale = time.time() - 100 * 3600
    os.utime(ck, (stale, stale))
    code, out, _ = hook("sessionstart_inject.py", {"source": "startup"}, old)
    work.append(("inject falls back to yesterday's daily file", "yesterday's task" in out))
    work.append(("inject skips a checkpoint older than 72 h", "STALE-MARK" not in out))

    for label, payload in [("empty seat", {"source": "startup"}), ("garbage stdin", "\x00\x01"), ("empty stdin", "")]:
        s = tempfile.mkdtemp(prefix="ogl-seat-")
        code, out, err = hook("sessionstart_inject.py", payload, s)
        broke.append((f"inject, {label}: exit 0, prints nothing", code == 0 and out.strip() == "" and "Traceback" not in err))
    big = tempfile.mkdtemp(prefix="ogl-seat-")
    fx.write(os.path.join(big, "memory", f"{today}.md"), "x" * 200_000 + "\nLAST-LINE\n")
    code, out, _ = hook("sessionstart_inject.py", {}, big)
    broke.append(("inject, 200 KB daily file: capped and still valid JSON", code == 0 and len(out) < 8000 and "LAST-LINE" in json.loads(out)["hookSpecificOutput"]["additionalContext"]))

    # --- PostCompact session facts
    root = tempfile.mkdtemp(prefix="ogl-ctxroot-")
    summary = "The invoice run moved to the 1st. The invoice run owner is the billing seat. Billing export runs hourly."
    code, _, _ = hook("session_facts.py", {"session_id": "s1", "compact_summary": summary}, seat,
                      {"CTX_ROOT": root, "CTX_AGENT_NAME": "tester", "CTX_ORG": "acme"})
    fpath = os.path.join(root, "state", "tester", "memory", "facts", f"{today}.jsonl")
    rows = [json.loads(l) for l in read(fpath).splitlines() if l.strip()]
    work.append(("session fact written where recall-facts reads", code == 0 and len(rows) == 1))
    work.append(("session fact has the framework's fields", rows and set(rows[0]) >= {"ts", "session_id", "agent", "org", "summary", "keywords"}
                 and rows[0]["summary"] == summary and "invoice" in rows[0]["keywords"]))
    for label, payload in [("no summary (PreCompact-shaped payload)", {"session_id": "s", "trigger": "auto"}),
                           ("garbage stdin", "nope"), ("short summary", {"compact_summary": "ok"})]:
        r2 = tempfile.mkdtemp(prefix="ogl-ctxroot-")
        code, _, err = hook("session_facts.py", payload, seat, {"CTX_ROOT": r2, "CTX_AGENT_NAME": "tester"})
        broke.append((f"facts, {label}: exit 0, writes nothing", code == 0 and not any(files for _, _, files in os.walk(r2))))

    for label, ok in work + broke:
        if not ok:
            print(f"[memory_hooks] FAIL: {label}")
    w, b = sum(ok for _, ok in work), sum(ok for _, ok in broke)
    passed = w == len(work) and b == len(broke)
    print(f"{'memory hooks':<22} must-work {w}/{len(work)}   must-not-break {b}/{len(broke)}   {'PASS' if passed else 'FAIL'}")
    return passed


if __name__ == "__main__":
    sys.exit(0 if main() else 1)

"""Compaction kit: the meter speaks once at each threshold, STATE.md comes back after compaction, summaries are saved.
These hooks never block; every case must exit 0 and produce the expected output."""
import json, os, subprocess, sys, tempfile

HOOKS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "hooks", "compaction")


def hook(name, payload, project, state):
    env = dict(os.environ, OGL_STATE_DIR=state, CLAUDE_PROJECT_DIR=project)
    r = subprocess.run([sys.executable, os.path.join(HOOKS, name)], input=json.dumps(payload), capture_output=True,
                       text=True, env=env, timeout=30)
    return r.returncode, r.stdout


def transcript(path, tokens):
    line = {"type": "assistant", "message": {"usage": {"input_tokens": tokens, "cache_creation_input_tokens": 0,
                                                       "cache_read_input_tokens": 0}}}
    with open(path, "w") as f:
        f.write(json.dumps(line) + "\n")


def main():
    project, state = tempfile.mkdtemp(prefix="ogl-seat-"), tempfile.mkdtemp(prefix="ogl-state-")
    tx = os.path.join(project, "session.jsonl")
    base = {"session_id": "s1", "transcript_path": tx, "cwd": project}
    results = []

    transcript(tx, 100_000)
    code, out = hook("meter.py", base, project, state)
    results.append(("meter quiet below nudge", code == 0 and out.strip() == ""))
    transcript(tx, 310_000)
    code, out = hook("meter.py", base, project, state)
    results.append(("meter nudges once", code == 0 and "Keep working" in out))
    code, out = hook("meter.py", base, project, state)
    results.append(("meter silent on repeat nudge", code == 0 and out.strip() == ""))
    transcript(tx, 370_000)
    code, out = hook("meter.py", base, project, state)
    results.append(("meter warns", code == 0 and "rewrite STATE.md" in out and bool(json.loads(out)["hookSpecificOutput"])))

    open(os.path.join(project, "STATE.md"), "w").write("# STATE\nnext step: run tests\n")
    code, out = hook("after_compact.py", base, project, state)
    results.append(("STATE.md handed back", code == 0 and "next step: run tests" in out))
    transcript(tx, 370_000)
    code, out = hook("meter.py", base, project, state)
    results.append(("meter re-armed after compaction", code == 0 and "rewrite STATE.md" in out))

    code, _ = hook("save_summary.py", dict(base, compact_summary="summary text"), project, state)
    saved = os.listdir(os.path.join(project, "compactions")) if os.path.isdir(os.path.join(project, "compactions")) else []
    results.append(("summary saved", code == 0 and len(saved) == 1))

    for label, ok in results:
        if not ok:
            print(f"[compaction] FAIL: {label}")
    n = sum(ok for _, ok in results)
    print(f"{'compaction':<22} behaviour {n}/{len(results)}   (no blocking hooks)   {'PASS' if n == len(results) else 'FAIL'}")
    return n == len(results)


if __name__ == "__main__":
    sys.exit(0 if main() else 1)

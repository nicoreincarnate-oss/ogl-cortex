"""Session digest: SessionEnd filter, headless write-up with a fake model CLI, local index, search, recall hook.
Each case runs on a copy of harness/memory/session-digest in a temp dir. A fake `claude` stands in for the model.
Must-work cases check the digest and the search hit; must-not-break cases feed bad input and require exit 0."""
import json, os, shutil, subprocess, sys, tempfile, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import memfixtures as fx  # noqa: E402

SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "memory", "session-digest")
PLANTED = "The staging database password rotates every 30 days via the vault job ORCHID-42."


def setup(mode="headless", fake_ok=True):
    root = tempfile.mkdtemp(prefix="ogl-digest-")
    code = os.path.join(root, "session-digest")
    shutil.copytree(SRC, code, ignore=shutil.ignore_patterns("__pycache__", "pending", "log", "index.db", "distilled"))
    cfg = json.load(open(os.path.join(code, "digest", "config.json")))
    cfg.update(mode=mode, min_turns=2)
    json.dump(cfg, open(os.path.join(code, "digest", "config.json"), "w"))
    seat = os.path.join(root, "seat")
    fx.write(os.path.join(seat, "memory", "2026-01-01.md"), "# 2026-01-01\n\nCOMPLETED: wired the heartbeat cron\n")
    fakebin = os.path.join(root, "bin")
    os.makedirs(fakebin)
    body = (f'cat > "{root}/model-input.txt"\nprintf "### What happened\\nA short session.\\n\\n### Facts\\n- {PLANTED}\\n"\n'
            if fake_ok else 'cat >/dev/null\necho "model unavailable" >&2\nexit 1\n')
    with open(os.path.join(fakebin, "claude"), "w") as f:
        f.write("#!/bin/bash\n" + body)
    os.chmod(os.path.join(fakebin, "claude"), 0o755)
    env = dict(os.environ, CLAUDE_PROJECT_DIR=seat, PATH=fakebin + os.pathsep + os.environ["PATH"])
    env.pop("OGL_DIGEST_CHILD", None)
    return root, code, seat, env


def py(script, args=(), stdin="", env=None, cwd=None):
    r = subprocess.run([sys.executable, script, *args], input=stdin, capture_output=True, text=True, env=env, cwd=cwd, timeout=60)
    return r.returncode, r.stdout, r.stderr


def wait_for(path, needle, seconds=30):
    end = time.time() + seconds
    while time.time() < end:
        if os.path.exists(path) and needle in open(path, encoding="utf-8").read():
            return True
        time.sleep(0.3)
    return False


def main():
    work, broke = [], []

    # session mode: the hook stages the filtered text and the next session start hands it over
    root, code, seat, env = setup(mode="session")
    tx = fx.transcript(os.path.join(root, "t.jsonl"))
    c, out, err = py(os.path.join(code, "digest", "session_end.py"), stdin=json.dumps({"session_id": "s1", "transcript_path": tx}), env=env)
    staged = [os.path.join(code, "digest", "pending", f) for f in os.listdir(os.path.join(code, "digest", "pending"))] \
        if os.path.isdir(os.path.join(code, "digest", "pending")) else []
    text = open(staged[0]).read() if staged else ""
    work.append(("session end stages one filtered file", c == 0 and len(staged) == 1))
    work.append(("staged text keeps the person's words and replies", all(k in text for k in fx.KEPT)))
    work.append(("staged text drops tool output, crons, reminders, sidechains", not any(d in text for d in fx.DROPPED)))
    c, out, _ = py(os.path.join(code, "digest", "session_start.py"), stdin=json.dumps({"source": "startup"}), env=env)
    work.append(("session start hands the staged text to the next session", c == 0 and "BLUE-HERON-7" in out
                 and json.loads(out)["hookSpecificOutput"]["hookEventName"] == "SessionStart"))

    # headless mode: the hook spawns the write-up; the digest lands in memory/digests and is indexed
    root, code, seat, env = setup(mode="headless")
    c, out, err = py(os.path.join(code, "index", "build_index.py"), env=env)
    work.append(("build_index over <seat>/memory (keyword leg without fastembed)", c == 0 and "indexed 1 files" in out))
    tx = fx.transcript(os.path.join(root, "t.jsonl"))
    t0 = time.time()
    c, _, _ = py(os.path.join(code, "digest", "session_end.py"), stdin=json.dumps({"session_id": "s2", "transcript_path": tx}), env=env)
    work.append(("session end returns fast (under 3 s) and exits 0", c == 0 and time.time() - t0 < 3))
    import datetime as _dt
    digest = os.path.join(seat, "memory", "digests", f"{_dt.datetime.now():%Y-%m-%d}.md")
    work.append(("headless run appends the digest to memory/digests/<date>.md", wait_for(digest, "ORCHID-42")))
    work.append(("the model saw the filtered session, not tool output",
                 wait_for(os.path.join(root, "model-input.txt"), "BLUE-HERON-7") and "TOOL-DUMP" not in open(os.path.join(root, "model-input.txt")).read()))
    time.sleep(1.0)
    work.append(("staged file removed after a good write-up", not os.listdir(os.path.join(code, "digest", "pending"))))
    hit = False
    for _ in range(20):
        c, out, _ = py(os.path.join(code, "index", "search.py"), ["vault job ORCHID-42 rotation"], env=env)
        if "digests/" in out and "ORCHID-42" in out:
            hit = True
            break
        time.sleep(0.5)
    work.append(("search finds the planted fact in the digest", hit))
    c, out, _ = py(os.path.join(code, "index", "recall_hook.py"), stdin=json.dumps({"prompt": "when does ORCHID-42 rotate?"}), env=env)
    work.append(("notes recall hook injects the hit", c == 0 and "ORCHID-42" in out))
    c, out, _ = py(os.path.join(code, "index", "build_index.py"), ["--update", "2026-01-01.md"], env=env)
    work.append(("--update re-indexes one file", c == 0 and "updated 1 files" in out))

    # must-not-break
    for label, payload in [("empty stdin", ""), ("garbage stdin", "{oops"), ("no transcript", {"session_id": "x"}),
                           ("missing transcript", {"transcript_path": "/nonexistent.jsonl"})]:
        root, code, seat, env = setup()
        c, _, err = py(os.path.join(code, "digest", "session_end.py"),
                       stdin=payload if isinstance(payload, str) else json.dumps(payload), env=env)
        broke.append((f"session end, {label}: exit 0, nothing staged", c == 0 and "Traceback" not in err
                      and not os.path.isdir(os.path.join(code, "digest", "pending"))))
    root, code, seat, env = setup()
    tx = fx.transcript(os.path.join(root, "t.jsonl"))
    c, _, _ = py(os.path.join(code, "digest", "session_end.py"), stdin=json.dumps({"transcript_path": tx}), env=dict(env, OGL_DIGEST_CHILD="1"))
    broke.append(("session end inside the digest's own child: does nothing", c == 0 and not os.path.isdir(os.path.join(code, "digest", "pending"))))
    shutil.rmtree(os.path.join(seat, "memory"))
    c, _, _ = py(os.path.join(code, "digest", "session_end.py"), stdin=json.dumps({"transcript_path": tx}), env=env)
    broke.append(("no notes folder: exit 0, reason logged", c == 0 and "no notes folder" in open(os.path.join(code, "digest", "log", "digest.log")).read()))
    root, code, seat, env = setup(fake_ok=False)
    tx = fx.transcript(os.path.join(root, "t.jsonl"))
    c, _, _ = py(os.path.join(code, "digest", "session_end.py"), stdin=json.dumps({"transcript_path": tx}), env=env)
    log = os.path.join(code, "digest", "log", "digest.log")
    broke.append(("model fails: staged file kept for a retry, reason logged", c == 0 and wait_for(log, "headless_run")
                  and len(os.listdir(os.path.join(code, "digest", "pending"))) == 1))
    for label, payload in [("no index", {"prompt": "anything"}), ("garbage", "%%"), ("cron prompt", {"prompt": "[CRON FIRED x] heartbeat"})]:
        root, code, seat, env = setup()
        if label == "cron prompt":
            py(os.path.join(code, "index", "build_index.py"), env=env)
        c, out, err = py(os.path.join(code, "index", "recall_hook.py"), stdin=payload if isinstance(payload, str) else json.dumps(payload), env=env)
        broke.append((f"notes recall hook, {label}: exit 0, silent", c == 0 and out.strip() == "" and "Traceback" not in err))
    root, code, seat, env = setup()
    c, _, err = py(os.path.join(code, "index", "build_index.py"), ["--corpus", "/nonexistent-notes"], env=env)
    broke.append(("build_index on a missing folder: clear error, no traceback", c != 0 and "not a folder" in err and "Traceback" not in err))

    for label, ok in work + broke:
        if not ok:
            print(f"[session_digest] FAIL: {label}")
    w, b = sum(ok for _, ok in work), sum(ok for _, ok in broke)
    passed = w == len(work) and b == len(broke)
    print(f"{'session digest':<22} must-work {w}/{len(work)}   must-not-break {b}/{len(broke)}   {'PASS' if passed else 'FAIL'}")
    return passed


if __name__ == "__main__":
    sys.exit(0 if main() else 1)

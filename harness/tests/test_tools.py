"""Tests for harness/tools: ship.sh, adversarial-pass.sh, brief_audit.py, emit-truth-correction.sh.

Each case runs the tool in a temp directory with fakes for the network, the model CLI and the cortextos CLI, and
asserts the exit code (plus the output where the exit code alone would not prove the behaviour).
Nothing touches a real deploy target, model, bus or home directory file.
"""
import datetime as dt
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

TOOLS = Path(__file__).resolve().parent.parent / "tools"


def sh(args, env=None, cwd=None, stdin=""):
    e = dict(os.environ, OGL_NO_BUS="1")
    for k in [k for k in e if k.startswith("CTX_") or k.startswith("OGL_SHIP_") or k.startswith("OGL_HUNTER")]:
        e.pop(k)
    e["OGL_NO_BUS"] = "1"
    e.update(env or {})
    r = subprocess.run(args, capture_output=True, text=True, env=e, cwd=cwd, input=stdin, timeout=120)
    return r.returncode, r.stdout, r.stderr


def tally(name, cases):
    """cases: (label, kind 'pass'|'fail', ok bool, detail)."""
    fails = [c for c in cases if not c[2]]
    for label, kind, _, detail in fails:
        print(f"[{name}] {kind.upper()} CASE FAILED: {label} {detail[:200]}")
    p = [c for c in cases if c[1] == "pass"]
    f = [c for c in cases if c[1] == "fail"]
    print(f"{name:<22} must-pass {sum(c[2] for c in p)}/{len(p)}   must-fail {sum(c[2] for c in f)}/{len(f)}   "
          f"{'PASS' if not fails else 'FAIL'}")
    return not fails


def write(path, text, mode=0o755):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    path.chmod(mode)
    return str(path)


# ---------------------------------------------------------------- ship.sh
def test_ship():
    fx = Path(tempfile.mkdtemp(prefix="ogl-ship-fx-"))
    gate = write(fx / "gate.sh", """#!/bin/bash
# fake gate: status by step, taken from env
[ -n "${GATE_SILENT:-}" ] && exit 0
case "$1" in
  "") s="${STATIC:-pass}";;
  *cand*) s="${CAND_GATE:-pass}";;
  *) s="${LIVE:-pass}";;
esac
mkdir -p security; printf '{"status":"%s"}' "$s" > security/pentest-gate-report.json
""")
    http = write(fx / "http.sh", """#!/bin/bash
case "$1" in *cand*) echo "${CAND_CODE:-200}";; *) echo "${PROD_CODE:-200}";; esac
""")
    url = "https://site.example"

    def run(extra_env=None, args=None, promote=False):
        proj = tempfile.mkdtemp(prefix="ogl-ship-proj-")
        mark = os.path.join(proj, "deployed")
        env = {"OGL_SHIP_HTTP": http, "OGL_SHIP_GATE_CMD": f"bash {gate} \"$1\"",
               "OGL_SHIP_DEPLOY_CMD": f"touch {mark}"}
        if promote:
            env.update({"OGL_SHIP_DEPLOY_CMD": f"touch {mark}; echo https://cand-1.example",
                        "OGL_SHIP_PROMOTE_CMD": f"echo promoted > {proj}/promoted; true",
                        "OGL_SHIP_REMOVE_CMD": f"echo > {proj}/removed; true"})
        env.update(extra_env or {})
        code, out, err = sh(["bash", str(TOOLS / "ship.sh"), proj, url] + (args or []), env)
        return code, out + err, proj, os.path.exists(mark)

    cases = []
    c, o, p, dep = run()
    cases.append(("direct ship passes", "pass", c == 0 and dep and "SHIPPED" in o, o))
    c, o, p, dep = run(promote=True)
    cases.append(("promote ship passes", "pass", c == 0 and os.path.exists(f"{p}/promoted"), o))
    c, o, p, dep = run({"OGL_SHIP_DEPLOY_CMD": f"echo '{{\"deployment\":{{\"url\":\"https://cand-2.example\"}}}}'"}, promote=True)
    cases.append(("promote reads JSON deployment.url", "pass", c == 0 and "cand-2.example" in o, o))

    c, o, *_ = run({"OGL_SHIP_GATE_CMD": ""})
    cases.append(("no gate command", "fail", c == 2, o))
    c, o, *_ = run(args=["--gate-cmd"])
    cases.append(("flag without value", "fail", c == 2, o))
    proj = tempfile.mkdtemp()
    c, o, _ = sh(["bash", str(TOOLS / "ship.sh"), proj, "not-a-url", "--gate-cmd", "true"])
    cases.append(("invalid URL", "fail", c == 2, o))
    c, o, p, dep = run({"STATIC": "fail"})
    cases.append(("static gate fails, nothing deployed", "fail", c == 3 and not dep, o))
    c, o, p, dep = run({"GATE_SILENT": "1"})
    cases.append(("gate writes no report", "fail", c == 3 and not dep, o))
    c, o, *_ = run({"OGL_SHIP_DEPLOY_CMD": "false"})
    cases.append(("deploy fails", "fail", c == 4, o))
    c, o, *_ = run({"PROD_CODE": "503"})
    cases.append(("prod not 200 after deploy", "fail", c == 5 and "roll back" in o, o))
    c, o, *_ = run({"LIVE": "fail"})
    cases.append(("live gate fails after deploy", "fail", c == 5, o))
    c, o, *_ = run({"OGL_SHIP_DEPLOY_CMD": "echo built"}, promote=True)
    cases.append(("promote: no candidate URL", "fail", c == 4, o))
    c, o, p, _ = run({"CAND_CODE": "401"}, promote=True)
    cases.append(("promote: candidate 401", "fail", c == 6 and os.path.exists(f"{p}/removed") and not os.path.exists(f"{p}/promoted"), o))
    c, o, p, _ = run({"CAND_GATE": "fail"}, promote=True)
    cases.append(("promote: candidate gate fails", "fail", c == 6 and not os.path.exists(f"{p}/promoted"), o))
    c, o, *_ = run({"OGL_SHIP_PROMOTE_CMD": "false"}, promote=True)
    cases.append(("promote command fails", "fail", c == 7, o))
    c, o, *_ = run({"LIVE": "fail"}, promote=True)
    cases.append(("promote: live gate fails", "fail", c == 5, o))
    return tally("ship.sh", cases)


# ---------------------------------------------------------------- adversarial-pass.sh
def test_hunter():
    work = tempfile.mkdtemp(prefix="ogl-hunt-")
    write(os.path.join(work, "guard.py"), "x = 1\n", 0o644)
    out = os.path.join(work, "runs")
    base = ["bash", str(TOOLS / "adversarial-pass.sh"), "--claim", "the guard blocks every write", "--cd", work,
            "--out-dir", out, "--budget", "1"]
    cases = []
    c, o, e = sh(base + ["guard.py"], {"OGL_HUNTER_CMD": 'grep -q "CLAIM: the guard blocks every write" && echo "CLAIM HOLDS"'})
    report = o.strip()
    ok = c == 0 and os.path.isfile(report) and "CLAIM HOLDS" in open(report).read()
    cases.append(("fake engine sees the brief, report written", "pass", ok, o + e))

    fakebin = tempfile.mkdtemp(prefix="ogl-fakebin-")
    write(os.path.join(fakebin, "claude"), '#!/bin/bash\necho "ARGS: $*"; echo "CTXVARS: $(env | grep -c ^CTX_)"; cat >/dev/null\n')
    c, o, e = sh(base + ["guard.py"], {"PATH": fakebin + os.pathsep + os.environ["PATH"], "CTX_AGENT_NAME": "x", "CTX_ORG": "y"})
    text = open(o.strip()).read() if c == 0 and os.path.isfile(o.strip()) else ""
    ok = ("--allowedTools Read,Grep,Glob" in text and "--strict-mcp-config" in text and "--no-session-persistence" in text
          and "CTXVARS: 0" in text and "--model opus" in text)
    cases.append(("claude engine: read-only flags, CTX_* stripped", "pass", ok, text or o + e))

    c, o, e = sh(base + ["guard.py"], {"OGL_HUNTER_CMD": "cat >/dev/null; exit 9"})
    cases.append(("engine failure", "fail", c == 3 and "engine exit 9" in open(o.strip()).read(), o + e))
    c, o, e = sh(["bash", str(TOOLS / "adversarial-pass.sh"), "--cd", work, "guard.py"])
    cases.append(("missing --claim", "fail", c == 2, e))
    c, o, e = sh(["bash", str(TOOLS / "adversarial-pass.sh"), "--claim", "x", "--cd", work])
    cases.append(("no files", "fail", c == 2, e))
    c, o, e = sh(["bash", str(TOOLS / "adversarial-pass.sh"), "--claim", "x", "--cd", "/nonexistent-ogl", "f"])
    cases.append(("bad --cd", "fail", c == 2, e))
    c, o, e = sh(["bash", str(TOOLS / "adversarial-pass.sh"), "--claim", "x", "--cd", work, "--budget", "ten", "f"])
    cases.append(("bad --budget", "fail", c == 2, e))
    c, o, e = sh(["bash", str(TOOLS / "adversarial-pass.sh"), "--claim", "--cd", work, "f"])
    cases.append(("flag swallows next flag", "fail", c == 2, e))
    return tally("adversarial-pass.sh", cases)


# ---------------------------------------------------------------- brief_audit.py
def test_brief_audit():
    now = dt.datetime.now(dt.timezone.utc)
    iso = lambda t: t.strftime("%Y-%m-%dT%H:%M:%S.000Z")
    cases = []

    def scenario(writes, mtime_files=(), old_files=(), desc=None, tid="task_1"):
        root = Path(tempfile.mkdtemp(prefix="ogl-audit-")).resolve()
        agents, projects = root / "agents", root / "projects"
        seat = agents / "worker"
        (agents / "boss").mkdir(parents=True)
        seat.mkdir(parents=True)
        for f in mtime_files:
            write(seat / f, "x", 0o644)
        for f in old_files:
            p = write(seat / f, "x", 0o644)
            t = (now - dt.timedelta(hours=3)).timestamp()
            os.utime(p, (t, t))
        proj = projects / ("-" + str(seat).strip("/").replace("/", "-").replace(".", "-").replace("_", "-"))
        proj.mkdir(parents=True)
        lines = []
        for path, minutes_ago in writes:
            lines.append(json.dumps({"timestamp": iso(now - dt.timedelta(minutes=minutes_ago)), "message": {"content": [
                {"type": "tool_use", "name": "Write", "input": {"file_path": path}}]}}))
        (proj / "s.jsonl").write_text("\n".join(lines) + "\n")
        task = {"id": tid, "assigned_to": "worker", "created_at": iso(now - dt.timedelta(hours=1)), "completed_at": None,
                "description": desc or "TASK: fix it\nFILES: src/, tests/\nBAR: tests pass\nRETURN: hash"}
        tj = write(root / "tasks.json", json.dumps({"tasks": [task]}), 0o644)
        return seat, ["python3", str(TOOLS / "brief_audit.py"), "task_1", "--agents-dir", str(agents),
                      "--projects-dir", str(projects), "--task-json", tj]

    seat, cmd = scenario([])
    c, o, e = sh(cmd)
    cases.append(("no writes", "pass", c == 0, o + e))
    seat, cmd = scenario([("src/a.py", 10)], mtime_files=["src/a.py", "tests/t.py"])
    c, o, e = sh(cmd)
    cases.append(("writes inside FILES", "pass", c == 0 and "0 OUT" in o, o + e))
    seat, cmd = scenario([("/tmp/ogl-scratch.txt", 5)])
    c, o, e = sh(cmd)
    cases.append(("temp-dir write is not OUT", "pass", c == 0 and " tmp " in o, o + e))
    seat, cmd = scenario([("src/old.py", 120)], old_files=["docs/old.md"])
    c, o, e = sh(cmd)
    cases.append(("writes before the window are ignored", "pass", c == 0, o + e))

    seat, cmd = scenario([("src/a.py", 10), ("README.md", 5)], mtime_files=["src/a.py"])
    c, o, e = sh(cmd)
    cases.append(("transcript write outside FILES", "fail", c == 3 and "OUT" in o, o + e))
    seat, cmd = scenario([], mtime_files=["config.json"])
    c, o, e = sh(cmd)
    cases.append(("Bash write seen by mtime", "fail", c == 3, o + e))
    seat, cmd = scenario([("src/a.py", 10)], desc="TASK: fix it\nBAR: x\nRETURN: y")
    c, o, e = sh(cmd)
    cases.append(("no FILES line: every write is OUT", "fail", c == 3, o + e))
    seat, cmd = scenario([])
    c, o, e = sh(cmd[:2] + ["task_missing"] + cmd[3:])
    cases.append(("task not found", "fail", c == 2, o + e))
    c, o, e = sh(["python3", str(TOOLS / "brief_audit.py"), "task_1"])
    cases.append(("no agents dir", "fail", c == 2, o + e))
    return tally("brief_audit.py", cases)


# ---------------------------------------------------------------- emit-truth-correction.sh
def test_emitter():
    E = str(TOOLS / "emit-truth-correction.sh")
    base = ["--dedupe-slug", "wrong-count", "--claim", "12 rows", "--correction", "10 rows"]
    env = {"CTX_AGENT_NAME": "worker"}
    root = Path(tempfile.mkdtemp(prefix="ogl-emit-")).resolve()
    other = write(root / "agents" / "auditor" / "report.md", "x", 0o644)
    own = write(root / "agents" / "worker" / "notes.md", "x", 0o644)
    outside = write(root / "loose" / "file.md", "x", 0o644)
    old = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=1)).timestamp()
    for p in (other, own, outside):
        os.utime(p, (old, old))
    ctx_root = root / "ctx"
    write(ctx_root / "logs" / "worker" / "inbound-messages.jsonl",
          json.dumps({"chat_id": 111, "message_id": 5, "from": 111, "text": "that number is wrong"}) + "\n"
          + json.dumps({"chat_id": 222, "message_id": 6, "from": 222, "text": "x"}) + "\n", 0o644)
    penv = dict(env, CTX_ROOT=str(ctx_root), OGL_PRINCIPAL_ID="111")
    future = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")

    def run(args, e=env):
        c, o, err = sh(["bash", E] + args, e)
        meta = {}
        if c == 0 and "--dry-run" in args:
            try: meta = json.loads(o)
            except ValueError: pass
        return c, meta, o + err

    cases = []
    c, m, o = run(["--kind", "self_correction"] + base + ["--dry-run"])
    cases.append(("self_correction", "pass", c == 0 and m.get("caught_by") == "worker" and m["dedupe_key"].startswith("worker.wrong-count."), o))
    c, m, o = run(["--kind", "peer_catch", "--triggering-msg", "1790000000000-auditor-ab12c"] + base + ["--dry-run"])
    cases.append(("peer_catch derives caught_by", "pass", c == 0 and m.get("caught_by") == "auditor", o))
    c, m, o = run(["--kind", "artifact_catch", "--artifact-path", other, "--evidence-anchor", "row 3"] + base + ["--dry-run"])
    cases.append(("artifact_catch credits the file's seat", "pass", c == 0 and m.get("caught_by") == "auditor", o))
    c, m, o = run(["--kind", "artifact_catch", "--artifact-path", own] + base + ["--dry-run"])
    cases.append(("own artifact collapses to self_correction", "pass", c == 0 and m.get("kind") == "self_correction", o))
    c, m, o = run(["--kind", "principal_catch", "--principal-evidence", "telegram:111:5"] + base + ["--dry-run"], penv)
    cases.append(("principal_catch with a real record", "pass", c == 0 and m.get("caught_by") == "principal", o))
    c, m, o = run(["--kind", "known_unrecordable_catch", "--candidate-set", '{"ids":[],"source":"voice"}'] + base + ["--dry-run"])
    cases.append(("known_unrecordable_catch", "pass", c == 0 and m.get("resolve_mode") == "propose-only", o))
    c, m, o = run(["--kind", "self_correction", "--occurred-at", "2026-01-02T03:04:05.123+02:00"] + base + ["--dry-run"])
    cases.append(("offset time normalised", "pass", c == 0 and m.get("occurred_at") == "2026-01-02T01:04:05Z", o))
    fakebin = tempfile.mkdtemp(prefix="ogl-fakebin-")
    log = os.path.join(fakebin, "calls.txt")
    write(os.path.join(fakebin, "cortextos"), f'#!/bin/bash\nprintf "%s\\n" "$@" > {log}\n')
    c, m, o = run(["--kind", "self_correction"] + base, dict(env, PATH=fakebin + os.pathsep + os.environ["PATH"]))
    called = open(log).read() if os.path.exists(log) else ""
    cases.append(("live emit calls log-event", "pass", c == 0 and "truth_correction" in called and '"caught_by": "worker"' in called, o + called))

    for label, args, e in [
        ("unknown kind", ["--kind", "peer_correction"] + base, env),
        ("missing dedupe slug", ["--kind", "self_correction", "--claim", "a", "--correction", "b"], env),
        ("slug with a dot", ["--kind", "self_correction", "--dedupe-slug", "a.b", "--claim", "a", "--correction", "b"], env),
        ("value flag swallowing --dry-run", ["--kind", "self_correction", "--dedupe-slug", "s", "--claim", "a", "--correction", "--dry-run"], env),
        ("no caught agent", ["--kind", "self_correction"] + base, {}),
        ("future occurred-at", ["--kind", "self_correction", "--occurred-at", future] + base, env),
        ("naive occurred-at", ["--kind", "self_correction", "--occurred-at", "2026-01-02T03:04:05"] + base, env),
        ("peer_catch without msg", ["--kind", "peer_catch"] + base, env),
        ("malformed msg id", ["--kind", "peer_catch", "--triggering-msg", "auditor"] + base, env),
        ("principal record from someone else", ["--kind", "principal_catch", "--principal-evidence", "telegram:222:6"] + base, penv),
        ("principal record missing", ["--kind", "principal_catch", "--principal-evidence", "telegram:111:99"] + base, penv),
        ("principal with a bus msg", ["--kind", "principal_catch", "--principal-evidence", "telegram:111:5",
                                      "--triggering-msg", "1790000000000-auditor-ab12c"] + base, penv),
        ("artifact outside a seat tree", ["--kind", "artifact_catch", "--artifact-path", outside] + base, env),
        ("artifact newer than the catch", ["--kind", "artifact_catch", "--artifact-path", other,
                                           "--occurred-at", "2020-01-01T00:00:00Z"] + base, env),
        ("candidate set not an object", ["--kind", "known_unrecordable_catch", "--candidate-set", "[1]"] + base, env),
    ]:
        safe = dict(e, PATH=fakebin + os.pathsep + os.environ["PATH"])   # a wrongly accepted case hits the fake CLI
        c, m, o = run(args + ["--dry-run"] if "--dry-run" not in args else args, safe)
        cases.append((label, "fail", c == 2, o))
    return tally("emit-truth-correction", cases)


def main():
    results = [test_ship(), test_hunter(), test_brief_audit(), test_emitter()]
    return all(results)


if __name__ == "__main__":
    sys.exit(0 if main() else 1)

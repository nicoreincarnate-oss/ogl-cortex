"""Installer: memory hooks, optional memory components, settings merge, and the marked-block merge of the OGL
templates into existing seat and org files. Runs against a fake $HOME and a fake seat in a temp dir."""
import json, os, subprocess, sys, tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import memfixtures as fx  # noqa: E402

HARNESS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def install(seat, *flags, home):
    r = subprocess.run(["bash", os.path.join(HARNESS, "install.sh"), seat, *flags], capture_output=True, text=True,
                       env=dict(os.environ, HOME=home), timeout=120)
    return r.returncode, r.stdout, r.stderr


def snapshot(root):
    out = {}
    for d, _, files in os.walk(root):
        for f in files:
            p = os.path.join(d, f)
            out[p] = open(p, "rb").read()
    return out


def fake_seat():
    root = tempfile.mkdtemp(prefix="ogl-inst-")
    home = os.path.join(root, "home"); os.makedirs(os.path.join(home, ".claude"))
    fx.write(os.path.join(home, ".claude", "CLAUDE.md"), "# My global rules\nBe brief.\n")
    org = os.path.join(root, "orgs", "acme")
    seat = os.path.join(org, "agents", "boss")
    fx.write(os.path.join(seat, "CLAUDE.md"), "# Framework seat file\nORIGINAL-SEAT-TEXT\n")
    fx.write(os.path.join(seat, "GUARDRAILS.md"), "# Guardrails\nORIGINAL-GUARDRAILS\n")
    fx.write(os.path.join(seat, "HEARTBEAT.md"), "# Heartbeat\nORIGINAL-HEARTBEAT\n")
    fx.write(os.path.join(seat, "MEMORY.md"), "# Memory\nORIGINAL-MEMORY\n")
    fx.write(os.path.join(org, "knowledge.md"), "# Org KB\n## Business\nORIGINAL-ORG\n")
    fx.write(os.path.join(seat, ".claude", "settings.json"), json.dumps({"autoCompactWindow": 250000, "statusLine": {"type": "command", "command": "x"},
             "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "cortextos bus hook-idle-flag", "timeout": 5}]}]}}))
    return root, home, org, seat


def main():
    work, broke = [], []
    root, home, org, seat = fake_seat()
    before = snapshot(root)
    c, out, err = install(seat, "--with-digest", "--with-notes-recall", "--with-client-graph", home=home)
    work.append(("dry run writes nothing", c == 0 and snapshot(root) == before and "Dry run" in out))

    c, out, err = install(seat, "--apply", "--with-digest", "--with-notes-recall", "--with-client-graph", home=home)
    work.append(("--apply exits 0", c == 0))
    claude = open(os.path.join(seat, "CLAUDE.md")).read()
    work.append(("seat CLAUDE.md keeps its text and gains one OGL block", "ORIGINAL-SEAT-TEXT" in claude
                 and claude.count("<!-- OGL-CORTEX:BEGIN seat-rules") == 1 and "## STATE.md checkpoints" in claude))
    work.append(("merged block starts at Session start (no second title), <seat> filled",
                 "<seat>" not in claude.split("OGL-CORTEX:BEGIN")[1] and "# <seat>" not in claude and "boss" in claude))
    work.append(("CLAUDE.md backed up before the merge", any(f.startswith("CLAUDE.md.bak-") for f in os.listdir(seat))))
    work.append(("no CLAUDE.ogl-template.md parked beside it", not os.path.exists(os.path.join(seat, "CLAUDE.ogl-template.md"))))
    g = open(os.path.join(seat, "GUARDRAILS.md")).read()
    h = open(os.path.join(seat, "HEARTBEAT.md")).read()
    work.append(("GUARDRAILS and HEARTBEAT keep their text and gain the OGL blocks",
                 "ORIGINAL-GUARDRAILS" in g and "G-UNTRUSTED-READS" in g and "ORIGINAL-HEARTBEAT" in h and "Checkpoint health" in h))
    work.append(("MEMORY.md left as is; ENTITIES.md and STATE.md created; memory/ created",
                 open(os.path.join(seat, "MEMORY.md")).read() == "# Memory\nORIGINAL-MEMORY\n"
                 and "Write gate" in open(os.path.join(seat, "ENTITIES.md")).read()
                 and os.path.exists(os.path.join(seat, "STATE.md")) and os.path.isdir(os.path.join(seat, "memory"))))
    k = open(os.path.join(org, "knowledge.md")).read()
    work.append(("org knowledge.md keeps its text, gains fleet rules; org GUARDRAILS.md created",
                 "ORIGINAL-ORG" in k and "Fleet conventions" in k and k.count("## Business") == 1
                 and "Proven, Inferred, Open" in open(os.path.join(org, "GUARDRAILS.md")).read()))
    s = json.load(open(os.path.join(seat, ".claude", "settings.json")))
    cmds = [hh["command"] for gg in s["hooks"].values() for grp in gg for hh in grp["hooks"]]
    work.append(("settings gain the memory hooks", all(any(n in c2 for c2 in cmds) for n in
                 ["precompact_checkpoint.py", "sessionstart_inject.py", "session_facts.py", "session_end.py", "session_start.py",
                  "index/recall_hook.py", "client-graph/recall_hook.py"])))
    work.append(("existing autoCompactWindow and other keys kept; idle flag not duplicated",
                 s["autoCompactWindow"] == 250000 and "statusLine" in s and cmds.count("cortextos bus hook-idle-flag") == 1))
    mem = os.path.join(seat, ".claude", "hooks", "ogl", "memory")
    work.append(("digest and client-graph code installed, no data files", os.path.exists(os.path.join(mem, "session-digest", "digest", "config.json"))
                 and os.path.exists(os.path.join(mem, "client-graph", "build_graph.py"))
                 and not os.path.exists(os.path.join(mem, "client-graph", "graph.db"))
                 and not os.path.exists(os.path.join(mem, "client-graph", "fixtures"))))
    work.append(("~/.claude untouched without --user-level", open(os.path.join(home, ".claude", "CLAUDE.md")).read() == "# My global rules\nBe brief.\n"))

    # the installed hook works from the seat
    tx = fx.transcript(os.path.join(root, "t.jsonl"))
    r = subprocess.run([sys.executable, os.path.join(mem, "precompact_checkpoint.py")], input=json.dumps({"transcript_path": tx}),
                       capture_output=True, text=True, env=dict(os.environ, CLAUDE_PROJECT_DIR=seat))
    work.append(("installed checkpoint hook captures from a transcript", r.returncode == 0
                 and "Captured 5 of 5" in open(os.path.join(seat, "memory", "checkpoints", "latest.md")).read()))

    snap = snapshot(root)
    c, out, _ = install(seat, "--apply", "--with-digest", "--with-notes-recall", "--with-client-graph", home=home)
    after = snapshot(root)
    new_files = [p for p in after if p not in snap]
    work.append(("second --apply changes nothing (idempotent)", c == 0 and "Done: 0 change(s)" in out and not new_files
                 and all(after[p] == snap[p] for p in snap)))

    c, out, _ = install(seat, "--apply", "--user-level", home=home)
    uc = open(os.path.join(home, ".claude", "CLAUDE.md")).read()
    work.append(("--user-level merges the read-order block into ~/.claude/CLAUDE.md", c == 0 and "Be brief." in uc
                 and uc.count("OGL-CORTEX:BEGIN memory-read-order") == 1 and "kb-query" in uc))

    fresh = tempfile.mkdtemp(prefix="ogl-inst-fresh-")
    c, out, _ = install(fresh, "--apply", home=home)
    fc = open(os.path.join(fresh, "CLAUDE.md")).read()
    work.append(("a seat with no CLAUDE.md gets the whole template in a block", c == 0 and fc.startswith("<!-- OGL-CORTEX:BEGIN seat-rules")
                 and "## Compact instructions" in fc))
    work.append(("a seat outside orgs/<org>/agents skips org files", "org files skipped" in out))

    # must-not-break
    root2, home2, org2, seat2 = fake_seat()
    open(os.path.join(seat2, ".claude", "settings.json"), "w").write("{broken json")
    c, out, err = install(seat2, "--apply", home=home2)
    broke.append(("invalid settings.json: stops with an error, settings untouched", c != 0 and "not valid JSON" in err
                  and open(os.path.join(seat2, ".claude", "settings.json")).read() == "{broken json"))
    c, _, err = install(seat2, "--with-notes-recall", home=home2)
    broke.append(("--with-notes-recall alone is refused", c == 64))
    c, _, err = install(home2, "--apply", home=home2)
    broke.append(("$HOME as a seat is refused", c == 64))
    c, _, _ = install(os.path.join(root2, "nope"), home=home2)
    broke.append(("missing seat dir: exit 66", c == 66))
    root3, home3, org3, seat3 = fake_seat()
    open(os.path.join(seat3, "CLAUDE.md"), "a").write("\n<!-- OGL-CORTEX:BEGIN seat-rules old -->\nSTALE-BLOCK\n<!-- OGL-CORTEX:END seat-rules -->\nAFTER-BLOCK\n")
    c, _, _ = install(seat3, "--apply", home=home3)
    c3 = open(os.path.join(seat3, "CLAUDE.md")).read()
    broke.append(("an existing block is replaced in place, text after it kept", c == 0 and "STALE-BLOCK" not in c3
                  and c3.count("OGL-CORTEX:BEGIN seat-rules") == 1 and c3.rstrip().endswith("AFTER-BLOCK")))

    for label, ok in work + broke:
        if not ok:
            print(f"[install_memory] FAIL: {label}")
    w, b = sum(ok for _, ok in work), sum(ok for _, ok in broke)
    passed = w == len(work) and b == len(broke)
    print(f"{'install.sh (memory)':<22} must-work {w}/{len(work)}   must-not-break {b}/{len(broke)}   {'PASS' if passed else 'FAIL'}")
    return passed


if __name__ == "__main__":
    sys.exit(0 if main() else 1)

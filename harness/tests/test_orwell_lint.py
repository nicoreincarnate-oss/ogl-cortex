"""Orwell send-lint: bad sends block (exit 2); clean sends, non-sends and released sends pass."""
import os, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from hookrun import bash, check, report, run, tool

HOOK = "orwell_lint.py"
SEND = "cortextos bus send-telegram 123 "


def released_state():
    d = tempfile.mkdtemp(prefix="ogl-orwell-token-")
    open(os.path.join(d, ".orwell-pass-once-tester"), "w").close()
    return d


def main():
    block = [
        ("stock phrase", bash(SEND + "'At the end of the day the deploy is fine.'")),
        ("long word", bash(SEND + "'We will utilize the new script.'")),
        ("filler", bash(SEND + "'It is basically done.'")),
        ("jargon", bash(SEND + "'The stakeholders want actionable output.'")),
        ("passive with by", bash(SEND + "'The report was written by the team.'")),
        ("em dash", bash(SEND + "'Checkout is down — fixing now.'")),
        ("send on line 2", bash("echo start\n" + SEND + "'We will utilize it.'")),
        ("line 2 of a multi-line message", bash(SEND + "'Checkout is up.\nWe will utilize the new script.'")),
        ("send after &&", bash("cd /tmp && " + SEND + "\"Going forward we ship daily.\"")),
        ("MCP email send", tool("mcp__mail__send_gmail_message", {"subject": "Update", "body": "We will leverage the plan."})),
        ("extra send verb", bash("cortextos bus send-message boss normal 'We will utilize it.'"),
         {"OGL_ORWELL_SEND_VERBS": "send-telegram,send-message"}),
        ("crash on a send fails closed", bash(SEND + "'Checkout is up.'"), {"ORWELL_SELFTEST_CRASH": "1"}),
    ]
    allow = [
        ("clean send", bash(SEND + "'Checkout is up. The fix went out at 10:12 and every probe since has passed.'")),
        ("clean numbers", bash(SEND + "'Two of the 113 keywords are ours.'")),
        ("not a send", bash("echo 'At the end of the day we utilize it.'")),
        ("heredoc that mentions a send", bash("cat > x.sh <<'EOF'\n" + SEND + "'We will utilize it.'\nEOF")),
        ("comment line", bash("# " + SEND + "'We will utilize it.'\nls")),
        ("agent message not linted by default", bash("cortextos bus send-message boss normal 'We will utilize it.'")),
        ("clean MCP email", tool("mcp__mail__send_gmail_message", {"subject": "Update", "body": "The fix is live."})),
        ("non-send MCP tool", tool("mcp__mail__search_threads", {"query": "utilize"})),
        ("released once by pass token", bash(SEND + "'We will utilize it.'"), {"OGL_STATE_DIR": released_state()}),
        ("crash out of scope fails open", bash("ls"), {"ORWELL_SELFTEST_CRASH": "1"}),
    ]
    ok = report("orwell_lint", check("orwell_lint", HOOK, block, allow))
    # --text mode, used by scripts that send on their own
    code_bad, _, _ = run(HOOK, "We will utilize it.", args=("--text",))
    code_ok, _, _ = run(HOOK, "The fix is live.", args=("--text",))
    text_ok = code_bad == 2 and code_ok == 0
    print(f"{'orwell_lint --text':<22} must-block {int(code_bad == 2)}/1   must-allow {int(code_ok == 0)}/1   {'PASS' if text_ok else 'FAIL'}")
    return ok and text_ok


if __name__ == "__main__":
    sys.exit(0 if main() else 1)

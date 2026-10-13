"""Brief guard: a dispatch to another agent without TASK/FILES/BAR/RETURN blocks (exit 2)."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from hookrun import bash, check, report, tool

HOOK = "brief_guard.py"
FULL = "TASK: fix the login test\nFILES: src/auth/, tests/auth/\nBAR: npm test passes\nRETURN: commit hash + test output"


def ct(desc, assignee="worker", extra=""):
    return bash(f"cortextos bus create-task 'Fix login' --desc '{desc}' --assignee {assignee} {extra}".strip())


def main():
    block = [
        ("no brief", ct("fix the login")),
        ("missing RETURN", ct("TASK: fix it\nFILES: src/\nBAR: tests pass")),
        ("empty BAR", ct("TASK: fix it\nFILES: src/\nBAR:\nRETURN: hash")),
        ("BAR only a $VAR", ct("TASK: fix it\nFILES: src/\nBAR: $BAR\nRETURN: hash")),
        ("--assignee=x form", bash("cortextos bus create-task 'Fix' --desc 'fix it' --assignee=worker")),
        ("--desc=x form", bash("cortextos bus create-task 'Fix' --desc='fix it' --assignee worker")),
        ("wrapper script positional", bash("bus/create-task.sh 'Fix' 'fix it' worker")),
        ("second command in a chain", bash("echo hi && cortextos bus create-task 'Fix' --desc 'x' --assignee worker")),
        ("heredoc fed to bash", bash("bash <<'EOF'\ncortextos bus create-task 'Fix' --desc 'x' --assignee worker\nEOF")),
    ]
    allow = [
        ("full brief", ct(FULL)),
        ("brief, any case and order", ct("return: hash\nbar: tests pass\nfiles: src/\ntask: fix it")),
        ("task for self", ct("fix it", assignee="tester")),
        ("no assignee", bash("cortextos bus create-task 'Fix' --desc 'fix it'")),
        ("not a dispatch", bash("cortextos bus list-tasks --status pending")),
        ("heredoc doc mentioning a dispatch", bash("cat > notes.md <<'EOF'\ncortextos bus create-task 'Fix' --assignee worker\nEOF")),
        ("non-Bash tool", tool("Write", {"file_path": "x.md", "content": "create-task --assignee worker"})),
    ]
    return report("brief_guard", check("brief_guard", HOOK, block, allow))


if __name__ == "__main__":
    sys.exit(0 if main() else 1)

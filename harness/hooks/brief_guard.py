#!/usr/bin/env python3
"""OGL Cortex brief guard. PreToolUse hook for the Bash tool.

A task handed to ANOTHER agent must carry the four-line brief.
Dispatch = `cortextos bus create-task ... --assignee <agent>` where <agent> is not this seat (CTX_AGENT_NAME),
or the bus/create-task.sh wrapper with a third positional argument.
The --desc must hold four lines that start TASK:, FILES:, BAR:, RETURN: (any case, any order), each with a value.
Unexpanded $VARS count as empty.
Blocks with exit 2 and the reason on stderr. Anything else passes untouched.
An internal error fails CLOSED on a command that looks like a dispatch, OPEN otherwise.
"""
import json, os, re, shlex, sys

FIELDS = ("TASK", "FILES", "BAR", "RETURN")
SELF = os.environ.get("CTX_AGENT_NAME", "")


HEREDOC = re.compile(r"<<-?\s*['\"]?(\w+)['\"]?[^\n]*\n(.*?)\n\s*\1\s*(?=\n|$)", re.S)
SHELLS = re.compile(r"(?:^|[\s;&|(])(?:bash|sh|zsh|source|\.)\s*(?:-\w+\s*)*<<-?\s*['\"]?\w+['\"]?[^\n]*$")
VAR = re.compile(r"\$\{[^}]*\}|\$\w+|\$\([^)]*\)")


def strip_heredocs(cmd):
    """A heredoc body is data (a doc, a file, a script for python) unless it is fed to a shell: then it IS commands.
    Shell-fed bodies are kept as extra command lines; the rest are dropped."""
    out, pos, extra = [], 0, []
    for m in HEREDOC.finditer(cmd):
        line_start = cmd.rfind("\n", 0, m.start()) + 1
        if SHELLS.search(cmd[line_start:m.start()] + cmd[m.start():cmd.find("\n", m.start())]):
            extra.append(m.group(2))
        out.append(cmd[pos:m.start()]); pos = m.end()
    out.append(cmd[pos:])
    return "".join(out) + ("\n" + "\n".join(extra) if extra else "")


def segments(cmd):
    """Split a shell line on ; && || | and newlines so each create-task call is seen on its own."""
    cmd = strip_heredocs(cmd)
    out = []
    for line in re.split(r"\n(?=(?:[^'\"]|'[^']*'|\"[^\"]*\")*$)", cmd):
        try:
            toks = shlex.split(line, posix=True)
        except ValueError:
            toks = line.split()
        seg = []
        for t in toks:
            if t in (";", "&&", "||", "|"):
                out.append(seg); seg = []
            else:
                seg.append(t)
        out.append(seg)
    return out


def brief_missing(desc):
    """Fields with no real value. Unexpanded $VARS count as empty: the shell may expand them to nothing."""
    return [f for f in FIELDS if not re.search(rf"(?im)^[ \t]*{f}[ \t]*:[ \t]*(.*)$", desc)
            or not any(VAR.sub("", m).strip() for m in re.findall(rf"(?im)^[ \t]*{f}[ \t]*:[ \t]*(.*)$", desc))]


def parse(seg):
    """(assignee, desc) for a create-task call in this segment, or None. Covers the CLI (--x v and --x=v)
    and the bus/create-task.sh wrapper, which takes <title> [desc] [assignee] positionally."""
    if any(t.endswith("create-task.sh") for t in seg):
        i = next(i for i, t in enumerate(seg) if t.endswith("create-task.sh"))
        pos = [t for t in seg[i + 1:] if not t.startswith("-")]
        return (pos[2] if len(pos) > 2 else "", pos[1] if len(pos) > 1 else "")
    if "create-task" not in seg or "bus" not in seg:
        return None
    opts, i = {}, 0
    while i < len(seg):
        t = seg[i]
        if "=" in t and t.split("=", 1)[0] in ("--assignee", "--desc"):
            k, v = t.split("=", 1); opts[k] = v; i += 1
        elif t in ("--assignee", "--desc") and i + 1 < len(seg):
            opts[t] = seg[i + 1]; i += 2
        else:
            i += 1
    return (opts.get("--assignee", ""), opts.get("--desc", ""))


def check(cmd):
    """Return a list of problems, empty when the command may run."""
    problems = []
    for seg in segments(cmd):
        got = parse(seg)
        if not got:
            continue
        who, desc = got
        if not who or who == SELF:
            continue
        missing = brief_missing(desc)
        if missing:
            problems.append(f"task for {who} lacks brief line(s): {', '.join(missing)}")
    return problems


def main():
    try:
        data = json.load(sys.stdin)
    except ValueError:
        sys.exit(0)
    if data.get("tool_name") != "Bash":
        sys.exit(0)
    problems = check((data.get("tool_input") or {}).get("command", ""))
    if problems:
        sys.stderr.write("BRIEF GUARD BLOCKED this dispatch. " + "; ".join(problems) +
                         ".\nPut four lines in --desc:\nTASK: one job, one sentence a stranger could act on\n"
                         "FILES: what it may touch, nothing else\nBAR: what done means, checkable (test, screenshot, number)\n"
                         "RETURN: the short shape of what comes back\n")
        sys.exit(2)
    sys.exit(0)


if __name__ == "__main__":
    raw = sys.stdin.read()
    sys.stdin = __import__("io").StringIO(raw)
    try:
        if os.environ.get("BRIEF_GUARD_SELFTEST_CRASH"):
            raise RuntimeError("selftest crash")
        main()
    except SystemExit:
        raise
    except Exception as ex:  # fail CLOSED in scope, OPEN out of scope: a guard bug must not lock every Bash call
        if "create-task" in raw and ("--assignee" in raw or "create-task.sh" in raw):
            sys.stderr.write(f"BRIEF GUARD ERROR ({type(ex).__name__}): could not check this dispatch, so it is blocked. Fix the guard or the command.\n")
            sys.exit(2)
        sys.exit(0)

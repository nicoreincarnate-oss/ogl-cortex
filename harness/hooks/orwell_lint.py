#!/usr/bin/env python3
"""OGL Cortex Orwell send-lint. PreToolUse hook for Bash and for MCP send tools.

Lints outgoing human-facing text against George Orwell's six rules ("Politics and the English Language", 1946)
plus a no-em-dash rule. Deterministic: no model involved. Blocks the send (exit 2, reasons on stderr) until the
text passes.

What counts as a send:
  - Bash: `cortextos bus <verb> <chat-id> "<text>"` for each verb in OGL_ORWELL_SEND_VERBS (default send-telegram).
    The whole quoted message is linted, multi-line included. Heredoc bodies and shell comments are not sends.
  - MCP tools whose name contains one of OGL_ORWELL_MCP_TOOLS (default: send_gmail_message, send-a-new-message,
    create-post, reply, forward, create_draft). Fields subject/body/message/text/content/summary are linted.

Rule 6 ("break any of these rules sooner than say anything outright barbarous") is the conscious exception:
    touch "$OGL_STATE_DIR/.orwell-pass-once-$CTX_AGENT_NAME"     (default OGL_STATE_DIR: ~/.ogl-cortex/state)
The token is per seat, consumed once, valid for 10 minutes, and logged.

Text mode for scripts that send on their own: echo "$MSG" | python3 orwell_lint.py --text   (exit 2 on issues)
An internal error fails CLOSED on a send and OPEN on anything else.
Self-test: python3 orwell_lint.py --selftest
"""
import sys, json, re, os, time, shlex, io

STOCK = [
 "at the end of the day","low-hanging fruit","low hanging fruit","move the needle","game changer","game-changer","deep dive",
 "double-edged sword","silver bullet","tip of the iceberg","in a nutshell","think outside the box","hit the ground running",
 "on the same page","circle back","touch base","boil the ocean","level up","best of both worlds","elephant in the room",
 "needle in a haystack","light at the end of the tunnel","moving forward","going forward","paradigm shift","secret sauce",
 "north star","holy grail","perfect storm","no-brainer","no brainer","win-win","the bottom line","bandwidth","unlock",
 "supercharge","turbocharge","laser-focused","laser focused","crystal clear","cutting-edge","cutting edge","state-of-the-art",
 "state of the art","best-in-class","best in class","world-class","next-level","next level","rock solid","bulletproof",
 "in the driver's seat","under the hood","on the radar","red flag","green light","the ball is in","ducks in a row",
 "a testament to","stands as a","serves as a","landscape","tapestry","journey","delve","robust","seamless","synergy",
]
LONG = {
 "utilize":"use","utilise":"use","utilization":"use","commence":"start","terminate":"end","facilitate":"help","endeavor":"try",
 "endeavour":"try","additional":"more","approximately":"about","sufficient":"enough","demonstrate":"show","numerous":"many",
 "purchase":"buy","assist":"help","assistance":"help","initiate":"start","subsequently":"then","subsequent":"later",
 "prior to":"before","in order to":"to","due to the fact that":"because","at this point in time":"now","with regard to":"about",
 "with regards to":"about","in regards to":"about","regarding":"about","in the event that":"if","methodology":"method",
 "functionality":"what it does","leverage":"use","attempt":"try","ascertain":"find out","individuals":"people","remainder":"rest",
 "requirement":"need","requirements":"needs","obtain":"get","currently":"now","immediately":"now","majority":"most",
 "component":"part","components":"parts","implement":"build","implementation":"build","optimal":"best","optimize":"improve",
 "optimise":"improve","expedite":"speed up","transmit":"send","notify":"tell","notification":"message","in addition":"also",
 "additionally":"also","furthermore":"also","nevertheless":"still","however,":"but","therefore":"so","consequently":"so",
 "accordingly":"so","in conclusion":"so","modification":"change","modify":"change","indicate":"show","indicates":"shows",
 "frequently":"often","sufficiently":"enough","substantial":"big","enumerate":"list","validate":"check",
}
FILLER = [
 "very","really","actually","basically","essentially","literally","absolutely","definitely","quite","rather",
 "in fact","it is important to note","needless to say","as you know","kind of","sort of","the fact that","in terms of",
 "a total of","for all intents and purposes","at the present time","in the process of","it should be noted","please note",
 "as a matter of fact","in my opinion","i think that","i believe that","it is worth noting","worth noting",
]
JARGON = [
 "per se","vis-a-vis","vis-à-vis","ad hoc","de facto","status quo","bona fide","modus operandi","ergo","a priori",
 "raison d'etre","raison d'être","mea culpa","carte blanche","fait accompli","quid pro quo","synergy","synergies",
 "paradigm","ecosystem","stakeholder","stakeholders","actionable","holistic","scalable","scalability","streamline",
 "ideate","ideation","learnings","onboarding","operationalize","operationalise","incentivize","incentivise","monetize",
 "monetise","touchpoint","touchpoints","deliverable","deliverables","alignment","align on",
 "core competency","value-add","value add","best practice","best practices","going-forward","mission-critical",
 "mission critical","cross-functional","end-to-end","end to end","turnkey","granular","granularity","vertical","verticals",
]
IRREG = "known|seen|done|made|given|taken|sent|built|found|held|kept|left|lost|paid|put|read|run|set|shown|told|thought|brought|bought|caught|taught|written|driven|chosen|broken|spoken|frozen|hidden|forgotten|begun|drawn|grown|thrown|worn|torn|sworn|born|led|fed|met|bred|shot|cut|hit|hurt|spent|meant|felt|dealt|understood|withstood|sold|struck|stuck|swung|hung|won|spun|sung|rung|lit|bitten|beaten|eaten|fallen|risen|stolen|woken|flown|blown|shaken|proven|got|gotten|lent|bent|laid|said|slid|split|spread|wed|fought|sought|swept|wept|crept|slept|leapt|dreamt|burnt|learnt"
PASSIVE = re.compile(r"\b(am|is|are|was|were|be|been|being|get|gets|got|getting)\s+(not\s+|\w+ly\s+)?(\w+ed|"+IRREG+r")\b(\s+by\b)?", re.I)
PASSIVE_OK = re.compile(r"\b(is|are|was|were|be)\s+(not\s+)?(done|set|used|based|called|named|located|closed|open|tired|interested|excited|worried|supposed|allowed|scheduled|expected|due|left|gone|finished|pleased|sorry|glad|happy|ready|able|likely|possible|dead|alive|armed|live|up|down|logged)\b", re.I)

def _word(s):
    return re.compile(r"(?<![\w-])" + re.escape(s) + r"(?![\w-])")

def lint(text):
    t = " " + re.sub(r"\s+", " ", text.lower()) + " "
    reasons = []
    if "—" in text or "–" in text: reasons.append("no em/en dashes: use a comma or a full stop")
    for s in STOCK:
        if _word(s).search(t): reasons.append(f"rule 1 stock phrase: \"{s}\"")
    for l, sh in LONG.items():
        if _word(l).search(t): reasons.append(f"rule 2 long word: \"{l}\" -> \"{sh}\"")
    for f in FILLER:
        if _word(f).search(t): reasons.append(f"rule 3 cut: \"{f}\"")
    for j in JARGON:
        if _word(j).search(t): reasons.append(f"rule 5 jargon/foreign: \"{j}\"")
    passives = [m.group(0) for m in PASSIVE.finditer(text) if not PASSIVE_OK.search(m.group(0))]
    strong = [p for p in passives if re.search(r"\bby\b", p)]
    if strong or len(passives) >= 2:
        reasons.append("rule 4 passive: " + "; ".join(f"\"{p.strip()}\"" for p in passives[:4]))
    seen = set(); out = []
    for r in reasons:
        if r not in seen: seen.add(r); out.append(r)
    return out

HEREDOC = re.compile(r"<<-?\s*['\"]?(\w+)['\"]?[^\n]*\n.*?\n\1\s*(?=\n|$)", re.S)
SEND_VERBS = [v for v in re.split(r"[\s,]+", os.environ.get("OGL_ORWELL_SEND_VERBS", "send-telegram")) if v]
INVOKE = re.compile(r"(?:^|[;&|(]\s*|\bthen\s+|\bdo\s+|\belse\s+)(?:[\w./~$]*/)?cortextos\s+bus\s+(?:"
                    + "|".join(re.escape(v) for v in SEND_VERBS) + r")\s+(.*?)(?=(?:\s*(?:[;&|]|\n|$)))", re.S | re.M)
MCP_SEND = [k for k in re.split(r"[\s,]+", os.environ.get(
    "OGL_ORWELL_MCP_TOOLS", "send_gmail_message,send-a-new-message,create-post,reply,forward,create_draft")) if k]
_COMMENT = re.compile(r"[ \t]*#[^\n]*")

def _strip_comments_qa(s):
    """Drop shell comment lines, but only outside quotes (a message line starting with # is message text)."""
    out, i, n, sq, dq, bol = [], 0, len(s), False, False, True
    while i < n:
        if bol and not sq and not dq:
            m = _COMMENT.match(s, i)
            if m: i = m.end(); bol = False; continue
        c = s[i]; out.append(c)
        if sq:
            if c == "'": sq = False
        elif c == "\\" and i + 1 < n: out.append(s[i + 1]); i += 2; bol = False; continue
        elif c == "'" and not dq: sq = True
        elif c == '"': dq = not dq
        bol = c == "\n"; i += 1
    return "".join(out)

def _seg_end(s, i):
    """Index where the send starting at s[i] ends: the first ; & | or newline OUTSIDE quotes and $(...)."""
    n, j, sq, dq, depth = len(s), i, False, False, 0
    while j < n:
        c = s[j]
        if sq:
            if c == "'": sq = False
        elif c == "\\": j += 2; continue
        elif depth:
            if c == "(": depth += 1
            elif c == ")": depth -= 1
            elif c == "'":
                k = s.find("'", j + 1); j = n if k < 0 else k
        elif c == "$" and s.startswith("$(", j): depth = 1; j += 2; continue
        elif c == "$" and s.startswith("$'", j) and not dq:          # ANSI-C $'...': backslash escapes apply
            j += 2
            while j < n and s[j] != "'": j += 2 if s[j] == "\\" else 1
        elif c == "'" and not dq: sq = True
        elif c == '"': dq = not dq
        elif not dq and c in ";&|\n": break
        j += 1
    return j

def _segments(stripped, invoke, full=True):
    """Send argument strings, quote-aware to the end of the message. A match that starts inside an earlier send's
    message is message text, not a second send."""
    out, consumed = [], -1
    for m in invoke.finditer(stripped):
        a = m.start(1)
        if a < consumed: continue
        b = _seg_end(stripped, a); out.append(stripped[a:b]); consumed = b
    return out

def extract(tool_name, ti):
    """Return outgoing human-facing text, or None if this tool call is not a send."""
    if tool_name == "Bash":
        cmd = ti.get("command", "") or ""
        if not any(v in cmd for v in SEND_VERBS): return None
        stripped = _strip_comments_qa(HEREDOC.sub("", cmd))   # text inside heredocs is a file write, not a send
        msgs = []
        for seg in _segments(stripped, INVOKE, True):
            try: parts = shlex.split(seg, posix=True)
            except ValueError: parts = seg.split()
            msg = []; skip = False
            for p in parts[1:]:                   # parts[0] is the chat id or recipient
                if skip: skip = False; continue
                if p in ("--image", "--file", "--parse-mode"): skip = True; continue
                if p.startswith("--"): continue
                if p.startswith((">", "2>", "1>", "<")) or p == "2>&1": break
                msg.append(p)
            if msg: msgs.append(" ".join(msg))
        return "\n".join(msgs) if msgs else None
    if tool_name.startswith("mcp__") and any(k in tool_name for k in MCP_SEND):
        return " ".join(str(ti.get(k, "")) for k in ("subject", "body", "message", "text", "content", "summary") if ti.get(k))
    return None

SEAT = re.sub(r"[^\w-]", "", os.environ.get("CTX_AGENT_NAME", "") or "") or "shared"
STATE = os.path.normpath(os.path.expanduser(os.environ.get("OGL_STATE_DIR") or "~/.ogl-cortex/state"))
PASS_ONCE = os.path.join(STATE, f".orwell-pass-once-{SEAT}")
LOG = os.path.join(STATE, "orwell-lint.log")

def _log(line):
    try:
        os.makedirs(STATE, exist_ok=True)
        with open(LOG, "a") as f: f.write(time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()) + " " + line + "\n")
    except OSError: pass

def selftest():
    must_flag = [
     "At the end of the day we need to utilize the new methodology going forward.",
     "The report was written by the team and the numbers were reviewed by the lead.",
     "This is basically a game changer that will really move the needle.",
     "Per se the stakeholders want actionable synergies across verticals.",
     "The checkout was down \u2014 the specialist fixed it.",
    ]
    must_pass = [
     "Checkout is up. The specialist fixed it at 10:12 and it has answered every probe since.",
     "Two of the 113 keywords are ours. The rest land on someone else.",
     "The dialog on the settings screen is waiting for a click. Cancel means no reboot.",
     "The site had 570 views in the last day and 0 orders.",
     "I am sorry, the file is done and the numbers are set.",
    ]
    bad = 0
    for s in must_flag:
        r = lint(s); print(("FLAG ok  " if r else "MISSED   ") + s[:60], "|", r[:2]); bad += 0 if r else 1
    for s in must_pass:
        r = lint(s); print(("PASS ok  " if not r else "FALSE+   ") + s[:60], "|", r[:2]); bad += 1 if r else 0
    hd = "cat > x.sh <<'EOF'\ncortextos bus send-telegram 0 'At the end of the day we utilize it.'\nEOF\necho done"
    real = "cortextos bus send-telegram 0 'At the end of the day we utilize it.' 2>&1 | tail -1"
    line2 = "echo start\ncortextos bus send-telegram 0 'At the end of the day we utilize it.'"
    e1, e2, e3 = extract("Bash", {"command": hd}), extract("Bash", {"command": real}), extract("Bash", {"command": line2})
    print("heredoc ignored:", "ok" if e1 is None else f"FAIL {e1!r}"); bad += 0 if e1 is None else 1
    print("real send seen: ", "ok" if e2 and "2>&1" not in e2 else f"FAIL {e2!r}"); bad += 0 if (e2 and "2>&1" not in e2) else 1
    print("line-2 send seen:", "ok" if e3 and lint(e3) else f"FAIL {e3!r}"); bad += 0 if (e3 and lint(e3)) else 1
    print("SELFTEST", "PASS" if bad == 0 else f"FAIL ({bad})"); sys.exit(0 if bad == 0 else 1)

def main():
    if "--selftest" in sys.argv: selftest()
    if "--text" in sys.argv:
        text = sys.stdin.read()
        reasons = lint(text)
        _log(f"{'BLOCK' if reasons else 'PASS'} script-text {len(reasons)} issues")
        if reasons:
            sys.stderr.write("- " + "\n- ".join(reasons) + "\n"); sys.exit(2)
        sys.exit(0)
    try: data = json.load(sys.stdin)
    except Exception: sys.exit(0)
    text = extract(data.get("tool_name", ""), data.get("tool_input", {}) or {})
    if not text: sys.exit(0)
    reasons = lint(text)
    if reasons and os.path.exists(PASS_ONCE) and time.time() - os.path.getmtime(PASS_ONCE) < 600:
        os.remove(PASS_ONCE)
        _log(f"EXCEPTION (rule 6, pass-once) seat={SEAT} {len(reasons)} issues")
        sys.exit(0)
    _log(f"{'BLOCK' if reasons else 'PASS'} seat={SEAT} {data.get('tool_name')} {len(reasons)} issues")
    if reasons:
        sys.stderr.write("ORWELL SEND-LINT BLOCKED this message. Rewrite and resend. Reasons:\n- " + "\n- ".join(reasons) +
                         f"\n(Conscious exception, rule 6: touch {PASS_ONCE} then resend; once, logged.)\n")
        sys.exit(2)
    sys.exit(0)

def _scope(raw):
    """Fail-closed scope, judged on the RAW input because a crash may be in the parser."""
    if "--text" in sys.argv or any(v in raw for v in SEND_VERBS): return True
    m = re.search(r'"tool_name"\s*:\s*"(mcp__[^"]*)"', raw)
    return bool(m and any(k in m.group(1) for k in MCP_SEND))

if __name__ == "__main__":
    raw = "" if "--selftest" in sys.argv else sys.stdin.read()
    sys.stdin = io.StringIO(raw)
    try:
        if os.environ.get("ORWELL_SELFTEST_CRASH"): raise RuntimeError("selftest crash")
        main()
    except SystemExit:
        raise
    except Exception as ex:
        if "--selftest" in sys.argv: raise
        closed = _scope(raw)
        _log(f"GUARD-ERROR {'FAIL-CLOSED' if closed else 'FAIL-OPEN'} {type(ex).__name__}: {str(ex)[:160]!r}")
        if closed:
            sys.stderr.write(f"ORWELL SEND-LINT ERROR ({type(ex).__name__}): it could not check this message, so the "
                             "send is blocked. Fix the guard; the pass-once token does not apply to a crash.\n")
            sys.exit(2)
        sys.exit(0)

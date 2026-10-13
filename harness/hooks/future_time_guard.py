#!/usr/bin/env python3
"""OGL Cortex future-time guard. PreToolUse hook for Bash, Write and Edit.

Refuses a log line or a send that stamps a UTC clock time in the future. An agent that writes times from memory
instead of from the clock produces stamps that are ahead of the real time; this catches them.

Checked text: Bash commands that touch memory/, STATE.md, send-telegram or send-message, and Write/Edit content for
files under memory/ or named STATE.md. A stamp is "HH:MM UTC" or "HH:MMZ". It is flagged when it is more than
OGL_FUTURE_SLACK_MIN minutes (default 3) ahead of now and less than 12 hours ahead. Dated stamps for other days,
ranges like 10:3x, "yesterday" stamps and planned times ("at", "by", "due", "scheduled" ...) are ignored.
Exit 2 blocks with the reason on stderr. Fails open on any error: it is a tripwire, not a gate.

Self-test: python3 future_time_guard.py --selftest
"""
import datetime as dt
import json
import os
import re
import sys

STAMP = re.compile(r"(?<![\d:])([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?\s?(?:UTC|Z)\b", re.I)
DATED = re.compile(r"(?:(\d{4})-)?(\d{1,2})-(\d{2})[ T]?$")
SLACK_MIN = int(os.environ.get("OGL_FUTURE_SLACK_MIN", "3") or 3)


def future_stamps(text, now):
    """(stamp, position) for each stamp more than SLACK_MIN minutes ahead of now, today."""
    bad = []
    for m in STAMP.finditer(text):
        before = text[max(0, m.start() - 12):m.start()]
        if re.search(r"yesterday\s*$", before, re.I):
            continue
        d = DATED.search(before)
        if d:  # dated stamp: only today's date is checked (10-08 18:04Z is not today's clock)
            y, mo, da = d.groups()
            if (int(y) if y else now.year, int(mo), int(da)) != (now.year, now.month, now.day):
                continue
        elif text[m.start() - 1:m.start()] in ("T", "t"):
            continue  # bare T10:58Z with no date: cannot tell the day
        t = now.replace(hour=int(m.group(1)), minute=int(m.group(2)), second=0, microsecond=0)
        ahead = (t - now).total_seconds() / 60
        if SLACK_MIN < ahead < 12 * 60:  # far "ahead" = yesterday's time, or a planned time; skip
            bad.append((m.group(0), m.start()))
    return bad


def payload_text(d):
    ti = d.get("tool_input") or {}
    name = d.get("tool_name", "")
    if name == "Bash":
        cmd = ti.get("command", "")
        if re.search(r"memory/|STATE\.md|send-telegram|send-message", cmd):
            return cmd
    elif name in ("Write", "Edit"):
        path = ti.get("file_path", "")
        if "/memory/" in path or path.endswith("STATE.md"):
            return ti.get("content", "") + ti.get("new_string", "")
    return ""


def planned(text, i):
    """Forward-looking words just before position i mean a planned time, not a claim."""
    i = dated_start(text, i)
    return bool(re.search(r"\b(at|by|for|until|due|before|after|next|from|to|window|review|starts?|ends?|planned|scheduled)\s*$", text[max(0, i - 25):i], re.I))


def dated_start(text, i):
    """Step back over a date prefix so "due 2026-10-09 15:00Z" reads its planned word."""
    d = DATED.search(text[max(0, i - 12):i])
    return i - len(d.group(0)) if d else i


def unplanned(text, now):
    return [s for s, i in future_stamps(text, now) if not planned(text, i)]


def main():
    try:
        d = json.load(sys.stdin)
        text = payload_text(d)
        if not text:
            return 0
        now = dt.datetime.now(dt.timezone.utc)
        bad = unplanned(text, now)
        if bad:
            print(f"FUTURE-TIME GUARD: {', '.join(bad)} is ahead of the real clock ({now:%H:%M}Z). "
                  "Take the time from date -u in the same command, or write it as planned (by/at/due).", file=sys.stderr)
            return 2
    except Exception:
        return 0
    return 0


def selftest():
    now = dt.datetime(2026, 10, 9, 10, 35, tzinfo=dt.timezone.utc)
    cases = [("COMPLETED 10:58 UTC: build", True), ("COMPLETED 10:34 UTC: build", False), ("sent 10:37Z", False),
             ("done 10:39Z", True), ("window to 2026-10-11T10:29:42Z", False), ("morning review 15:00Z", False), ("until 2026-10-11T12:00Z", False), ("NOTE 11:30 UTC: poll ok", True), ("last write 10-08 18:04Z", False), ("on 2026-10-08 18:04 UTC", False),
             ("10:3x UTC", False), ("yesterday 23:50 UTC", False),
             ("escalation queued for 15:00Z", False), ("check the chat 15:00Z", True), ("went into 15:00Z", True),
             ("deploy scheduled for 10:58Z; COMPLETED 10:58Z", True), ("COMPLETED 2026-10-09 10:58 UTC", True),
             ("sent 10-09 10:58Z", True), ("done 2026-10-09T10:58Z", True), ("done 10:58 utc", True), ("done 10:58z", True),
             ("sent 9:58 UTC", True, dt.datetime(2026, 10, 9, 9, 50, tzinfo=dt.timezone.utc)), ("sent 9:48 UTC", False, dt.datetime(2026, 10, 9, 9, 50, tzinfo=dt.timezone.utc)),
             ("review due 2026-10-09 15:00Z", False), ("tea at 4:30 pm", False)]
    ok = True
    for text, want, *at in cases:
        n = at[0] if at else now
        got = bool(unplanned(text, n))
        ok &= got == want
        print(("ok  " if got == want else "BAD ") + f"{text!r} -> flag={got} want={want}")
    return ok


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        sys.exit(0 if selftest() else 1)
    sys.exit(main())

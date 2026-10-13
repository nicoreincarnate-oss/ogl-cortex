#!/usr/bin/env python3
"""SessionStart hook: hand the agent its newest checkpoint and the tail of its daily memory.

Injects, as additionalContext:
  1. memory/checkpoints/latest.md, if younger than OGL_INJECT_MAX_AGE_HOURS (default 72),
     cut to the last OGL_INJECT_CHECKPOINT_CHARS characters (default 4000). A failed checkpoint
     (0 messages captured) is named as a failure, so a broken hook cannot look healthy.
  2. The last OGL_INJECT_DAILY_CHARS characters (default 3000) of today's daily memory file
     (UTC date), or yesterday's when today has none yet.
  3. A one-line reminder to read ENTITIES.md, when the seat has one.

Runs on every SessionStart source (startup, resume, clear, compact). Prints nothing when there is
nothing to inject. Never blocks and always exits 0.
"""
import json
import sys
import time
from datetime import timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import transcript as t  # noqa: E402


def tail(path, chars):
    text = path.read_text(encoding="utf-8", errors="replace")
    return text if len(text) <= chars else "[...]\n" + text[-chars:]


def main():
    data = t.read_hook_input()
    seat = t.seat_dir(data)
    parts = []

    ck = seat / "memory" / "checkpoints" / "latest.md"
    max_age = t.env_int("OGL_INJECT_MAX_AGE_HOURS", 72) * 3600
    if ck.is_file() and time.time() - ck.stat().st_mtime < max_age:
        body = tail(ck, t.env_int("OGL_INJECT_CHECKPOINT_CHARS", 4000))
        if "CHECKPOINT FAILED" in body:
            parts.append("WARNING: the last pre-compaction checkpoint captured nothing. Treat the checkpoint "
                         "layer as broken until a checkpoint shows a non-zero count; check the PreCompact hook.\n\n" + body)
        else:
            parts.append(body)

    now = t.utc_now()
    for day in (now, now - timedelta(days=1)):
        daily = seat / "memory" / f"{day:%Y-%m-%d}.md"
        if daily.is_file() and daily.stat().st_size > 0:
            parts.append(f"## Tail of daily memory {day:%Y-%m-%d}\n\n" + tail(daily, t.env_int("OGL_INJECT_DAILY_CHARS", 3000)))
            break

    if not parts:
        return
    if (seat / "ENTITIES.md").is_file():
        parts.append("Reminder: ENTITIES.md is the noun index. Answer questions about people, places and things "
                     "from it first. Check in-flight work above before redoing anything.")
    ctx = "[memory checkpoint injection: the seat's own files, read by a hook]\n\n" + "\n\n---\n\n".join(parts)
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": ctx}}))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # a session start is never blocked by this
        print(f"sessionstart_inject: {type(exc).__name__}: {exc}", file=sys.stderr)
    sys.exit(0)

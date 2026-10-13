#!/usr/bin/env python3
"""PreCompact hook: copy the last stretch of conversation to memory/checkpoints/ before compaction.

Writes:
  <seat>/memory/checkpoints/latest.md                       overwritten each compaction
  <seat>/memory/checkpoints/checkpoint-<YYYYMMDD-HHMMSS>.md  one per compaction, oldest pruned
  one NOTE line in <seat>/memory/<YYYY-MM-DD>.md            with the capture count

The hook reads its JSON payload from stdin first, in this process, so nothing else can consume
stdin before it (a shell heredoc wrapper would). A capture of zero messages is a failure: the file
says so in its first line, the daily note says CHECKPOINT FAILED, and the SessionStart inject hook
surfaces it to the agent. It never blocks compaction and always exits 0.

Environment (all optional):
  OGL_CHECKPOINT_MESSAGES   messages kept, newest last        (default 40)
  OGL_CHECKPOINT_CHARS      characters kept per message       (default 600)
  OGL_CHECKPOINT_KEEP       timestamped copies kept           (default 20)
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import transcript as t  # noqa: E402


def render(stamp, kept, total, trigger, source_ok):
    head = f"# Pre-compaction checkpoint {stamp}\n\n"
    if not kept:
        reason = "transcript_path missing or unreadable" if not source_ok else "no conversation text found in the transcript"
        return head + f"CHECKPOINT FAILED: 0 messages captured ({reason}). Trigger: {trigger}.\n"
    body = "\n\n".join(f"[{role}] {text}" for role, text in kept)
    return (head + f"Captured {len(kept)} of {total} conversation messages (newest last). Trigger: {trigger}.\n"
            "Mechanical extract: user and assistant text only, no tool output.\n\n" + body + "\n")


def main():
    data = t.read_hook_input()
    seat = t.seat_dir(data)
    now = t.utc_now()
    tp = data.get("transcript_path") or ""
    source_ok = bool(tp) and Path(tp).is_file()
    all_turns = t.turns(tp) if source_ok else []
    n = t.env_int("OGL_CHECKPOINT_MESSAGES", 40)
    width = t.env_int("OGL_CHECKPOINT_CHARS", 600)
    kept = [(role, text if len(text) <= width else text[:width] + " [...]") for role, text in all_turns[-n:]]
    text = render(now.strftime("%Y-%m-%d %H:%M UTC"), kept, len(all_turns), data.get("trigger") or "unknown", source_ok)

    ckdir = seat / "memory" / "checkpoints"
    ckdir.mkdir(parents=True, exist_ok=True)
    (ckdir / "latest.md").write_text(text, encoding="utf-8")
    (ckdir / f"checkpoint-{now:%Y%m%d-%H%M%S}.md").write_text(text, encoding="utf-8")
    keep = max(1, t.env_int("OGL_CHECKPOINT_KEEP", 20))
    for old in sorted(ckdir.glob("checkpoint-*.md"))[:-keep]:
        old.unlink(missing_ok=True)

    status = f"PreCompact checkpoint written ({len(kept)} msgs captured)" if kept else \
        "CHECKPOINT FAILED: PreCompact checkpoint captured 0 messages"
    with open(seat / "memory" / f"{now:%Y-%m-%d}.md", "a", encoding="utf-8") as f:
        f.write(f"\nNOTE {now:%H:%M} UTC: [hook] {status} -> memory/checkpoints/latest.md\n")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # compaction is never blocked by its own checkpoint
        print(f"precompact_checkpoint: {type(exc).__name__}: {exc}", file=sys.stderr)
    sys.exit(0)

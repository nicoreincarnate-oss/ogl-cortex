#!/usr/bin/env python3
"""PostCompact hook: store the compaction summary as a session fact for `cortextos bus recall-facts`.

The framework's hook-extract-facts is a PreCompact hook that reads a `summary` field. Claude Code's
PreCompact payload carries no summary (the summary does not exist yet), so that hook writes nothing.
The summary arrives at PostCompact as `compact_summary`. This hook writes it in the same JSON-lines
shape the framework reader expects:

  $CTX_ROOT/state/<agent>/memory/facts/<YYYY-MM-DD>.jsonl
  {"ts", "session_id", "agent", "org", "source": "postcompact", "summary", "keywords"}

CTX_ROOT defaults to ~/.cortextos/default and the agent to CTX_AGENT_NAME, else the seat folder name.
Never blocks and always exits 0.
"""
import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import transcript as t  # noqa: E402

STOPWORDS = set("""the a an and or but in on at to for of with by from is was are were be been has have had do does
did will would could should may might that this these those it its i we you he she they my our your their not no so
if then than as also just now up out what which who when where how about after before into through during each some
any""".split())


def keywords(text):
    """Same rule as the framework: words over 3 letters, seen twice or more, top 20 by count."""
    words = [w for w in re.sub(r"[^a-z0-9\s_-]", " ", text.lower()).split() if len(w) > 3 and w not in STOPWORDS]
    freq = {}
    for w in words:
        freq[w] = freq.get(w, 0) + 1
    ranked = sorted(((c, w) for w, c in freq.items() if c >= 2), key=lambda x: -x[0])
    return [w for _, w in ranked[:20]]


def main():
    data = t.read_hook_input()
    summary = (data.get("compact_summary") or data.get("summary") or "").strip()
    if len(summary) < 20:
        return
    seat = t.seat_dir(data)
    agent = os.environ.get("CTX_AGENT_NAME") or seat.name
    root = Path(os.environ.get("CTX_ROOT") or Path.home() / ".cortextos" / "default")
    now = t.utc_now()
    entry = {
        "ts": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "session_id": str(data.get("session_id") or f"session-{int(now.timestamp())}"),
        "agent": agent,
        "org": os.environ.get("CTX_ORG", ""),
        "source": "postcompact",
        "summary": summary[:8000],
        "keywords": keywords(summary),
    }
    folder = root / "state" / agent / "memory" / "facts"
    folder.mkdir(parents=True, exist_ok=True)
    with open(folder / f"{now:%Y-%m-%d}.jsonl", "a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"session_facts: {type(exc).__name__}: {exc}", file=sys.stderr)
    sys.exit(0)

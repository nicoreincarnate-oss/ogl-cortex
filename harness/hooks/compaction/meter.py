# OGL Cortex compaction kit. Pattern adapted from Glitch Cat Club, 'Controlled Compaction'. See harness/README.md (Licences).
"""PostToolUse: speaks once at the nudge, once at the warning, then stays quiet until the next compaction."""
from common import config, context_tokens, emit, hook_input, read_marks, write_marks

data = hook_input()
cfg = config()
tokens = context_tokens(data.get("transcript_path", ""))
marks = read_marks(data)
k, limit = tokens // 1000, cfg["limit"] // 1000
state = cfg["state_file"]

if tokens >= cfg["warning"] and "warning" not in marks:
    write_marks(data, sorted(set(marks) | {"nudge", "warning"}))
    emit("PostToolUse",
         f"Context meter: {k}k of your {limit}k limit. Compaction is close. "
         f"Your next action is to rewrite {state} in full, before any other tool call. "
         f"Then carry on: {state} comes back to you after compaction.")
elif tokens >= cfg["nudge"] and "nudge" not in marks:
    write_marks(data, marks + ["nudge"])
    emit("PostToolUse",
         f"Context meter: {k}k of your {limit}k limit. Keep working. "
         f"From now on, bring {state} up to date at every checkpoint.")

# OGL Cortex compaction kit. Pattern adapted from Glitch Cat Club, 'Controlled Compaction'. See harness/README.md (Licences).
"""SessionStart (matcher: compact): hand STATE.md back and reset the meter."""
from common import config, emit, hook_input, project_dir, write_marks

data = hook_input()
cfg = config()
write_marks(data, [])

state = project_dir(data) / cfg["state_file"]
if state.exists():
    emit("SessionStart",
         f"The conversation was just compacted. This is {cfg['state_file']}, your own record of where the work stands. "
         f"Trust it over the summary where they differ, then carry on.\n\n" + state.read_text(encoding="utf-8"))

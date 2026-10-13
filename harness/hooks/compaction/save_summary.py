# OGL Cortex compaction kit. Pattern adapted from Glitch Cat Club, 'Controlled Compaction'. See harness/README.md (Licences).
"""PostCompact: save the summary to compactions/<time>.md, so you can read what survived."""
from datetime import datetime

from common import config, hook_input, project_dir

data = hook_input()
cfg = config()
text = data.get("compact_summary", "")
if text:
    out = project_dir(data) / cfg["summaries_dir"]
    out.mkdir(exist_ok=True)
    (out / f"{datetime.now():%Y-%m-%d-%H%M%S}.md").write_text(text, encoding="utf-8")

# OGL Cortex session digest. Pattern adapted from Glitch Cat Club's memory starter. See harness/README.md (Licences).
"""Write up one staged session with no window, then feed it to the index.

    python3 headless_run.py digest/pending/<session>.md [<notes folder>]

session_end.py spawns this detached in headless mode. It reads the staged text,
asks Claude for the entry, appends it to today's digest file inside the notes folder, then
re-indexes that file (and distils it first when "distil" is true).

Nothing is thrown away on a failure. The staged file stays where it is and the
reason lands in digest/log/digest.log, so the next run can try again.
"""

import subprocess
import sys
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "index"))

import common  # noqa: E402
import distil  # noqa: E402


def append(log, entry, when=None):
    """Add the entry under its own time heading. The log is only appended to."""
    when = when or datetime.now()
    block = f"\n## Session {when:%H:%M}\n\n{entry.strip()}\n"
    with log.open("a", encoding="utf-8") as handle:
        handle.write(block)


def main(staged, notes=None):
    cfg = common.config()
    notes = Path(notes) if notes else common.corpus()
    if notes is None or not notes.is_dir():
        raise RuntimeError("no notes folder, so there is nowhere for the entry to live")
    text = staged.read_text(encoding="utf-8")
    if not text.strip():
        staged.unlink(missing_ok=True)
        return

    entry = distil.ask(cfg["model"], common.PROMPT.read_text(encoding="utf-8"), text)
    if not entry.strip():
        raise RuntimeError("the model returned nothing")

    log = common.today_log(notes, cfg)
    append(log, entry)
    staged.unlink(missing_ok=True)
    print(f"wrote {log}")

    if cfg["distil"]:
        # the entry reaches the index whether or not it distilled, because a
        # dropped distil still leaves a note that should be searchable
        distil.run(notes, paths=[log], rebuild=False)
    # re-index just this file; a full rebuild of a large notes folder takes minutes
    rel = log.resolve().relative_to(Path(notes).resolve()).as_posix()
    subprocess.run([sys.executable, str(HERE.parent / "index" / "build_index.py"),
                    "--corpus", str(notes), "--update", rel], check=False)


if __name__ == "__main__":
    distil.utf8_out()
    if len(sys.argv) < 2:
        sys.exit("usage: python3 headless_run.py <staged file> [<notes folder>]")
    path = Path(sys.argv[1])
    try:
        main(path, sys.argv[2] if len(sys.argv) > 2 else None)
    except Exception as exc:
        common.note_failure("headless_run", f"{path.name}: {type(exc).__name__} {exc}")
        sys.exit(1)

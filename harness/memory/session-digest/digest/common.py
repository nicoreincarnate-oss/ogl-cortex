# OGL Cortex session digest. Pattern adapted from Glitch Cat Club's memory starter. See harness/README.md (Licences).
"""What the digest scripts all need: the config, the notes folder, the failure log."""

import json
import os
import sqlite3
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONFIG = HERE / "config.json"
PROMPT = HERE / "digest-prompt.md"
PENDING = HERE / "pending"
LOG = HERE / "log"
INDEX_DB = HERE.parent / "index" / "index.db"
CHILD_MARK = "OGL_DIGEST_CHILD"  # set in the headless child, so its own SessionEnd is not digested

DEFAULTS = {
    "mode": "headless",
    "min_turns": 5,
    "max_turns": 120,
    "max_chars": 40000,
    "model": "sonnet",
    "corpus": "",
    "log_dir": "digests",
    "distil": False,
}


def config():
    """config.json over the defaults. A broken file never stops the digest."""
    cfg = dict(DEFAULTS)
    try:
        loaded = json.loads(CONFIG.read_text(encoding="utf-8"))
        if isinstance(loaded, dict):
            cfg.update(loaded)
    except Exception:
        pass
    return cfg


def seat_dir(payload=None):
    payload = payload or {}
    return Path(os.environ.get("CLAUDE_PROJECT_DIR") or payload.get("cwd") or os.getcwd())


def corpus(payload=None):
    """The notes folder digests are written into and indexed from. None when there is none.

    Order: the folder the index was built over; "corpus" in config.json (absolute, or relative
    to the seat); the seat's memory/ folder.
    """
    if INDEX_DB.is_file():
        try:
            db = sqlite3.connect(INDEX_DB)
            row = db.execute("SELECT value FROM meta WHERE key='corpus'").fetchone()
            db.close()
            if row and row[0] and Path(row[0]).is_dir():
                return Path(row[0])
        except Exception:
            pass
    seat = seat_dir(payload)
    configured = config().get("corpus") or ""
    if configured:
        path = Path(configured).expanduser()
        path = path if path.is_absolute() else seat / path
        return path if path.is_dir() else None
    default = seat / "memory"
    return default if default.is_dir() else None


def today_log(notes, cfg, when=None):
    """Today's digest file inside the notes folder. The folder is made if it is missing."""
    when = when or datetime.now()
    folder = Path(notes) / cfg["log_dir"]
    folder.mkdir(parents=True, exist_ok=True)
    return folder / f"{when:%Y-%m-%d}.md"


def note_failure(name, message):
    """Write a failure where an operator can find it, and never raise doing it."""
    try:
        LOG.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().isoformat(timespec="seconds")
        with (LOG / "digest.log").open("a", encoding="utf-8") as handle:
            handle.write(f"{stamp} {name}: {message}\n")
    except Exception:
        pass

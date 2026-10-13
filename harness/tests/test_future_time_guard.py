"""Future-time guard: a memory write or send stamped ahead of the real UTC clock blocks (exit 2)."""
import datetime as dt, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from hookrun import bash, check, report, tool

HOOK = "future_time_guard.py"


def stamp(minutes):
    t = dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=minutes)
    return f"{t:%H:%M}"


def main():
    ahead, past = stamp(30), stamp(-30)
    if int(ahead[:2]) < int(stamp(0)[:2]) or int(past[:2]) > int(stamp(0)[:2]):
        print("future_time_guard      skipped: run is within 30 minutes of midnight UTC")
        return True
    block = [
        ("memory append ahead", bash(f"echo 'COMPLETED {ahead} UTC: build' >> memory/today.md")),
        ("STATE.md write ahead", tool("Write", {"file_path": "/w/STATE.md", "content": f"done {ahead}Z"})),
        ("Edit memory ahead", tool("Edit", {"file_path": "/w/memory/today.md", "old_string": "x", "new_string": f"sent {ahead}Z"})),
        ("send ahead", bash(f"cortextos bus send-telegram 1 'fixed {ahead} UTC'")),
    ]
    allow = [
        ("memory append in the past", bash(f"echo 'COMPLETED {past} UTC: build' >> memory/today.md")),
        ("planned time", bash(f"echo 'review due {ahead}Z' >> memory/today.md")),
        ("scheduled time", tool("Write", {"file_path": "/w/STATE.md", "content": f"deploy scheduled for {ahead}Z"})),
        ("not a memory file", tool("Write", {"file_path": "/w/notes.md", "content": f"done {ahead}Z"})),
        ("not a memory command", bash(f"echo 'done {ahead}Z'")),
        ("range stamp", bash("echo 'done 10:3x UTC' >> memory/today.md")),
    ]
    return report("future_time_guard", check("future_time_guard", HOOK, block, allow))


if __name__ == "__main__":
    sys.exit(0 if main() else 1)

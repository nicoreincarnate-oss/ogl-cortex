"""Synthetic fixtures shared by the memory tests. No real people, clients or ids."""
import json
import os


def line(**e):
    return json.dumps(e)


def transcript(path):
    """A Claude Code session file with every line type the memory hooks must keep or drop."""
    rows = [
        line(type="user", message={"role": "user", "content": "Move the invoice run to the 1st of the month."}),
        line(type="assistant", message={"role": "assistant", "content": [
            {"type": "thinking", "thinking": "SECRET-THINKING"},
            {"type": "text", "text": "Done. The invoice run is now on the 1st."},
            {"type": "tool_use", "name": "Bash", "input": {"command": "crontab -l"}}]}),
        line(type="user", toolUseResult={"stdout": "TOOL-DUMP"},
             message={"role": "user", "content": [{"type": "tool_result", "content": "TOOL-DUMP"}]}),
        line(type="user", message={"role": "user", "content":
             "=== TELEGRAM from [USER: Operator] (chat_id:1) ===\n```\nThe ferry code is BLUE-HERON-7.\n```\n"
             "Reply using: cortextos bus send-telegram 1 '<your reply>'"}),
        line(type="attachment", attachment={"type": "queued_command",
             "prompt": "Also note the warehouse closes at 18:00.\n\nThis is how Claude Code surfaces messages the user sends mid-turn"}),
        line(type="user", message={"role": "user", "content": "[CRON FIRED 2026-01-01T08:00:00Z] heartbeat: Read HEARTBEAT.md"}),
        line(type="user", message={"role": "user", "content": "<system-reminder>REMINDER-TEXT</system-reminder>"}),
        line(type="assistant", isSidechain=True, message={"role": "assistant", "content": "SIDECHAIN-TALK"}),
        line(type="assistant", message={"role": "assistant", "content": [{"type": "text", "text": "Noted the ferry code and the closing time."}]}),
        "not json at all",
    ]
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(rows) + "\n")
    return path


DROPPED = ["SECRET-THINKING", "TOOL-DUMP", "CRON FIRED", "REMINDER-TEXT", "SIDECHAIN-TALK", "Reply using", "This is how Claude Code"]
KEPT = ["invoice run to the 1st", "BLUE-HERON-7", "warehouse closes at 18:00", "Noted the ferry code"]


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)

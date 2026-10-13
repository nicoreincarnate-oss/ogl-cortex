# <YYYY-MM-DD> (UTC)

<!-- OGL Cortex daily memory format. File: memory/<YYYY-MM-DD>.md, named by the UTC date (date -u +%Y-%m-%d).
Append only. Every entry answers one question: if my context were wiped now, what would I need to resume?
Take every clock time from `date -u` in the same command that writes the line. The future-time guard blocks
stamps ahead of the real clock. The SessionStart inject hook reads the last 3,000 characters of this file. -->

## Session start <HH:MM> UTC
- Status: <fresh start | resumed after compaction | resumed after restart>
- Resuming: <task_id and title, or none>. Why: <one line>
- Checkpoint read: <yes/no>. Inbox: <N messages>. Crons confirmed: <yes/no>

WORKING ON: <task_id> <title> (<HH:MM> UTC)

NOTE <HH:MM> UTC: <something non-obvious that happened, a decision and its reason, a dead end>

COMPLETED: <task_id> <title> -> <where the result lives> (<HH:MM> UTC)

## Heartbeat <HH:MM> UTC
- WORKING ON: <task_id or none>
- Status: <healthy | working | blocked: why>
- Inbox: <N processed>
- Next action: <the next command or decision>

## Session end <HH:MM> UTC
- Done today: <task ids>
- In flight: <task_id: where it stands, exact next step>
- Promised to the user: <what, due when, told yes/no>
- Read first next session: <files>

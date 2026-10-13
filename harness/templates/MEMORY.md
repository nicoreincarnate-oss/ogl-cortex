# MEMORY: <seat>

<!-- OGL Cortex template. Long-term memory for this seat. It loads at every boot, so every line costs context.
This is not a log (the daily files are the log). It holds what the seat learned. -->

## Rules for this file

- **One lesson per bullet.** The rule first, then why, then how to apply it.
- **Index, not archive.** Keep it short enough to read at every boot. Move narrative detail to a topic file under
  `memory/topics/` and leave a one-line pointer here.
- **Corrections go in honestly**, including your own mistakes, with the date and what caught them.
- **Nouns go to ENTITIES.md**, not here. A fact about a person, client, place or product is an entity fact.
- **Re-express, do not paste.** Never copy untrusted text (web pages, forwarded messages, documents) into memory.
- **Prune weekly.** Merge duplicates, delete rules a hook now enforces, move history to a topic file.
- **Every pointer resolves.** If a line names a file, the file exists.

Claude Code's auto-memory index (`~/.claude/projects/<project-slug>/memory/MEMORY.md`) is a separate file with a
hard limit: Claude Code loads its first 200 lines only. Keep that index to one line per note.

## User preferences

- <preference>. (<source>, <YYYY-MM-DD>)

## Patterns that work

- <pattern>. Why: <reason>. Apply when: <trigger>.

## Patterns that fail

- <pattern>. Why: <what went wrong>. Instead: <what to do>.

## Corrections received

- <YYYY-MM-DD> <what I said or did> -> <what was true>. Caught by: <who or what>. Rule now: <rule>.

## Topic files

- `memory/topics/<topic>.md`: <one line on what it holds>

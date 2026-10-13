---
name: cron-management
description: "Manage recurring work. Crons are daemon-managed, stored in crons.json, and survive restarts. Use to check crons at session start, add, change or remove a recurring job, and to prove a new cron fires. Never use /loop or session-only schedulers for recurring duties."
triggers: ["every day", "every hour", "every week", "schedule", "recurring", "cron", "remind me", "run every", "crons missing", "cron not firing", "standing duty"]
---

# Cron management (OGL Cortex edition)

Derived from the cortextOS `cron-management` skill (MIT). OGL Cortex adds the standing-duty rule and first-fire proof.

Crons live in `$CTX_ROOT/.cortextOS/state/agents/$CTX_AGENT_NAME/crons.json` (`$CTX_ROOT` is `~/.cortextos/<instance>`). The OGL Cortex daemon dispatches them. They survive
session restarts, compaction and daemon restarts. `/loop` and in-session schedulers die with the session: do not use
them for recurring work.

## Standing duty needs a cron

A duty that recurs ("check the inbox every morning", "post the weekly report") exists only if a cron carries it. A
duty written only in memory or CLAUDE.md is lost at the next handoff. When you accept a recurring duty, add the cron in
the same turn and record its name.

## Commands

```bash
cortextos bus list-crons $CTX_AGENT_NAME                 # what is registered (add --json for raw)
cortextos bus add-cron $CTX_AGENT_NAME <name> <schedule> "<prompt>"
cortextos bus update-cron $CTX_AGENT_NAME <name> --interval <schedule>
cortextos bus update-cron $CTX_AGENT_NAME <name> --prompt "<new prompt>"
cortextos bus update-cron $CTX_AGENT_NAME <name> --enabled false   # pause without removing
cortextos bus remove-cron $CTX_AGENT_NAME <name>
cortextos bus get-cron-log $CTX_AGENT_NAME [<name>]       # fired / retried / failed history
```

Schedules: an interval (`30m`, `6h`, `1d`) or a 5-field cron expression (`"0 9 * * 1-5"`). Prefer a 5-field
expression for long or wall-clock schedules (daily, weekly): it fires at a fixed time, while an interval counts from
when the scheduler last anchored it.

## Prove the first fire

A registered cron is a claim. Before you call it done:

1. Pick a schedule that fires soon, or wait for the first scheduled time.
2. Check `cortextos bus get-cron-log $CTX_AGENT_NAME <name>` for a `fired` entry.
3. Check the artifact the prompt should produce (a file, a message, an event). A fired cron with no artifact failed.

## Session start

Run `cortextos bus list-crons $CTX_AGENT_NAME`. Do not re-create crons that are listed. Add any missing one.

## Troubleshooting

| Symptom | Check |
|---------|-------|
| Cron never fires | `list-crons`: is it there and enabled? `get-cron-log`: any `failed` entries? |
| Fires but nothing happens | Read the prompt as a stranger would: does it name the file or command to run? |
| `crons.json` unreadable | The daemon falls back to `crons.json.bak`. If both are bad, re-add with `add-cron` or run `cortextos bus migrate-crons $CTX_AGENT_NAME --force` |
| Daemon logs | `$CTX_ROOT/logs/$CTX_AGENT_NAME/` |

# Heartbeat checklist

<!-- OGL Cortex template. Runs on the seat's heartbeat cron. The goal of every cycle: the seat stays visible and
current. A fresh heartbeat and cron watermark, a clean inbox, accurate memory, and real work advanced. -->

## 1. Heartbeat and cron watermark (first)

```bash
cortextos bus update-heartbeat "<one sentence on current work>"
cortextos bus update-cron-fire heartbeat --interval <same interval as the cron, e.g. 4h>
```

`update-heartbeat` feeds the dashboard. `update-cron-fire` feeds the daemon's gap detector. Skip either and the
seat looks dead or stuck.

## 2. Inbox sweep

```bash
cortextos bus check-inbox
cortextos bus ack-inbox "<message_id>"   # for each message once handled
```

## 3. Own task queue

```bash
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status in_progress
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status pending
```

An `in_progress` task older than two hours gets finished now or gets a status note.

## 4. Daily memory

Append to `memory/<UTC date>.md`, with the time read from `date -u` in the same command:

```bash
printf '\n## Heartbeat %s UTC\n- WORKING ON: %s\n- Status: %s\n- Inbox: %s\n- Next action: %s\n' \
  "$(date -u +%H:%M)" "<task_id or none>" "<healthy | working | blocked: why>" "<N processed>" "<next step>" \
  >> "memory/$(date -u +%Y-%m-%d).md"
```

## 5. Log the cycle

```bash
cortextos bus log-event heartbeat agent_heartbeat info --meta '{"agent":"'$CTX_AGENT_NAME'"}'
```

## 6. Guardrail self-check

Did this cycle hit a red-flag thought from GUARDRAILS.md? If yes, log it:

```bash
cortextos bus log-event action guardrail_triggered info --meta '{"guardrail":"<which>","context":"<what happened>"}'
```

## OGL Cortex memory steps

These steps keep the memory layers current. Run them after the steps above.

### 7. Entity upkeep (noun index)

Did a new fact about a person, place or thing arrive since the last cycle? If yes, update `ENTITIES.md` in this
cycle, through the write gate at the top of that file: rank the source, check for conflict, attach provenance.
If you run an external knowledge store, write the same fact there in the same cycle.

### 8. Knowledge base re-ingest

Keeps the seat's private collection current. Skip this step if a `kb-ingest-daily` cron already does it.

```bash
cortextos bus kb-ingest ./MEMORY.md ./ENTITIES.md "./memory/$(date -u +%Y-%m-%d).md" \
  --org "$CTX_ORG" --agent "$CTX_AGENT_NAME" --scope private --force
```

### 9. Checkpoint health

```bash
head -3 memory/checkpoints/latest.md 2>/dev/null
```

`CHECKPOINT FAILED` in that file means the PreCompact checkpoint hook captured nothing at the last compaction. Tell
the operator. Do not treat the checkpoint layer as working until a checkpoint shows a non-zero count.

### 10. Meetings and deadlines

Check the next 24 hours for meetings and due dates the seat owns. Anything due before the next heartbeat gets a
task and, if needed, a one-shot reminder cron.

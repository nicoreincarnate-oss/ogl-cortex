---
name: tasks
description: "You are about to start a piece of work with a deliverable, or hand work to another agent. Create a task first, mark it in_progress, record it in daily memory, and complete it with a result. A task for another agent is a dispatch: its description carries four lines, TASK, FILES, BAR, RETURN. When the work comes back, run the BAR yourself before you call it done."
triggers: ["create task", "start task", "new task", "track work", "dispatch", "assign task", "hand off", "delegate", "complete task", "task blocked", "list tasks", "my tasks", "task lifecycle"]
---

# Tasks (OGL Cortex edition)

Derived from the cortextOS `tasks` skill (MIT). OGL Cortex adds the four-line dispatch brief and return verification.

Every piece of work longer than a few minutes gets a task. A task that does not exist is invisible on the dashboard
and lost on restart.

> Complex directive? If the work spans three or more surfaces, runs longer than two hours, or is hard to undo, run the
> `complex-decomposition` skill first, then create tasks here.

## Lifecycle

```bash
# 1. Create, before you start
cortextos bus create-task "<title>" --desc "<what done looks like>" [--priority urgent|high|normal|low] [--project <name>]

# 2. Start
cortextos bus update-task <task_id> in_progress

# 3. Do the work. Write "WORKING ON: <title> (<task_id>)" to memory/$(date -u +%F).md

# 4. Complete with a result a stranger can check: what changed and where it lives
cortextos bus complete-task <task_id> --result "<summary + paths>"
cortextos bus log-event task task_completed info --meta '{"task_id":"<task_id>"}'
```

Statuses: `pending`, `in_progress`, `blocked`, `completed`, `cancelled`.

Blocked? `cortextos bus update-task <task_id> blocked`, then log why:

```bash
cortextos bus log-event task task_blocked info --meta '{"task_id":"<task_id>","reason":"<why>"}'
```

## Dispatch: a task for another agent

A dispatch is a task with `--assignee <agent>`. A `send-message` alone is not a dispatch: it has no owner, no status
and no record. The description holds four lines. The brief guard hook blocks a dispatch without them.

```bash
cortextos bus create-task "Fix the failing login test" --assignee <specialist> --desc "TASK: make tests/auth/login.test.ts pass without changing its assertions
FILES: src/auth/ and tests/auth/ in a branch of your own; nothing else
BAR: npm test exits 0 and the diff touches only those folders
RETURN: branch name, commit hash, last 20 lines of npm test"
```

| Line | Holds |
|------|-------|
| `TASK:` | one job, one sentence a stranger could act on |
| `FILES:` | what it may touch, including the working folder, nothing else |
| `BAR:` | what done means, checkable: a test, a screenshot, a number |
| `RETURN:` | the short shape of what comes back |

Then tell the assignee: `cortextos bus send-message <specialist> normal 'Task <task_id> is yours. Brief in the description.'`

### Four tests before you hand work out

1. The work splits into pieces that do not depend on each other.
2. Each piece fits a four-line brief.
3. You will verify every return.
4. The result is worth the extra tokens a second agent spends.

Any "no": do the work yourself in one window.

### A return is a claim

When the assignee reports done, open the files it names and run its BAR yourself before you complete the task or tell
the user. If the BAR fails, reopen the task with the evidence.

## Approval

External actions (send, deploy, publish, spend, delete) need approval. Create the task with `--needs-approval`, or use
the `approvals` skill before the action.

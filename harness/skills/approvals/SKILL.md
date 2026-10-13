---
name: approvals
description: "You are about to take an action that affects the outside world, cannot be undone, or reaches real people: sending a message or email, deploying to production, publishing, spending money, deleting data, merging to main. Stop. Create an approval, block your task, tell the user, and wait for the decision in your inbox. Deploys also need a passing ship gate report."
triggers: ["need approval", "create approval", "approval needed", "before deploying", "before sending", "before deleting", "before publishing", "deploy to production", "merge to main", "irreversible action", "financial commitment", "pending approval", "list approvals"]
---

# Approvals (OGL Cortex edition)

Derived from the cortextOS `approvals` skill (MIT). OGL Cortex adds the ship gate step and the one-artifact rule.

The user decides. You act only after an approval arrives in your inbox.

## When an approval is required

| Action | Approval |
|--------|----------|
| Message or email to a real person outside the team | yes |
| Deploy, publish, release, push to a production branch | yes, plus a passing ship gate |
| Spend money or sign up for a paid plan | yes |
| Delete data, records or files you did not create | yes |
| Change a live website, account or customer-facing setting | yes |
| Research, drafts, branches, tests, internal files | no |

## Workflow

### 1. Create the approval for one named artifact

Approve artifacts, not intentions. The context names the exact draft, file, URL or diff the user approves.

```bash
APPR_ID=$(cortextos bus create-approval "<what you will do>" "<category>" "<the draft, target and why>")
```

Categories: `external-comms`, `financial`, `deployment`, `data-deletion`, `other`.

### 2. Block the task

```bash
cortextos bus update-task "$TASK_ID" blocked
cortextos bus log-event task task_blocked info --meta "{\"task_id\":\"$TASK_ID\",\"blocked_by\":\"$APPR_ID\"}"
```

### 3. Tell the user

```bash
cortextos bus send-telegram "$CTX_TELEGRAM_CHAT_ID" 'Approval needed: <title>. Open the dashboard or reply approve or reject.'
```

### 4. Wait for the inbox message

```
approval_id: <id>
decision: approved | rejected
note: <the user's note>
```

### 5. Act on the decision

Approved: `cortextos bus update-task "$TASK_ID" in_progress`, do exactly the approved action, then
`cortextos bus complete-task "$TASK_ID" --result "<what was done, where>"`.

Rejected: `cortextos bus complete-task "$TASK_ID" --result "Cancelled: approval rejected: <note>"`.

## Deploys: the ship gate

The ship gate hook blocks push, publish and deploy commands until `security/pentest-gate-report.json` in the project
(or a parent folder) says `"status": "pass"`. Run your pentest gate, read the report, then ship. An approval does not
replace the gate, and a gate pass does not replace the approval. Re-run the gate after any change to what ships.

## Rules

1. Create the approval before the action. Never act first.
2. One approval covers the artifact it names. A changed draft needs a new approval.
3. No inbox decision means no approval. A broad "go ahead" in chat does not unlock a named, frozen artifact.
4. Re-ping once after four hours of daytime silence, then wait. Find pending items with
   `cortextos bus list-approvals --format text`.

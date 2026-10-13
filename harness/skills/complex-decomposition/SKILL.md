---
name: complex-decomposition
description: "Before you create tasks for a COMPLEX directive (three or more execution surfaces, longer than two hours, or hard to undo), run three moves: a research wave before planning, a discovery-completeness self-audit, and surface tags on every task. Then create tasks with the tasks skill. Approval gates do not move. Skip this for simple single-surface work."
triggers: ["complex task", "decompose", "break down this project", "multi-step project", "plan this build", "where do I start", "big task", "multi-surface", "end to end project"]
---

# Complex task decomposition

Adds rigor at the front of the OGL Cortex task flow. The framework stays the spine: persistent agents, tasks, events,
dashboard and approval gates.

Use it when a directive spans three or more execution surfaces, runs longer than two hours, is hard to undo, or reads
two ways with different outcomes. For simple work, go straight to the `tasks` skill.

## Move 1: research wave before planning

List the unknowns in the directive: APIs, limits, terms of service, costs, prior art, existing code. Research each one
in parallel (subagents, the knowledge base with `cortextos bus kb-query "<question>"`, web search). Write the findings
into a short brief. Plan only after the unknowns are on paper.

## Move 2: discovery-completeness self-audit

Draft the task list, then ask of each task: **could the assignee do this without guessing?** For every "no", name the
missing fact (a path, a credential location, a decision, a spec, an account, a recipient) and resolve it before
dispatch. Ask the user one consolidated question, or research it.

- [ ] Every task has a concrete, checkable done-state (its BAR line).
- [ ] Every external dependency (key, account, file, recipient, URL) is named and located.
- [ ] Every open decision is decided or queued to the user.
- [ ] No task assumes a fact that has no source.

## Move 3: surface tags

Tag each task with the surface it runs on, so the assignee knows the tools and where to verify. Put the tag in the
task description.

| Tag | Surface | Verify on |
|-----|---------|-----------|
| `web` | browser or web app | the rendered page and its console |
| `native` | desktop app | a screenshot of the app state |
| `files` | docs, configs, data | file content and sample rows |
| `comms` | email, chat, messaging | the sent record |
| `calendar` | scheduling | the event exists |
| `api` | external service or MCP server | the response and a read-back |

## Then create tasks

Use the `tasks` skill: one `create-task` per piece, the surface tag in `--desc`, the four-line brief for each
dispatch, then verify every return on its tagged surface.

## Approval gates do not move

Better decomposition does not mean more autonomy. Every task that sends, deploys, spends, changes a live site or
touches customer data is created with `--needs-approval` and waits for the user.

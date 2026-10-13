# 10. Product Requirements (PRD)

This document states why OGL Cortex exists, who it is for, what it must do, why it is built on cortextOS and Claude Code, and what it does not try to do. Architecture, the execution engine, configuration and fail-safes are in `01-core-architecture.md` to `04-failsafe-boundary-log.md`. Safety, privacy, vendors and setup are in `11-ai-safety-governance.md` to `14-readme-quickstart.md`.

## Terms

- **OGL Cortex**: the cortextOS framework plus the OGL layer on top of it: seat templates, hooks and guards, skills, crons, the memory protocol, approval gates and the ship gate.
- **Owner**: the one person who runs an install and holds every approval.
- **Seat** (or agent): one long-running Claude Code session with its own name, folder, Telegram bot, memory and role.
- **Bus**: the `cortextos bus` command family seats use to send messages, create tasks, log events and request approvals.
- **Cron**: a scheduled prompt the daemon injects into a seat.
- **Instance**: one runtime state folder, `$CORTEX_HOME/<instance>` (by default `~/.cortextos/default`).

---

## 1. Purpose

A solo operator who runs several businesses or client relationships spends most hours on operations: chasing tasks, watching services, drafting, deploying, following up. OGL Cortex takes a directive the owner sends from a phone and carries it out end to end across a fleet of Claude Code agents. The owner keeps decisions, deals and approvals. The fleet does the execution.

Two outcomes drive every requirement:
1. **Leverage**: more finished work per owner hour.
2. **Freedom**: the fleet keeps working, inside limits the owner sets, while the owner is away.

## 2. Users and channels

There is one principal user and a small set of indirect ones.

| User | Channel | What they get |
|---|---|---|
| Owner | Telegram, one bot per seat. Text, voice notes, photos, files | Replies, briefings, deliverables, approval prompts |
| Owner | cortextOS web dashboard (Next.js, `cortextos dashboard`) | Tasks, heartbeats, approvals, analytics |
| Owner (optional) | A control surface on a private network (for example over Tailscale) | Approve or reject, fleet actions, panic stop |
| A client (optional) | A client-facing seat whose Telegram chat belongs to the client | Answers inside a narrow scope the owner defines |
| Clients in general | None. They receive what the owner sends | Sites, documents, campaigns |

Access control: the daemon enables Telegram for a seat only when `ALLOWED_USER` in the seat's `.env` holds a comma-separated list of numeric Telegram user IDs. If `BOT_TOKEN` is set and `ALLOWED_USER` is missing or malformed, Telegram stays off for that seat and the daemon logs a security message (`src/daemon/agent-manager.ts`).

Working hours: the owner sets day and night windows in the seat's `USER.md` and heartbeat config. At night the orchestrator works quietly and pings only on critical events (`nighttime-mode` skill).

## 3. Roles

| Role | Template | Job |
|---|---|---|
| Orchestrator | `orchestrator` | Decomposes directives, dispatches tasks, routes approvals, sends morning and evening briefings |
| Analyst | `analyst` | Fleet health, metrics, theta-wave experiments, daily quality score |
| Specialist | `agent` | Domain work: builds, content, research, deploys |
| Auditor | `agent` with an auditor brief | Independent review of claims and artifacts before they reach the owner |
| Sentinel | `agent` with a watcher brief | Watches outside services (hosting, DNS, TLS, billing, webhooks) |
| Worker | `cortextos spawn-worker` | Short-lived session for one parallel task |

Seat names are free text. Examples in these docs use names like `boss` or `devops`.

## 4. Functional requirements

| ID | Requirement | Where it is implemented |
|---|---|---|
| R1 | Accept a directive by Telegram (text, voice, photo, file) and act on it | `src/telegram/`; seat `CLAUDE.md` Telegram section |
| R2 | Transcribe voice notes on the local machine | `src/telegram/transcribe.ts` (whisper.cpp). Default model `ggml-tiny.en.bin` is English-only; set `CTX_WHISPER_MODEL` to a multilingual model and `CTX_WHISPER_LANG` for other languages. Install with `scripts/install-whisper-model.sh` |
| R3 | Break large directives into tasks, dispatch to specialist seats, track on the dashboard | `cortextos bus create-task --assignee`, `update-task`, `complete-task` |
| R4 | No website change, client send, spend or deletion without the owner's go | `GUARDRAILS.md`; `cortextos bus create-approval` (categories `external-comms`, `financial`, `deployment`, `data-deletion`, `other`); PreToolUse hooks |
| R5 | A security gate runs before anything ships | Pentest gate and ship gate hook (documents 04 and 14) |
| R6 | Scheduled duties run without being asked | Daemon cron scheduler; `cortextos bus add-cron` |
| R7 | Context survives restarts and compaction | Memory protocol; SessionStart and PreCompact hooks |
| R8 | Seats tell the truth and correct mistakes on the record | Truth rules in `GUARDRAILS.md`; `truth_correction` events via `cortextos bus log-event` |
| R9 | Outside services the business depends on are watched | Sentinel seat and watcher crons |
| R10 | Client-ready artifacts ship as designed documents with a fixed naming scheme | Naming rule in the global `CLAUDE.md`; design skills |
| R11 | Secrets stay out of chat and out of git | Secrets rules in `GUARDRAILS.md`; `leak-guard.yml` workflow; hooks |
| R12 | Seats stay inside the model usage budget and say so before stalling | Cap rules in memory; optional OAuth account rotation (`cortextos bus list-oauth-accounts`) |

## 5. Non-functional requirements

| Area | Requirement |
|---|---|
| Platform | macOS or Linux (Windows 10/11 supported by the framework with Task Scheduler for reboot persistence). Node.js 20+, pm2, Claude Code |
| Hardware | One always-on machine. Disk headroom for caches, browser binaries, container images and the knowledge base |
| Availability | Seats restart on crash and rotate context on a timer (`max_session_seconds`, default about 71 hours). pm2 restarts the daemon |
| Supervision | pm2 runs `cortextos-daemon` and `cortextos-dashboard`; extra processes (for example an auth sentinel) can be added to `ecosystem.config.js` |
| Cost | Flat Claude subscription with a weekly cap. Other runtimes (`codex-app-server`, `opencode`, `hermes`) are optional per seat |
| Data | All state is local files under `$CORTEX_HOME/<instance>` and the org folder. Disk encryption is required |
| Scale | Bounded by one machine and one subscription. Documents 01 and 02 cover seat limits |

## 6. Non-goals

- **Multi-tenant hosting.** One owner per install.
- **Open client access.** Clients do not command seats, except a client-facing seat the owner scopes on purpose.
- **Autonomous outward actions.** No seat sends to a client, publishes, deploys or spends without approval.
- **Deception.** No undisclosed personas or astroturfing. This is a hard line in `GUARDRAILS.md`.
- **Payment data.** Card data stays with payment vendors.
- **Running untrusted code.** Seats that hold secrets do not run code from untrusted repos.

## 7. Build versus buy

OGL Cortex builds on cortextOS (MIT, `github.com/grandamenium/cortextos`) with Claude Code as the agent runtime.

| Need | cortextOS + Claude Code | Agent library (LangChain, CrewAI, AutoGen) | Hosted agent platform |
|---|---|---|---|
| Phone control | Telegram bot per seat, built in | Must be built | Usually web UI |
| Real tool use on the host (files, browser, git, deploys, local services) | Native to Claude Code | Every tool must be wired | Sandboxed in the vendor cloud |
| Persistent restarting agents | Daemon, pm2, PTY sessions | Must be built | Vendor-managed |
| Mechanical guardrails | Claude Code hooks (PreToolUse, UserPromptSubmit, SessionStart, PreCompact, Stop) | Must be built | Vendor policy only |
| Cost model | Flat subscription | Per API token | Per seat or per run |
| Data location | Local disk plus the model provider | Same | Vendor cloud |
| Dependencies | A small npm set (`package.json`) | Large dependency trees | n/a |

Trade-offs of this choice:
- **Fork drift.** The OGL layer lives mostly in seat files and hooks, not in framework source. Keep framework patches small. Check upstream on a schedule with `cortextos update --check` and cherry-pick fixes after reading the diff.
- **Pinned Claude Code.** Pin the Claude Code version and trial upgrades on one seat before the fleet.
- **Tool surface.** Each user-wide MCP server is a code path into every seat. Keep the list short (document 13).

## 8. Success measures

### 8.1 Activity and quality (mechanical)

| Metric | Source |
|---|---|
| Tasks by status and assignee | `$CORTEX_HOME/<instance>/orgs/<org>/tasks/*.json` (`status`, `assigned_to`) |
| Approvals by category and outcome | `$CORTEX_HOME/<instance>/orgs/<org>/approvals/` |
| Events (heartbeats, messages, Telegram traffic, completions) | `$CORTEX_HOME/<instance>/orgs/<org>/analytics/events/**/*.jsonl` |
| Per-seat rollup | `analytics/reports/latest.json` |
| Correction rate | Count of `truth_correction` events |
| Quality score | Daily analyst score (theta wave) |

Count finished work from task files, not `task_completed` events. Both a worker and the orchestrator's KPI step can log a completion for the same task.

### 8.2 Business outcomes (owner-configured)

Activity metrics can look healthy while income is flat. Add:
- A revenue line per client per month from the real ledger (bank, payment processor, partner payouts).
- One sensor per paid funnel, for example a booking watcher that pings only on a new booking or a dark feed.
- A billing watcher that reads vendor bills so a failed card shows up before a site goes dark.

## 9. Goals and roadmap

Each seat has a `goals.json` (`focus`, `goals`, `bottleneck`, `updated_at`, `updated_by`). The orchestrator rewrites them in the morning review. `cortextos goals generate-md --agent <seat> --org <org>` renders each to `GOALS.md`, which the seat reads at boot. Write the file for every seat; a goal sent only as a message does not reach boot context.

There is no release train. Work follows owner messages, the morning review cascade and dated commitments kept in seat memory.

## Known limitations

- Boot files that describe the business (`USER.md`, `SYSTEM.md`, review skills) are static text. Seats act on them until the owner edits them.
- The default voice model is English-only.
- Without `accounts.json`, OAuth account rotation is off and a usage cap-out looks like a hung seat.
- The system has a single host. A host failure stops every seat until restore.
- Business outcome metrics do not exist until the owner wires a source for them.

## Source files

- `README.md`
- `package.json`
- `ecosystem.config.js`
- `src/daemon/agent-manager.ts`
- `src/daemon/agent-process.ts`
- `src/telegram/transcribe.ts`
- `src/telegram/media.ts`
- `scripts/install-whisper-model.sh`
- `templates/orchestrator/`

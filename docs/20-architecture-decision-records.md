# 20. Architecture Decision Records

This document records the design decisions behind OGL Cortex. Each record states the problem, the choice, and what the choice costs. Read it to learn why the system works the way it does before you change a default.

OGL Cortex has two layers:

- **cortextOS**, the upstream MIT framework. It provides the daemon, the message bus, crons, tasks, approvals, the dashboard and the agent templates.
- **The OGL layer** on top. It adds seat roles, hooks and guards, the memory protocol, the delivery pipeline, the approval gates and the ship gate.

Each record names the layer it belongs to.

## Terms

| Term | Meaning |
|---|---|
| Seat | One long-running Claude Code agent with its own folder, bootstrap files and Telegram bot. |
| Orchestrator | The seat the owner talks to. It plans, dispatches, monitors and gates. Example name in config: `boss`. |
| Specialist | A seat that does domain work (engineering, deploys, content, research). |
| Auditor | A read-only reviewer seat. It checks claims and gates guard changes. |
| Sentinel | A maintenance seat that watches fleet health and shared infrastructure. |
| Hook | A script Claude Code runs at a fixed point (before a tool call, after it, at prompt submit, at compaction). A PreToolUse hook blocks the call by exiting with code 2. |
| Cron | A scheduled prompt that the cortextOS daemon types into a seat's terminal. |
| Owner | The one human who runs the fleet and approves external actions. |

Path conventions: `$CORTEX_HOME` is your cortextOS checkout. `$CTX_ROOT` is the runtime state root for one daemon instance (`~/.cortextos/<instance>`). `<org>` and `<seat>` are folder names under `$CORTEX_HOME/orgs/`.

Related documents: architecture in `01-core-architecture.md`, the execution engine in `02-execution-engine.md`, configuration in `03-configuration-registry.md`, the enforcement layers in `04-failsafe-boundary-log.md`, data shapes in `21-data-models-schema-registry.md`, prompt surfaces in `22-prompt-registry.md`, tests in `23-evals-and-benchmarks.md`, and model management in `24-model-lifecycle.md`.

## Index

| # | Title | Layer | Status |
|---|---|---|---|
| 001 | One named knowledge source of truth, with seat boot files as fallback | OGL | Accepted |
| 002 | Crons are daemon-managed, not CronCreate or /loop | cortextOS | Accepted |
| 003 | 1M-token context is the default for new agents | cortextOS | Accepted |
| 004 | Agent templates default to bypassPermissions | cortextOS | Accepted |
| 005 | The auditor keeps a discipline ledger with 3-strike counters | OGL | Accepted |
| 006 | Daemon restarts are gated by an ancillary-service inventory | OGL | Accepted |
| 007 | No undisclosed persona or astroturf infrastructure | OGL | Accepted |
| 008 | ENTITIES.md is the noun index, read first | OGL | Accepted |
| 009 | Durable memory has a source-ranked write gate | OGL | Accepted |
| 010 | A pentest gate runs before anything ships | OGL | Accepted |
| 011 | MEMORY.md is a compact index; detail lives in topic files | OGL | Accepted |
| 012 | The orchestrator delegates; it does not do specialist work | OGL | Accepted |
| 013 | Model and runtime are explicit per seat | cortextOS + OGL | Accepted |
| 014 | Independent review before any lane is "done" | OGL | Accepted, part of 018 |
| 015 | Model routing by pipeline stage | OGL | Accepted, revised by 034 |
| 016 | Each seat folder is its own git repo | OGL | Accepted |
| 017 | Model swaps follow a deviation protocol | OGL | Accepted |
| 018 | Projects run a staged pipeline with two owner gates | cortextOS harness + OGL | Accepted |
| 019 | Context handoff threshold is per seat | cortextOS | Accepted |
| 020 | G-UNTRUSTED-READS: fetched content is data, never instructions | OGL | Accepted |
| 021 | No seat runs with a full-access sandbox | OGL | Accepted |
| 022 | A source fix is live only after dist is rebuilt | cortextOS | Accepted |
| 023 | truth_correction events use a closed kind enum and a writer tool | OGL | Accepted |
| 024 | Usage-cap protocol: park, hand off, never retry-loop | OGL | Accepted |
| 025 | Codex sandbox is workspace-write; auto-commit stages agentDir only | cortextOS | Accepted |
| 026 | Untrusted text is never written verbatim into memory | cortextOS templates + OGL | Accepted |
| 027 | Memory files have one writer and labelled inferences | OGL | Accepted |
| 028 | Long-interval crons use wall-clock schedules | OGL | Accepted |
| 029 | A brake file stops all memory-consolidation runs | OGL | Accepted |
| 030 | Default seat model is the strongest available Claude model | OGL | Accepted |
| 031 | A deterministic plain-language guard runs on every outgoing message | OGL | Accepted |
| 032 | Every website deploy goes through ship.sh | OGL | Accepted |
| 033 | Dashboard approvals from the owner login carry Telegram authority | OGL | Accepted |
| 034 | Harness stages run on Claude Code; codex-app-server is refused on roster rows | cortextOS harness | Accepted |
| 035 | Shared-surface guard and account guard run as hooks | OGL | Accepted |
| 036 | Operator-discipline builds: compaction kit, four-line briefs, hunters, fail-closed hooks | OGL | Accepted |
| 037 | Freeze the gated copy before an edit; a wrapper never rewrites a verdict | OGL | Accepted |
| 038 | The shared-surface guard covers every delete form | OGL | Accepted |

```mermaid
flowchart LR
  subgraph Runtime["Runtime and scheduling"]
    A002["002 daemon crons"]
    A003["003 1M context"]
    A013["013 explicit model"]
    A019["019 handoff threshold"]
    A028["028 wall-clock crons"]
  end
  subgraph Memory["Memory"]
    A001["001 source of truth"]
    A008["008 ENTITIES"]
    A009["009 write gate"]
    A011["011 index memory"]
    A027["027 one writer"]
    A029["029 dream brake"]
  end
  subgraph Safety["Safety boundary"]
    A004["004 bypassPermissions"]
    A020["020 untrusted reads"]
    A026["026 injection guard"]
    A031["031 send guard"]
    A035["035 surface guards"]
    A038["038 delete forms"]
  end
  subgraph Delivery["Delivery and review"]
    A010["010 pentest gate"]
    A014["014 review"]
    A018["018 pipeline"]
    A032["032 ship.sh"]
    A037["037 gated freeze"]
  end
  A004 --> A020
  A004 --> A031
  A031 --> A035
  A035 --> A038
  A010 --> A032
  A032 --> A037
  A014 --> A018
  A011 --> A027
  A027 --> A029
```

---

## ADR-001: one named knowledge source of truth, with seat boot files as fallback

- **Context.** Knowledge can live in many places: a vault of markdown notes, a graph export, a database, and each seat's own files. Agents need to know which one wins when they disagree.
- **Decision.** The owner names one knowledge store as the source of truth in the user-level `~/.claude/CLAUDE.md` (the reference install uses GBrain, a local PGLite store with a CLI and an MCP server). A human-readable vault mirrors it. Seats query the store first. Each seat's `MEMORY.md` and `ENTITIES.md` are the fallback because the seat reads them at every boot.
- **Consequences.** If the store's MCP server fails to connect, seats fall back to their boot files without saying so. Add a boot health check for the store and state the fallback order in the seat CLAUDE.md, or the boot files become the real source of truth by default.

## ADR-002: crons are daemon-managed, not CronCreate or /loop

- **Context.** Claude Code's in-session `CronCreate` and `/loop` die when the session restarts. Concurrent updates to one cron file can lose writes, and a daemon crash mid-fire can fire a job twice.
- **Decision.** Each seat's crons live in a daemon-owned file, `$CTX_ROOT/.cortextOS/state/agents/<seat>/crons.json`. The daemon scheduler fires them. Agents manage them only through `cortextos bus add-cron`, `update-cron`, `remove-cron` and `list-crons`. The scheduler stamps `last_fire_attempted_at` before dispatch so a crash cannot double-fire. Templates do not teach CronCreate.
- **Consequences.** Crons survive restarts. Interval crons interact with other fires on the same seat (see ADR-028). Seat prose that names a cron file path can drift from the code; tell agents to use `list-crons`, not the file.

## ADR-003: 1M-token context is the default for new agents

- **Context.** A 200K window forces frequent compaction on long-running seats.
- **Decision.** New agents get the 1M-context model id (the `[1m]` suffix). 200K is opt-in.
- **Consequences.** Seats can run for many hours between compactions. That makes compaction and handoff design (ADR-019, ADR-036) more important, and it raises per-turn cost on long sessions.

## ADR-004: agent templates default to bypassPermissions

- **Context.** Unattended agents stall on permission prompts that nobody is there to answer.
- **Decision.** All agent templates set `permissions.defaultMode` to `bypassPermissions`. `AgentConfig.dangerously_skip_permissions` defaults to true when absent.
- **Consequences.** Seats run unattended. The permission prompt stops being a boundary, so the boundary moves to two places: what a seat reads (ADR-020) and PreToolUse hooks that block on exit code 2 (ADR-031, ADR-035, ADR-038). With permissions skipped, PermissionRequest hooks rarely fire.

## ADR-005: the auditor keeps a discipline ledger with 3-strike counters

- **Context.** Agents repeat the same classes of error: claiming done before verifying, stating names without a source, asking for credentials over chat.
- **Decision.** The auditor keeps per-seat counters per failure class, for example `completion-claim-before-owned-verification 2/3`. At 3/3 the class moves to a stricter path with a mechanical self-check and an expiry date. The counters appear as a header in the seat's `MEMORY.md`.
- **Consequences.** Repeated failures become visible and get a rising response. The ledger is the precursor of the truth_correction event (ADR-023) and of rules enforced by hooks instead of memory.

## ADR-006: daemon restarts are gated by an ancillary-service inventory

- **Context.** A daemon restart can stop side services (LaunchAgents) that lack `RunAtLoad` and `KeepAlive`, and nothing reports it.
- **Decision.** Before any daemon restart, list every LaunchAgent the fleet depends on, check its persistence flags, and send the owner a checklist for an explicit go. Restart commands always pass `--instance <instance>`. The CLI defaults to an instance named `default`, and against the wrong instance it reports "Daemon is not running" while the real daemon is up.
- **Consequences.** Restarts are slower and gated. Side services stop vanishing on restart. Guardrail code: `G-PRE-RESTART-ANCILLARY-INVENTORY`.

## ADR-007: no undisclosed persona or astroturf infrastructure

- **Context.** A fleet of agents can be asked to run many fake accounts.
- **Decision.** Seats do not build spawned-agent personas, fingerprint or IP rotation, fake post histories, or coordinated multi-account posting. They can help with disclosed playbooks on the owner's own accounts. The rule sits in `GUARDRAILS.md` and holds on the first ask.
- **Consequences.** An ethics boundary, not a technical one. It decides which tools the fleet builds.

## ADR-008: ENTITIES.md is the noun index, read first

- **Context.** Agents quote stale facts about people, prices and products when those facts are spread across long memory files.
- **Decision.** Each seat keeps `ENTITIES.md`: one entry per person, place or thing, with a source rank and an as-of date. The seat reads it right after `MEMORY.md` at boot and answers noun questions from it first. A write gate at the top of the file states who may change entries.
- **Consequences.** One small boot surface answers most noun questions. An optional entity graph (ADR-036) lets a hook inject one entity instead of the whole file.

## ADR-009: durable memory has a source-ranked write gate

- **Context.** Without ranking, a fact from a scraped web page lands in memory at the same weight as a fact from the owner.
- **Decision.** Every fact written to durable memory carries a source and an as-of date. Sources rank: the system's own operational data, then the owner, then client documents, then transcripts, then the web. A conflict is re-checked against the highest-ranked source. Unverified facts are marked.
- **Consequences.** Memory stays traceable. Agent habit enforces this rule; no hook checks memory writes for provenance.

## ADR-010: a pentest gate runs before anything ships

- **Context.** Agents can deploy sites and send deliverables with no security check.
- **Decision.** Nothing ships, deploys, publishes or goes to a client until `cortex_pentest_gate.py` writes `security/pentest-gate-report.json` with `"status": "pass"`, or the owner accepts the risk in `security/pentest-risk-acceptance.md`. Web surfaces need `--url <url>`. Apps with accounts, roles or user data need `--requires-authz`.
- **Consequences.** Every ship has a security record. A gate run without `--url` skips the web scan, so ADR-032 wraps the gate in a script that requires the URL and checks the report's own scan return codes.

## ADR-011: MEMORY.md is a compact index; detail lives in topic files

- **Context.** Boot memory grows into long narratives that crowd the context window. Claude Code truncates its auto-memory index past 200 lines.
- **Decision.** `MEMORY.md` is an index of at most 200 lines. Narratives move to `memory/topics/*.md` and dated archives, with one-line pointers left in the index.
- **Consequences.** Boot cost stays bounded only if something enforces the cap. Add a hook or a nightly job that counts lines and flags the file.

## ADR-012: the orchestrator delegates; it does not do specialist work

- **Context.** An orchestrator that does the work itself leaves the fleet idle and loses the review step.
- **Decision.** Every project goes to its owning specialist. The orchestrator dispatches, monitors heartbeats, routes approvals and keeps the quality gate. Small live fixes done with the owner watching are the exception. A dispatch is a task assigned to the specialist with a four-line brief (ADR-036).
- **Consequences.** Work is visible on the dashboard and reviewable. Before handing work out, the orchestrator applies four tests: the work splits into independent pieces, each piece fits a four-line brief, the orchestrator will verify every return, and the split is worth the extra tokens. Any "no" means do it in one window.

## ADR-013: model and runtime are explicit per seat

- **Context.** Implicit or inherited models make it unclear which model a seat runs.
- **Decision.** Every seat `config.json` sets `runtime` (for example `claude-code`) and `model` (for example `claude-opus-5-5[1m]`). The daemon reads them at start. A change needs a seat restart.
- **Consequences.** Model identity is auditable from one file per seat. A config edit without a restart changes nothing, so the restart is part of every swap (ADR-017).

## ADR-014: independent review before any lane is "done"

- **Context.** A worker that reviews its own output tends to pass it.
- **Decision.** No lane reaches the owner as done until an independent pass checks originality, function, security, the absence of real external actions, and spec adherence. The OGL layer ships a read-only `auditor` subagent (`.claude/agents/auditor.md`) for this. Seat rule: "A return is a claim. Open the files it names and run its BAR."
- **Consequences.** More tokens per lane, fewer false "done" reports. Folded into the pipeline in ADR-018.

## ADR-015: model routing by pipeline stage

- **Context.** One model for every stage overspends on simple stages and underpowers hard ones.
- **Decision.** The pipeline routes by stage: the strongest reasoning model for planning and final review, a fast model for research fan-out and bulk build work.
- **Consequences.** Stage cost tracks stage difficulty. ADR-034 sets the harness pool to Claude Sonnet 5.5.

## ADR-016: each seat folder is its own git repo

- **Context.** The framework repo ignores `orgs/`, so a framework-level auto-commit records nothing for seat files.
- **Decision.** Each seat folder is a nested git repo. The daily auto-commit cron commits it.
- **Consequences.** Seat history is real. Git is a periodic snapshot, not a record of every edit. Track hook scripts in git too, so a reviewer can diff them (ADR-037). Check that a backup or commit job produced an artifact before you trust its "success".

## ADR-017: model swaps follow a deviation protocol

- **Context.** A new model can fail at boot, hang, or behave differently, and a seat that will not boot is dark until someone notices.
- **Decision.** Every model swap: back up `config.json`, log the change as a deviation with a named revert trigger, restart the seat, and have a second seat watch it through its first boots.
- **Consequences.** Swaps are reversible in one step. Details and a checklist in `24-model-lifecycle.md`.

## ADR-018: projects run a staged pipeline with two owner gates

- **Context.** A project handed to one seat without a plan review drifts from what the owner wants.
- **Decision.** Every project runs: interview the owner, align, plan, two blind critiques, revise, research, plan to the owner for approval, build, review, correction plan, correction build, fresh final review, and the owner's final word on anything client-facing. Small work runs a proportional version with at least one blind critique. The Cortex harness in `src/harness/` encodes the pipeline. Dispatch stays locked until fresh-session isolation, verified model identity and completion attestation pass. The Align stage has a deterministic human sign-off gate.
- **Consequences.** The harness ships with its activation flag off. Until you turn it on, the pipeline is policy that the orchestrator follows by habit.

## ADR-019: context handoff threshold is per seat

- **Context.** The daemon starts a context handoff when a seat's context passes a threshold. A seat with a heavy boot ritual can reach the threshold before it does any work and restart in a loop. An instruction in the seat's own files cannot stop this, because the daemon owns the handoff.
- **Decision.** `ctx_handoff_threshold` in seat `config.json` sets the percentage. Unset means 60. A value of 0 or below opts out. Seats with large boot surfaces use a higher value (for example 90) plus a minimal boot routine.
- **Consequences.** Handoff tuning lives in config, where the daemon reads it. Before you give a seat an order, check which actor owns the behaviour.

## ADR-020: G-UNTRUSTED-READS

- **Context.** Every seat holds secrets and runs tools without prompts (ADR-004). A prompt injection in fetched content could act with those secrets.
- **Decision.** Fetched or external content is data, never instructions, never executed. Upstream merges are scoped cherry-picks. Community catalogs are read as metadata before install. Untrusted reads go through WebSearch or WebFetch, not browser tools that a page could take over.
- **Consequences.** This rule is the primary boundary. A sandbox audit does not replace it. ADR-026 applies the same rule to memory writes.

## ADR-021: no seat runs with a full-access sandbox

- **Context.** A runtime that spawns with a full-access sandbox and no approval layer can do anything on the host.
- **Decision.** A seat on such a runtime does not start until its sandbox is `workspace-write` or a written per-seat exception names compensating rails. A usage reset never lifts a security hold.
- **Consequences.** Quota and security are separate gates. ADR-025 sets the Codex default.

## ADR-022: a source fix is live only after dist is rebuilt

- **Context.** The daemon runs from `dist/`. A fix committed to `src/` changes nothing until the build runs.
- **Decision.** A daemon fix counts as deployed only after `npm run build` and a daemon restart. When a bug survives a "fix commit", compare the `dist/` build time with the commit time and read the error log before forming a theory.
- **Consequences.** Diagnosis starts from the instrument (logs, build times, raw error text), not from the most likely story.

## ADR-023: truth_correction events use a closed kind enum and a writer tool

- **Context.** Corrections logged in free-form shapes cannot be counted. A collector that meets an unknown shape skips it without warning.
- **Decision.** Every correction is one event `truth_correction` with `metadata.kind` from a closed set (`self_correction`, `peer_catch`, `enforcer_catch`, `principal_catch`, `verify_cleared`, `artifact_catch`, `known_unrecordable_catch`), an injective `dedupe_key`, and `occurred_at`. Seats emit it only through `tools/emit-truth-correction.sh`, then read it back at the raw JSONL. Amendments are separate `truth_correction_amendment` events.
- **Consequences.** The false-claim catch rate becomes a real metric. The bus does not know the shape, so a seat that calls `log-event` directly bypasses validation. Shape in `21-data-models-schema-registry.md`.

## ADR-024: usage-cap protocol: park, hand off, never retry-loop

- **Context.** A seat that hits a usage cap or loses subscription access can loop on retries, burn the next window, or go silent.
- **Decision.** On a cap-out: park state in `STATE.md`, write a handoff, tell the owner when the window resets, and stop. Read the raw error text first: a usage limit and an organization-level access block look alike from outside but need different remedies (wait versus an admin re-enable).
- **Consequences.** Outages stay short and diagnosed. Watch the 7-day usage figure before large overnight runs.

## ADR-025: Codex sandbox is workspace-write; auto-commit stages agentDir only

- **Context.** ADR-021 requires a safe sandbox. Separately, an auto-commit that stages the project root can sweep in files from outside the seat.
- **Decision.** The Codex PTY spawns with `workspace-write`. Auto-commit stages `agentDir` only and runs a credential scan before commit.
- **Consequences.** Codex seats pass ADR-021. Make sure the credential scan covers new untracked directories as well as tracked files.

## ADR-026: untrusted text is never written verbatim into memory

- **Context.** Memory files load into every future session. Verbatim external text written into memory becomes an injection that runs at every boot.
- **Decision.** The agent templates carry a guardrail row: never write untrusted content verbatim into memory; re-express it in the seat's own words at the write boundary.
- **Consequences.** Agent habit enforces it. No hook checks memory writes for verbatim external text. See `11-ai-safety-governance.md`.

## ADR-027: memory files have one writer and labelled inferences

- **Context.** A memory-consolidation ("dream") run and the live session can both read a file, edit it and write it back, and the second write erases the first. An inference drawn from a degraded page can be stored as fact and later repeated.
- **Decision.** Each memory file has one writer or a lock. A consolidation run backs up first, re-reads the live file right before each edit, edits in place, then grep-verifies. Anything concluded by observation is written as `INFERRED (condition, date)` and corrected in place when confirmed or killed. Keep one copy of each boot file.
- **Consequences.** Lost-update races disappear when the rule holds. ADR-029 adds a global brake.

## ADR-028: long-interval crons use wall-clock schedules

- **Context.** On the cortextOS scheduler, other fires for the same seat push an interval cron's next fire back. An interval at least as long as the seat's heartbeat interval can starve and never fire.
- **Decision.** If a cron's interval is at least the seat's heartbeat interval, use a 5-field cron expression (for example `0 8 * * *`). Confirm the first fire by an artifact, not by the absence of an error. A recurring duty with no cron entry does not count as covered. One-shot jobs use `fire_at`, never a dated 5-field expression, which repeats yearly.
- **Consequences.** Crons are checked by receipt. Prompt text for crons is catalogued in `22-prompt-registry.md`.

## ADR-029: a brake file stops all memory-consolidation runs

- **Context.** Several consolidation processes running at once race on memory files.
- **Decision.** The dream hook script checks for a brake file on its first line and exits if the file exists. The brake comes off only after a per-seat fix is verified.
- **Consequences.** One cheap global off switch. Keep the brake file out of temp folders the OS clears on reboot, or a reboot silently releases it.

## ADR-030: default seat model is the strongest available Claude model

- **Context.** Seats make long chains of judgment calls. Weaker models cost less per token but more in review and rework.
- **Decision.** Seats default to `claude-opus-5-5[1m]` on the `claude-code` runtime. Cheaper models are an explicit per-seat choice (ADR-013) or a harness pool choice (ADR-034).
- **Consequences.** Higher per-seat cost and faster use of weekly limits. Every move off the default follows ADR-017.

## ADR-031: a deterministic plain-language guard runs on every outgoing message

- **Context.** A writing rule held only in context is not reliably followed, and every message to the owner or a client carries it.
- **Decision.** `~/.claude/hooks/orwell-lint.py` runs as a PreToolUse hook on `cortextos bus send-telegram` calls and on email or post MCP tools. It applies Orwell's six rules with word lists and regex, no model. Exit 2 blocks the send and prints reasons. A per-seat, 10-minute, one-shot pass file (`~/.claude/hooks/.orwell-pass-once-<seat>`) covers genuine exceptions. It fails closed when it crashes on input in its scope.
- **Consequences.** Message style is enforced, not requested. This hook is the template for the other deterministic guards.

## ADR-032: every website deploy goes through ship.sh

- **Context.** Deploying first and gating later leaves ungated builds live. Previews and shared archives on public URLs need the same gate as production.
- **Decision.** All deploys run `ship.sh`: deploy a candidate, gate it with `--url`, and promote the same build only on pass. A raw `vercel --prod` is a red flag. Exit codes: 0 shipped, 5 live and wrong, 6 rejected, 7 promote not taken. The script rejects stale scan reports. Its final line is the verdict.
- **Consequences.** One path to production, with a record for each ship. Re-run the gate after any later change; a pass does not cover the next deploy.

## ADR-033: dashboard approvals from the owner login carry Telegram authority

- **Context.** Asking the owner to re-confirm on Telegram an approval already given in the dashboard wastes the owner's time.
- **Decision.** Approvals and chat from the owner's own dashboard login count the same as Telegram. Other dashboard accounts do not. Approvals that touch hooks or guardrails still go through plan, review, go. Seats cite approvals from the source: the inbound message id or the approval file and its timestamp.
- **Consequences.** Two authority channels, both tied to the owner identity. Protect the dashboard login like a Telegram account.

## ADR-034: harness stages run on Claude Code; codex-app-server is refused on roster rows

- **Context.** A mixed-vendor pool needs two logins, two billing paths and two sandbox models.
- **Decision.** The harness roster (`src/harness/roster.ts`) assigns its research-build-test pool to `claude-code` with Sonnet 5.5. The roster schema refuses `codex-app-server` on roster rows. Adversarial hunter passes also run on Claude.
- **Consequences.** One vendor to log in, bill and monitor. Seat `config.json` files outside the roster can still name other models; keep them consistent with the roster when you enable the harness.

## ADR-035: shared-surface guard and account guard run as hooks

- **Context.** Some commands change surfaces every seat depends on: `~/.claude*`, package caches, the CLI install. A cache prune can delete files running MCP servers need. An MCP server bound to one Google account can overwrite another account's credential file.
- **Decision.** Two PreToolUse hooks. `shared-surface-guard.py`, with its rules module `surface.py`, blocks changes to shared surfaces and releases one command per pass token (`~/.claude/hooks/.surface-pass-once-<seat>`, valid 600 seconds). `gws-account-guard.py` refuses Google Workspace MCP calls whose `user_google_email` is not the expected account. New guard rules ship to one seat first, then the fleet, after an auditor PASS. Code-pattern checks start in WARN mode (`SURFACE_CODE_MODE=warn`) and flip to BLOCK after a quiet window.
- **Consequences.** Shared infrastructure survives agent cleanups. Each new rule needs a false-positive replay before it blocks (ADR-038).

## ADR-036: operator-discipline builds

- **Context.** Long sessions lose state at compaction, dispatches go out vague, fixes go unreviewed, and a crashing guard can wave a command through.
- **Decision.** The OGL layer ships these builds on the orchestrator seat:
  1. **Compaction kit** (`.claude/hooks/kem-compaction/`). The seat keeps `STATE.md` current. A PostToolUse meter nudges as context grows and warns near the limit. After compaction, a SessionStart hook (matcher `compact`) hands `STATE.md` back. A PostCompact hook saves the summary.
  2. **Four-line brief.** `brief_guard.py` blocks `cortextos bus create-task ... --assignee <other seat>` unless `--desc` has lines starting `TASK:`, `FILES:`, `BAR:`, `RETURN:`.
  3. **Hunter passes.** One claim, a fresh read-only session, evidence as file and line plus a reproduction, one round, a budget. Run on every guard, hook, fix and plan.
  4. **Session digest.** A hook writes a digest at session end and before compaction and indexes it into a local search index.
  5. **Prompt router.** A UserPromptSubmit hook names a reply style.
  6. **Auditor subagent.** Read-only, returns PASS or FAIL with evidence.
  7. **Align stage** in the harness (ADR-018).
  8. **Fail closed.** Guards fail closed when they crash on input in their scope. Risky skills cannot auto-invoke.
  9. **Fix-commit trigger.** A hook starts a hunter pass when a fix commit lands.
  10. **Brief audit.** `tools/brief-audit/audit.py <task_id>` flags edits outside a brief's FILES line.
  11. **Future-time guard.** Blocks writes that carry clock stamps ahead of the real time.
- **Consequences.** About 25 hook commands on the orchestrator seat, most of them custom scripts. Each adds latency to tool calls and needs its own tests (`23-evals-and-benchmarks.md`). Large build runs consume weekly usage quickly.

## ADR-037: freeze the gated copy before an edit; a wrapper never rewrites a verdict

- **Context.** A guard edited after its gate passed cannot be diffed against what was approved. A wrapper that rewrites a fail into a pass makes the record lie, even when the underlying change is safe.
- **Decision.** Before any post-gate edit, copy the live file to `<name>.gated-<sha>` with mode 400. A wrapper never changes a gate's report. Accepted risk goes in a separate `security/pentest-risk-acceptance.md` with the owner's verbatim words.
- **Consequences.** Each guard has a frozen approved copy beside it. This is a lightweight stand-in for signed versions; `22-prompt-registry.md` compares the two.

## ADR-038: the shared-surface guard covers every delete form

- **Context.** A delete can take many shapes: `rm`, brace expansion, `find -delete`, `find -exec rm`, a move to the Trash through `osascript`, or a package-manager prune. A guard that matches only `rm` misses the rest.
- **Decision.** The guard covers:
  - U1: `uv` cache prune and brace-expansion deletes.
  - U2: Trash and Finder deletes through `osascript`.
  - U3: `find -delete` and `find -exec rm`.
  - U4: deletes under `~/.claude/projects/<project>` (project folder, memory folder, `MEMORY.md`, transcripts), with one named topic file allowed.
  Each extension ships one at a time with a rollback file, after tests, mutants (deliberately broken copies the tests must catch) and a replay over past commands to count false positives.
- **Consequences.** The guard also blocks legitimate owner cleanups run from an agent session until a pass token is set. Decide whether the guard applies to interactive owner sessions.

---

## Patterns across the records

1. **Rules move from memory to code.** Counters and memory rules (ADR-005, 009, 011) give way to deterministic hooks (ADR-031, 035, 036, 038). Prefer guards that still work when the agent is wrong about itself.
2. **Models change; the policy stays.** Explicit per seat, restart to apply, back up and log every swap with a revert trigger (ADR-013, 017).
3. **Diagnose from the instrument.** Read logs, build times and raw error text before you write the story (ADR-022, 024).
4. **The auditor is load-bearing.** Guard changes, ledger rules and ship verdicts depend on it. Plan a fallback reviewer for when the auditor seat is down.
5. **Some decisions are policy without enforcement.** The memory line cap (011), one writer per memory file (027), the pipeline while the harness is off (018), and the memory-injection rule (026). Each is a candidate for a hook.

## Known limitations

- No ADR file per decision and no review board. Decisions live in `MEMORY.md`, `GUARDRAILS.md` G-codes and this document. Append to this file when you change a default.
- Hook scripts outside a seat's git repo have no history beyond `.bak-` and `.gated-` copies. Put them under version control.
- Several rules (009, 011, 026, 027) depend on agent habit. They fail silently when a seat forgets them.
- The harness pipeline (018) is off by default.

## Source files

- `src/daemon/fast-checker.ts`
- `src/daemon/index.ts`
- `src/daemon/agent-manager.ts`
- `src/bus/crons.ts`
- `src/types/index.ts`
- `src/harness/roster.ts`
- `src/harness/schema.ts`
- `src/pty/codex-app-server-pty.ts`
- `templates/agent/.claude/settings.json`
- `templates/orchestrator/CLAUDE.md`
- OGL layer: `.claude/hooks/brief_guard.py`, `.claude/hooks/future_time_guard.py`, `.claude/hooks/kem-compaction/`, `.claude/agents/auditor.md`, `tools/emit-truth-correction.sh`, `tools/brief-audit/audit.py`
- User-level hooks: `~/.claude/hooks/orwell-lint.py`, `shared-surface-guard.py`, `surface.py`, `gws-account-guard.py`

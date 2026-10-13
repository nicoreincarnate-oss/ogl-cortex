# OGL Cortex harness

The command-line tool is named `cortextos`.

The harness is the layer OGL Cortex adds on top of the framework install (daemon, bus and `cortextos` CLI). It holds guard hooks, memory hooks,
memory components, operating skills and seat templates. You install it into one seat (one agent directory) at a time.

| Piece | Path | What it does |
|-------|------|--------------|
| Guard hooks | `hooks/` | Claude Code hooks that block unsafe or sloppy tool calls before they run |
| Memory hooks | `hooks/memory/` | PreCompact checkpoint, SessionStart re-inject, PostCompact session facts |
| Memory components | `memory/` | Session digests with a local search index, the client memory graph, the vault graph and its MCP server |
| Hook tests | `tests/` | Feed sample hook JSON to each hook and check the exit code |
| Settings block | `settings.example.json` | The `hooks` block that wires the guards into a seat |
| Skills | `skills/` | Four operating skills: tasks, approvals, cron-management, complex-decomposition |
| Templates | `templates/` | Seat `CLAUDE.md`, `STATE.md`, `ENTITIES.md`, `MEMORY.md`, `GUARDRAILS.md`, `HEARTBEAT.md`, the daily memory format, org `GUARDRAILS.md` and `knowledge.md`, and a user-level `CLAUDE.md` memory block |
| Tools | `tools/` | Command-line tools the operating rules call: ship.sh, adversarial-pass.sh, brief_audit.py, emit-truth-correction.sh |
| Installer | `install.sh` | Copies all of the above into a seat. Dry run by default |
| Licences | `third_party/` | Licence texts for code derived from other projects |

Requirements: the OGL Cortex framework installed, with its CLI on `PATH` as `cortextos`, Claude Code, Python 3.9 or later, bash. The hooks
and memory components use the Python standard library only. Two parts take optional extras: the digest index adds a
meaning leg when `fastembed` is installed, and `memory/vault-graph/neo4j_load.py` needs the `neo4j` driver and Docker.

## How a hook blocks

Claude Code runs each `PreToolUse` hook with the tool call as JSON on stdin:

```json
{
  "session_id": "…",
  "cwd": "/path/to/seat",
  "hook_event_name": "PreToolUse",
  "tool_name": "Bash",
  "tool_input": { "command": "vercel --prod" }
}
```

The exit code decides what happens:

| Exit code | Effect |
|-----------|--------|
| `0` | the tool call runs |
| `2` | the tool call is blocked; stderr goes back to the agent as the reason |
| any other | a non-blocking error; the tool call still runs |

Every blocking path in these hooks exits `2`. A guard that exits `1` on a block does nothing, so the tests check for
`2` and nothing else.

## The hooks

All hooks live in `<seat>/.claude/hooks/ogl/` after install.

### Ship gate: `ship_gate.py`

`PreToolUse` on `Bash`. Blocks commands that push, publish or deploy unless a passing pentest report exists.

- Ship commands: `git push`, `gh pr merge`, `gh release create`, `npm publish`, `pnpm publish`, `yarn publish`, any
  `vercel` call with `--prod` (including `npx vercel --prod` and `vercel --prod --yes`), `vercel deploy`,
  `vercel promote`, `netlify deploy`, `firebase deploy`, `wrangler deploy`, `wrangler pages deploy`, `fly deploy`,
  `flyctl deploy`, `railway up`, `render deploy`, `rsync` to a remote host, `scp`, `sftp`.
- Pass condition: `security/pentest-gate-report.json` in the working directory or a parent (up to `$HOME`) contains
  `"status": "pass"`. The working directory comes from the hook input `cwd`.
- Risk acceptance: a human writes `security/pentest-risk-acceptance.md` and starts the session with
  `OGL_PENTEST_OVERRIDE=accepted-risk` in its environment. The agent cannot set the hook's environment from a
  command, so this stays a human decision.
- Fails closed: if the hook crashes or cannot parse its input, a command that looks like a ship command is blocked.

| Variable | Default | Meaning |
|----------|---------|---------|
| `OGL_PENTEST_GATE_CMD` | placeholder text | the command printed in the block message to produce the report. Set it to `python3 <repo>/harness/security/cortex_pentest_gate.py . --output security` |
| `OGL_PENTEST_OVERRIDE` | unset | `accepted-risk` plus a risk-acceptance file lets ship commands through |
| `OGL_SHIP_EXTRA_PATTERNS` | unset | extra regexes, one per line, that also count as ship commands (for example `\bdeploy\.sh\b`) |

The report format is the only contract. `harness/security/cortex_pentest_gate.py` writes it; any other tool works if it writes the same JSON file with a top-level `"status"` of `"pass"` or `"fail"`.

### Shared-surface guard: `shared_surface_guard.py` (+ `surface.py`, `codewrites.py`)

`PreToolUse` on `Bash`. Several seats on one machine share some files and tools. This guard blocks, once, a command
that changes them:

| Rule | Matches |
|------|---------|
| `claude_config` | writes or deletes under `~/.claude` or `~/.claude.json`. `~/.claude/projects` is exempt for writes; deleting a session transcript or a seat's memory there is blocked |
| `uv_cache` | `uv cache prune` or `uv cache clean` on the shared uv cache, and deletes that reach it. A cache dir under a temp root is allowed |
| `npm_global` | `npm` or `pnpm` global install, update, link or removal |
| `brew_upgrade` | `brew upgrade` |
| your rules | anything under a root listed in `OGL_SURFACE_EXTRA_ROOTS` |

The parser reads each simple command. It follows `cd`, variables set in the same command, prefixes such as `sudo`,
`env`, `timeout` and `xargs`, brace expansion, `find -delete` and `find -exec rm`, `bash -c` code, heredocs fed to a
shell, and Python or Node code that calls a write function on a resolvable path. Quoted text and heredoc bodies fed
to `cat` are data. Read-only commands never match.

When it blocks, the message names the processes to check, asks for a backup and a post-check, and tells the agent how
to release it:

```bash
mkdir -p ~/.ogl-cortex/state && touch ~/.ogl-cortex/state/.surface-pass-once-$CTX_AGENT_NAME
```

The token works once, for this seat only, within 10 minutes. Every block, pass and warning goes to
`$OGL_STATE_DIR/surface-guard.log` and, when `cortextos` is on `PATH`, to a bus event (`surface_guard_block`,
`surface_guard_pass`, `surface_guard_warn`, `surface_guard_failclosed`, `surface_guard_failopen`).

| Variable | Default | Meaning |
|----------|---------|---------|
| `CTX_AGENT_NAME` | `shared` | seat name for the pass token (the daemon sets it) |
| `OGL_STATE_DIR` | `~/.ogl-cortex/state` | where tokens and logs live |
| `OGL_SURFACE_EXTRA_ROOTS` | unset | extra guarded roots: `~/.config/mytool=mytool_config:~/.some_mcp=mcp_creds` |
| `SURFACE_CODE_MODE` | unset | `warn`: Python and Node code analysis only warns, except writes to a guarded root, which still block |
| `OGL_NO_BUS` | unset | `1`: do not log bus events |

Fails closed when the guard crashes on input that names a guarded surface, open otherwise.
Self-test: `python3 shared_surface_guard.py --selftest`.

### Orwell send-lint: `orwell_lint.py`

`PreToolUse` on `Bash` and on MCP send tools. Lints outgoing human-facing text against George Orwell's six rules of
writing, plus a no-em-dash rule. No model is involved, so the same text always gets the same verdict.

| Rule | Flags |
|------|-------|
| 1 | stock phrases ("at the end of the day", "move the needle", "deep dive") |
| 2 | a long word where a short one works ("utilize", "in order to", "leverage") |
| 3 | words you can cut ("very", "basically", "in terms of") |
| 4 | passive voice with "by", or two or more passives |
| 5 | jargon and foreign phrases ("stakeholders", "actionable", "per se") |
| dash | em dashes and en dashes |

Sends it reads: `cortextos bus send-telegram <chat-id> "<text>"` (the whole quoted message, multi-line included),
and MCP tools whose name contains `send_gmail_message`, `send-a-new-message`, `create-post`, `reply`, `forward` or
`create_draft`. Heredoc bodies and shell comments are not sends.

Rule 6 says to break the rules sooner than say anything barbarous. The release for that is a pass token, once per
seat, within 10 minutes, logged:

```bash
mkdir -p ~/.ogl-cortex/state && touch ~/.ogl-cortex/state/.orwell-pass-once-$CTX_AGENT_NAME
```

Scripts that send on their own can gate text first: `echo "$MSG" | python3 orwell_lint.py --text` (exit 2 on issues).

| Variable | Default | Meaning |
|----------|---------|---------|
| `OGL_ORWELL_SEND_VERBS` | `send-telegram` | `cortextos bus` verbs to lint, comma-separated |
| `OGL_ORWELL_MCP_TOOLS` | the six names above | MCP tool-name fragments that count as sends |
| `OGL_STATE_DIR` | `~/.ogl-cortex/state` | token and log location |

If you change `OGL_ORWELL_MCP_TOOLS`, change the matcher in `settings.json` to match.
Self-test: `python3 orwell_lint.py --selftest`.

### Brief guard: `brief_guard.py`

`PreToolUse` on `Bash`. A task assigned to another seat must carry a four-line brief:

```
TASK: one job, one sentence a stranger could act on
FILES: what it may touch, including the working folder, nothing else
BAR: what done means, checkable (a test, a screenshot, a number)
RETURN: the short shape of what comes back
```

It checks `cortextos bus create-task ... --assignee <seat>` (both `--opt value` and `--opt=value`) and the
`bus/create-task.sh` wrapper. Lines match in any case and any order. A line whose only value is an unexpanded `$VAR`
counts as empty. Tasks for this seat (`CTX_AGENT_NAME`) and tasks with no assignee pass. Fails closed on a crash
when the input looks like a dispatch.

### Future-time guard: `future_time_guard.py`

`PreToolUse` on `Bash`, `Write` and `Edit`. Blocks a memory write, `STATE.md` write or send whose UTC stamp
(`HH:MM UTC` or `HH:MMZ`) is more than `OGL_FUTURE_SLACK_MIN` minutes (default 3) ahead of the real clock. Planned
times ("at", "by", "due", "scheduled", "until"), other days' dated stamps and ranges like `10:3x` pass. It is a
tripwire: on an internal error it fails open. Self-test: `python3 future_time_guard.py --selftest`.

### Compaction kit: `compaction/`

Three hooks that keep a seat oriented across context compaction. None of them blocks.

| File | Event | Does |
|------|-------|------|
| `meter.py` | `PostToolUse` | reads the session transcript's token count; speaks once at the nudge threshold and once at the warning threshold |
| `after_compact.py` | `SessionStart`, matcher `compact` | hands `STATE.md` back to the agent and re-arms the meter |
| `save_summary.py` | `PostCompact` | saves the compaction summary to `compactions/<time>.md` in the seat |

`compaction.json` holds the thresholds and file names:

```json
{ "nudge": 300000, "warning": 360000, "limit": 400000, "state_file": "STATE.md", "summaries_dir": "compactions" }
```

Set `limit` to the context size you want the seat to work within and the thresholds below it. The installer never
overwrites an existing `compaction.json`. Per-session marks go to `$OGL_STATE_DIR/compaction-marks/` when
`OGL_STATE_DIR` is set, else to `.marks/` beside the hooks.

### Memory hooks: `memory/`

Three hooks that carry the conversation across compaction and restarts. None of them blocks; each always exits 0.
`transcript.py` is the shared reader: it keeps the person's words and the agent's text replies, and drops tool calls,
tool results, thinking, sub-agent (sidechain) lines, injected harness text, system reminders and `[CRON FIRED ...]`
prompts.

| File | Event | Does |
|------|-------|------|
| `precompact_checkpoint.py` | `PreCompact` | writes the last 40 messages (600 characters each) to `memory/checkpoints/latest.md` and a timestamped copy (newest 20 kept), and appends `NOTE <hh:mm> UTC: [hook] PreCompact checkpoint written (N msgs captured)` to today's daily file |
| `sessionstart_inject.py` | `SessionStart` (every source) | injects `latest.md` if it is under 72 hours old (last 4,000 characters), the last 3,000 characters of today's daily file (or yesterday's), and an ENTITIES.md reminder when the seat has one |
| `session_facts.py` | `PostCompact` | appends the compaction summary to `$CTX_ROOT/state/<agent>/memory/facts/<date>.jsonl`, the file `cortextos bus recall-facts` reads |

The checkpoint hook is pure Python and reads its JSON payload from stdin before anything else runs. (A shell wrapper
around `python3 - <<EOF` hands Python the script on stdin, so the payload never arrives and every checkpoint is
empty; `test_memory_hooks.py` keeps a regression case for that.) A capture of zero messages is written as
`CHECKPOINT FAILED` in the file and the daily note, and the inject hook turns it into a warning for the agent, so
a broken checkpoint cannot look healthy.

`session_facts.py` exists because the framework's `hook-extract-facts` reads a `summary` field that Claude Code's
PreCompact payload does not carry (the summary does not exist yet at PreCompact). The summary arrives at PostCompact
as `compact_summary`; this hook writes it in the framework's JSON-lines shape (`ts`, `session_id`, `agent`, `org`,
`source`, `summary`, `keywords`).

| Variable | Default | Meaning |
|----------|---------|---------|
| `OGL_CHECKPOINT_MESSAGES` | `40` | messages kept in a checkpoint |
| `OGL_CHECKPOINT_CHARS` | `600` | characters kept per message |
| `OGL_CHECKPOINT_KEEP` | `20` | timestamped checkpoint copies kept |
| `OGL_INJECT_MAX_AGE_HOURS` | `72` | an older checkpoint is not injected |
| `OGL_INJECT_CHECKPOINT_CHARS` | `4000` | checkpoint characters injected |
| `OGL_INJECT_DAILY_CHARS` | `3000` | daily-file characters injected |
| `CTX_ROOT`, `CTX_AGENT_NAME`, `CTX_ORG` | set by the daemon | where `session_facts.py` writes |

## Memory components: `memory/`

Each component is optional and installed by a flag. Code is copied into `<seat>/.claude/hooks/ogl/memory/`. Data
the components write stays next to the code or in the seat's `memory/` folder. `memory/.gitignore` lists the data
paths; never commit them.

### Session digest: `memory/session-digest/` (`--with-digest`, `--with-notes-recall`)

A model-written summary of each session, filed into the seat's notes and made searchable without a vector database
or an API key.

| File | Role |
|------|------|
| `digest/session_end.py` | `SessionEnd` and `PreCompact` hook. Filters the transcript in code (same keep and drop rules as above), keeps the last `max_turns` turns within `max_chars`, stages the text in `digest/pending/`, and in `headless` mode spawns the write-up detached. Returns in well under a second |
| `digest/headless_run.py` | Runs `claude -p --model <model>` in an empty folder with `CLAUDE*` and `CTX_*` variables removed, appends the entry under `## Session <hh:mm>` to `<notes>/digests/<YYYY-MM-DD>.md`, then re-indexes that file. On failure the staged file stays for a retry and the reason goes to `digest/log/digest.log` |
| `digest/session_start.py` | `SessionStart` hook for `session` mode: hands staged text to the next session to write up in a background sub-agent. Silent in `headless` mode |
| `digest/digest-prompt.md` | The voice and structure of an entry: what happened, decisions, lessons, facts, open loops, and a dense "for the index" block. Edit it |
| `digest/config.json` | `mode` (`headless` or `session`), `min_turns` (5), `max_turns` (120), `max_chars` (40000), `model` (`sonnet`), `corpus` (notes folder; empty means `<seat>/memory`), `log_dir` (`digests`), `distil` (false) |
| `index/build_index.py` | Chunks markdown on headings (about 1,600 characters, each chunk labelled `[file § section]`), builds a SQLite FTS5 keyword index and, with `fastembed`, a local `bge-small-en-v1.5` embedding leg, into `index/index.db`. `--update <rel>` re-indexes one file. Skips hidden folders, `archive/` and `checkpoints/` |
| `index/search.py` | `python3 search.py [--top N] "question"`: both legs, merged by reciprocal rank fusion (k=60), hits printed with the lines around them |
| `index/recall_hook.py` | Optional `UserPromptSubmit` hook: injects the top five hits (about 1,500 characters). Skips cron prompts. Loads the embedding model per prompt (about a second with `fastembed`, near zero without) |
| `index/distil.py` | Optional: one `claude -p` call per note turns it into the questions it answers plus a quote; the quote must appear in the note word for word or the entry is dropped. Turn on with `"distil": true` |

Cost: `headless` mode spends one model call per session end and per compaction. `session` mode spends none in the
hook and asks the next session to do the write-up.

### Client memory graph: `memory/client-graph/` (`--with-client-graph`)

A small SQLite graph of clients, people, deliverables and commitments, with dated facts that each carry a quote from
the source message. A `UserPromptSubmit` hook injects the matching facts before the model reads a question about a
known client or person.

| File | Role |
|------|------|
| `schema.sql` | `entities`, `relations` (with `date` and `quote`), `aliases`, `meta` |
| `build_graph.py` | `code`: loads clients, people and roles from your config, deliverable files named `<prefix> - <project> - <doc> (<YYYY-MM-DD>).<ext>`, and a commitments JSON. `extract`: one `claude -p` call per batch of a client's messages, closed vocabulary, resumable. `load`: writes `graph.db`, keeping a signal only when code finds its quote in the source message, and never taking ownership or roles from a chat quote |
| `recall.py` | Seeds entities from the question, walks two hops with a recursive SQL query, filters by question intent, newest first. No model call |
| `recall_hook.py` | The hook. Skips `[CRON FIRED` prompts; for wrapped Telegram and agent messages reads only the newest body (the longest code fence); injects nothing when a name appears with no question; caps output at 6,000 characters; labels quotes as evidence and summaries as model-written |
| `evals.py` | Known-answer checks from a cases file: `python3 evals.py --cases cases.json` |
| `config.example.json` | Message log path and field names, the operator's name, names that never seed a search, and one entry per client |
| `fixtures/` | A synthetic two-client set (messages, model output with a planted fabricated quote and a planted ownership claim, cases) used by the tests. Not installed |

Build: copy `config.example.json` to `graph.config.json`, fill it in, then
`python3 build_graph.py all --config graph.config.json`. Write your own `cases.json` from the sources before you look
at recall output, and run `evals.py` after every rebuild. `graph.db` and `work/` hold client data.

### Vault graph and graph MCP: `memory/vault-graph/` (user level, not installed into a seat)

| File | Role |
|------|------|
| `vault_graph.py` | Builds `graph.json` from a markdown vault's `[[wikilinks]]` and tags, no model. Same node-link shape as graphify output |
| `graph_mcp.py` | A stdio MCP server over any `graph.json` (graphify's or `vault_graph.py`'s): `memory_query`, `memory_neighbors`, `memory_shortest_path`, `memory_read_note`. Read-only; re-reads the graph when the file changes; `memory_read_note` refuses paths outside `OGL_VAULT_DIR` |
| `neo4j_load.py` | Loads `graph.json` into Neo4j (`:Note` nodes, `:LINK {relation}` edges), replacing the previous load. `--dry-run` prints the plan. Password from `NEO4J_PASSWORD` only |
| `docker-compose.yml` | Neo4j 5 community edition bound to `127.0.0.1` |

Setup steps for this and the other external stores are in [GETTING-STARTED.md](../GETTING-STARTED.md#memory-full-setup).

## Skills

| Skill | Use |
|-------|-----|
| `tasks` | task lifecycle, the four-line dispatch brief, verifying a return |
| `approvals` | approval workflow for external and irreversible actions, and how it meets the ship gate |
| `cron-management` | daemon crons, the standing-duty rule, proving a first fire |
| `complex-decomposition` | research wave, discovery-completeness audit and surface tags before a big directive |

The framework ships its own `tasks`, `approvals` and `cron-management` skills. The versions here replace them in the seat
and add the OGL Cortex rules. Every `cortextos bus` command in them exists in the `cortextos` CLI; check with
`cortextos bus <command> --help`.

## Templates

| Template | Goes to | Installer rule |
|----------|---------|----------------|
| `CLAUDE.md` | `<seat>/CLAUDE.md` | merged as the `seat-rules` block (from `## Session start` on when the file has its own text) |
| `GUARDRAILS.md` | `<seat>/GUARDRAILS.md` | merged as the `seat-gates` block (from `## Named gates` on) |
| `HEARTBEAT.md` | `<seat>/HEARTBEAT.md` | merged as the `memory-steps` block (from `## OGL Cortex memory steps` on) |
| `STATE.md`, `ENTITIES.md`, `MEMORY.md` | `<seat>/` | created only if missing |
| `org-GUARDRAILS.md` | `$CORTEX_HOME/orgs/<org>/GUARDRAILS.md` | merged as the `cardinal-rule` block |
| `org-knowledge.md` | `$CORTEX_HOME/orgs/<org>/knowledge.md` | merged as the `fleet-rules` block (from `## Cardinal rules` on) |
| `user-CLAUDE.md` | `~/.claude/CLAUDE.md` | merged as the `memory-read-order` block, only with `--user-level` |
| `daily-memory.md` | reference only | the format of `memory/<YYYY-MM-DD>.md` |

- `CLAUDE.md`: a seat's operating rules. Session start, tasks, dispatch, approval gates, memory protocol and recall
  order, STATE.md checkpoints, messages, crons, guards, restart, compact instructions. Roles: orchestrator,
  specialist, auditor, sentinel.
- `STATE.md`: the checkpoint file the compaction kit hands back. Checkpoint, promises, live surfaces and their
  rollback, changes of plan, decisions, dead ends, open dispatches, the user's rules.
- `ENTITIES.md`: the noun index with its write gate (rank the source, check for conflict, attach provenance) and
  the entry format.
- `MEMORY.md`: the long-term memory file and its index rules.
- `GUARDRAILS.md`: a red-flag table and named gates (evidence-state labels, source grounding, untrusted reads,
  pre-restart inventory, no undisclosed astroturf, regulatory and money flags, secrets).
- `HEARTBEAT.md`: the heartbeat cycle with entity upkeep, knowledge base re-ingest, checkpoint health and meetings.
- `org-GUARDRAILS.md`: the cardinal rule (label every claim Proven, Inferred or Open) and authority rules.
- `org-knowledge.md`: the org knowledge file with cardinal rules, fleet conventions and an expected-dormant list.
- `user-CLAUDE.md`: the memory read order and write rules for every Claude Code session on the machine.

A merged block sits between `<!-- OGL-CORTEX:BEGIN <name> ... -->` and `<!-- OGL-CORTEX:END <name> -->`. The
installer replaces only that block on a re-run, keeps every line outside it, and backs the file up first. `<seat>`
and `<org>` are filled in from the seat path. Edit the harness template, not the block, or your edit is replaced on
the next run. To stop managing a file, delete the two marker lines.

## Tools

Command-line tools that the operating rules call. They are not hooks, so `install.sh` does not copy them. Run them
from the repo checkout, or copy `tools/` to a folder on your `PATH`. Each prints its usage with `--help`
(`brief_audit.py` with `-h`).

### `tools/ship.sh`: gate, deploy, live re-check

Every production deploy goes through one command, so the gate cannot be skipped by accident.

```bash
harness/tools/ship.sh <dir> <prod-url> \
  --gate-cmd 'python3 /path/to/ogl-cortex/harness/security/cortex_pentest_gate.py . --output security ${1:+--url "$1"}' \
  [--deploy-cmd "<cmd>"] [--promote-cmd "<cmd>"] [--remove-cmd "<cmd>"]
```

Direct mode (no `--promote-cmd`): static gate, deploy (default `vercel deploy --prod --yes`), then prod must answer
HTTP 200 and pass the gate again with its URL.

Preview-then-promote mode (`--promote-cmd` set): the deploy command builds a candidate and prints its URL (JSON
with `deployment.url`, or a bare `https://` line). The candidate must answer 200 without redirects and pass the gate
with its URL. Only then does the promote command run, with the candidate URL appended. Then the live check runs.
For Vercel: `--deploy-cmd 'vercel deploy --prod --skip-domain --yes --format json' --promote-cmd 'vercel promote --yes' --remove-cmd 'vercel remove --yes'`.

The gate command runs as `bash -c "<cmd>" _ "<url>"`: `$1` is the URL to scan, empty for the static run. It must
write `security/pentest-gate-report.json` with `"status": "pass"`. Before each gate run the previous report is
moved to `pentest-gate-report.json.prev`, so an old verdict is never read as a new one.

| Exit | Meaning |
|------|---------|
| 0 | shipped: both gates passed and prod answers 200 |
| 2 | usage error |
| 3 | pre-deploy gate failed; nothing deployed |
| 4 | deploy failed, or no candidate URL; prod untouched |
| 5 | **live and wrong**: deployed, but prod is not 200 or the live gate failed; check or roll back now |
| 6 | candidate not 200 or failed its gate; prod untouched; candidate removed if `--remove-cmd` is set |
| 7 | promote failed; prod still on the old deployment; safe to retry |

Options can also come from `OGL_SHIP_GATE_CMD`, `OGL_SHIP_DEPLOY_CMD`, `OGL_SHIP_PROMOTE_CMD` and
`OGL_SHIP_REMOVE_CMD`. Exit 5 logs a `ship_postgate_failed` warning event when `cortextos` is on `PATH`.

### `tools/adversarial-pass.sh`: a fenced adversarial pass

Also called "the hunter". A fresh model session that did not
write the code tries to break one claim. The fence: one claim, named files, read-only tools, one round, a time
budget, and every finding backed by `file:line` plus a reproduction and an answer to "can real user or operator
actions reach this?".

```bash
harness/tools/adversarial-pass.sh --claim "the guard blocks every write to ~/.claude" \
  --cd <repo> [--budget 10] [--engine opus|sonnet|<model>|codex] [--out-dir ./adversarial-runs] file1 [file2 ...]
```

The Claude engine runs `claude -p --model <m> --allowedTools Read,Grep,Glob --setting-sources ""
--strict-mcp-config --no-session-persistence` with `CLAUDECODE` and all `CTX_*` variables removed, so the hunter has
no project settings, MCP servers, memory or seat identity. `--engine codex` uses `codex exec -s read-only`. The
report path is printed on stdout. Exit 0: report written; 2: usage error; 3: report written but the engine failed
or timed out.

How to use the result: judge each finding by one question, can real user or operator actions reach it? Drop
invented inputs, even true ones. Land every fix with a test that fails without it; do not prove a fix by re-running
the hunter.

### `tools/brief_audit.py`: did the worker stay inside FILES?

```bash
python3 harness/tools/brief_audit.py <task_id> [--agents-dir DIR] [--projects-dir DIR] [--task-json FILE]
```

Reads the task's FILES line and lists every file the assignee wrote in the task's time window: Write, Edit and
NotebookEdit calls from its Claude Code transcripts, plus files under its seat folder modified in the window. Each
write is `IN`, `tmp` or `OUT`. An `OUT` is a question for the coordinator, not a verdict. Defaults:
`--agents-dir $CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/agents`, `--projects-dir ~/.claude/projects`, task from
`cortextos bus list-tasks --format json`. Exit 0: no OUT; 3: at least one OUT; 2: usage error or task not found.
Run it before you accept a return.

### `tools/emit-truth-correction.sh`: the truth-correction ledger

Records that an agent said something false and who caught it, as a `truth_correction` bus event. The catcher is
derived, never typed:

| Kind | `caught_by` from |
|------|------------------|
| `self_correction`, `verify_cleared` | the correcting agent (`CTX_AGENT_NAME` or `--caught-agent`) |
| `peer_catch`, `enforcer_catch` | the catcher's bus message id, `--triggering-msg <ts>-<agent>-<rand>` |
| `artifact_catch` | the seat that owns the file read, `--artifact-path` under `.../agents/<seat>/` or `.../state/<seat>/`; the file must predate the catch; your own file becomes `self_correction` |
| `principal_catch` | the human principal, proven by `--principal-evidence telegram:<chat_id>:<message_id>` matching a record in `$CTX_ROOT/logs/*/inbound-messages.jsonl` sent by `OGL_PRINCIPAL_ID` |
| `known_unrecordable_catch` | the principal, with a required `--candidate-set '<json object>'` describing what was searched |

```bash
harness/tools/emit-truth-correction.sh --kind peer_catch --triggering-msg <msg_id> --dedupe-slug wrong-row-count \
  --claim "the export has 12 rows" --correction "it has 10 rows" --evidence "wc -l export.csv" --dry-run
```

The dedupe key is `<caught_agent>.<slug>.<YYYYMMDDTHHMMSS>`; slug and agent must match `[a-z0-9-]+`.
`--occurred-at` must carry a time zone and may not be in the future; it is normalised to UTC. A value flag with no
value is refused, so it cannot swallow `--dry-run`. `--near-miss` marks a catch made before the false claim reached
anyone. Exit 0: emitted (or printed with `--dry-run`); 2: input rejected, nothing emitted; anything else: the
`cortextos` CLI's exit code. Set `OGL_PRINCIPAL_NAME` to change the `caught_by` value for principal kinds (default
`principal`).

## Install

The installer works on one seat directory: the folder that holds the seat's `CLAUDE.md`, usually
`$CORTEX_HOME/orgs/<org>/agents/<seat>`.

```bash
# 1. See what it would do. Writes nothing.
harness/install.sh "$CORTEX_HOME/orgs/<org>/agents/<seat>"

# 2. Install. Add --with-digest, --with-notes-recall or --with-client-graph for the optional memory components.
harness/install.sh "$CORTEX_HOME/orgs/<org>/agents/<seat>" --apply

# 3. Check the installed guard, then restart the seat so Claude Code loads the hooks.
python3 "$CORTEX_HOME/orgs/<org>/agents/<seat>/.claude/hooks/ogl/shared_surface_guard.py" --selftest
cortextos restart <seat>
```

What `--apply` writes:

| Target | Rule |
|--------|------|
| `<seat>/.claude/hooks/ogl/*` | created, or replaced with a backup when different |
| `<seat>/.claude/hooks/ogl/compaction/compaction.json` | created only if missing |
| `<seat>/.claude/hooks/ogl/memory/*.py` | the memory hooks; created, or replaced with a backup when different |
| `<seat>/.claude/hooks/ogl/memory/session-digest/` | with `--with-digest`: code replaced with a backup when different; `digest/config.json` created only if missing |
| `<seat>/.claude/hooks/ogl/memory/client-graph/` | with `--with-client-graph`: code only, never `graph.db` |
| `<seat>/.claude/settings.json` | hook entries from `settings.example.json` (and the component `hooks.json` files you asked for) merged in; entries already present are skipped; `autoCompactWindow` set only if missing; other keys are kept |
| `<seat>/.claude/skills/<name>/SKILL.md` | created, or replaced with a backup when different |
| `<seat>/CLAUDE.md`, `GUARDRAILS.md`, `HEARTBEAT.md` | the OGL block merged in (see Templates); the rest of the file is kept |
| `<seat>/STATE.md`, `ENTITIES.md`, `MEMORY.md` | created only if missing |
| `<seat>/memory/` | created if missing |
| `$CORTEX_HOME/orgs/<org>/GUARDRAILS.md`, `knowledge.md` | the OGL block merged in, when the seat sits under `orgs/<org>/agents/` |

Every file it changes is first copied to `<file>.bak-<UTC timestamp>`. Running it twice changes nothing.

### Machine-wide guards: `--user-level`

The ship gate, shared-surface guard and Orwell send-lint protect the whole machine. With `--user-level` they are
wired once in `~/.claude/settings.json` (hooks copied to `~/.claude/hooks/ogl/`) and left out of the seat's
settings, so they do not run twice. Seat-scoped hooks (brief guard, future-time guard, compaction kit, memory hooks)
stay in the seat. The flag also merges the memory read-order block into `~/.claude/CLAUDE.md`. Without the flag the
installer never reads or writes `~/.claude`.

```bash
harness/install.sh "$CORTEX_HOME/orgs/<org>/agents/<seat>" --apply --user-level
```

### Manual install

Copy `hooks/` to `<seat>/.claude/hooks/ogl/` and merge the `hooks` block and `autoCompactWindow` of
`settings.example.json` into `<seat>/.claude/settings.json`. For a memory component, copy its folder to
`<seat>/.claude/hooks/ogl/memory/<component>/` and merge its `hooks.json`. Claude Code expands `$CLAUDE_PROJECT_DIR` in hook commands to the seat directory.

### Configuration

The hooks read their settings from environment variables. Set them where the seat's Claude Code process starts (the
seat's `.env` loaded by the daemon, or the shell that launches it). Claude Code's settings `"env"` block also sets
variables for the session; check on your Claude Code version that hook processes inherit them.

## Test

```bash
python3 harness/tests/run_all.py
```

The memory tests feed hook JSON and synthetic transcripts (`tests/memfixtures.py`) to each memory hook and
component, use a fake `claude` for the model, and assert what gets written or injected (must-work) and that bad
input exits 0 without a traceback (must-not-break). Each guard test feeds `PreToolUse` JSON to one hook on stdin and asserts the exit code: every must-block case exits
`2`, every must-allow case exits `0`. `test_tools.py` runs each tool against fakes (a fake gate, deploy, HTTP
check, model CLI and `cortextos` CLI) and asserts its documented exit code for must-pass and must-fail cases. Tests run with a temp `OGL_STATE_DIR` and `OGL_NO_BUS=1`, so they write nothing
outside temp directories and send no bus events. Expected output:

```
ship_gate              must-block 17/17   must-allow 10/10   PASS
shared_surface_guard   must-block 17/17   must-allow 16/16   PASS
orwell_lint            must-block 12/12   must-allow 10/10   PASS
orwell_lint --text     must-block 1/1   must-allow 1/1   PASS
brief_guard            must-block 9/9   must-allow 7/7   PASS
future_time_guard      must-block 4/4   must-allow 6/6   PASS
compaction             behaviour 7/7   (no blocking hooks)   PASS
ship.sh                must-pass 3/3   must-fail 13/13   PASS
adversarial-pass.sh    must-pass 2/2   must-fail 6/6   PASS
brief_audit.py         must-pass 4/4   must-fail 5/5   PASS
emit-truth-correction  must-pass 8/8   must-fail 15/15   PASS
pentest_gate           checks 18/18 (incl. 14 redaction tests)   PASS
memory hooks           must-work 17/17   must-not-break 12/12   PASS
session digest         must-work 12/12   must-not-break 11/11   PASS
client graph           must-work 10/10   must-not-break 11/11   PASS
vault graph + MCP      must-work 13/13   must-not-break 8/8   PASS
install.sh (memory)    must-work 18/18   must-not-break 5/5   PASS
ALL PASS
```

`test_pentest_gate.py` checks that a clean project passes; a project with fake AWS, GitHub and private-key values fails; no raw value reaches any gate output; a recorded disposition clears an unverified hit; `--url` without Docker fails; `--requires-authz` without evidence fails; and `ship_gate.py` allows a push with the gate's pass report and blocks it with the fail report. It also runs the 14-case redaction suite in `harness/security/test_secret_redaction.py`. External scanners are hidden during the test, so it needs no network and no Docker.

Run one file to test one hook: `python3 harness/tests/test_ship_gate.py`. The future-time test skips itself within 30
minutes of midnight UTC.

To try a hook by hand:

```bash
echo '{"tool_name":"Bash","tool_input":{"command":"npx vercel --prod"},"cwd":"/tmp"}' \
  | python3 harness/hooks/ship_gate.py; echo "exit $?"
```

## Remove

1. Delete the hook entries that point at `.claude/hooks/ogl/` from `<seat>/.claude/settings.json`, or restore the
   backup the installer made: `cp <seat>/.claude/settings.json.bak-<stamp> <seat>/.claude/settings.json`.
2. Delete `<seat>/.claude/hooks/ogl/`.
3. Delete the skills you do not want under `<seat>/.claude/skills/`, or restore their `SKILL.md.bak-<stamp>` files.
4. Delete the `OGL-CORTEX:BEGIN` to `OGL-CORTEX:END` blocks from `CLAUDE.md`, `GUARDRAILS.md`, `HEARTBEAT.md` and the
   org `GUARDRAILS.md` and `knowledge.md`, or restore their `.bak-<stamp>` files. Keep or delete `STATE.md`,
   `ENTITIES.md`, `memory/` and `compactions/`: they hold the seat's memory.
5. If you used `--user-level`: do steps 1 and 2 for `~/.claude/settings.json` and `~/.claude/hooks/ogl/`.
6. Delete `~/.ogl-cortex/state/` (tokens and guard logs).
7. Restart the seat.

## Known limitations

- The shared-surface guard reads command text. A path built at run time (string pieces joined, base64, read from a
  file) is not seen. Code it cannot parse that names `~/.claude` is blocked, which can over-flag.
- The ship gate matches command text. A script that deploys inside itself (`./deploy.sh`) passes unless you add its
  name to `OGL_SHIP_EXTRA_PATTERNS`. Quoted text that contains a ship command (`echo "git push"`) is blocked.
- The Orwell send-lint uses fixed English word lists. It flags some correct sentences; the pass token covers those.
- The future-time guard knows UTC stamps only and fails open on error.
- The compaction meter reads token counts from the Claude Code session file. If that format changes, the meter goes
  quiet; it never blocks.
- Pass tokens are files. Any process running as the same user can create one.
- `ship.sh` trusts the gate command to scan what it is given; it checks only that the report is fresh and says
  pass. Direct mode deploys before the live gate runs; use preview-then-promote to gate before prod changes.
- `brief_audit.py` cannot tell two tasks apart when one seat works both in the same window, and it does not see
  Bash writes outside the seat folder.
- The checkpoint and digest filters know the transcript format of current Claude Code versions. If the format
  changes, the checkpoint says `CHECKPOINT FAILED` and the digest stages nothing; neither blocks.
- `headless` digests run a model call per session end and per compaction, on the seat's own Claude login.
- The digest index without `fastembed` is keyword-only. A full rebuild of a large notes folder takes minutes; the
  hooks re-index one file at a time.
- The client graph is only as current as its last build. Rebuild it on a cron; the recall hook reads whatever
  `graph.db` holds.
- `graph_mcp.py` reads a whole `graph.json` into memory. Very large graphs belong in Neo4j.
- `emit-truth-correction.sh` reads `OGL_PRINCIPAL_ID` from its caller's environment. Anyone who can run it can set
  that variable, so the principal check proves a matching record exists, not who ran the script.

## Licences

- Hooks, tests, installer, templates and the `complex-decomposition` skill: OGL Cortex.
- `skills/tasks`, `skills/approvals`, `skills/cron-management`: derived from the cortextOS skills of the same names.
  cortextOS is MIT licensed, Copyright (c) 2026 Cortext LLC. The full notice is in
  `third_party/cortextOS-LICENSE` and applies to those portions.
- `tools/ship.sh`, `tools/emit-truth-correction.sh`: OGL Cortex.
- `tools/adversarial-pass.sh` and `tools/brief_audit.py`: adapted from Glitch Cat Club build exercises (the fenced
  adversarial pass and the brief audit). **Licence confirmation pending.**
- `hooks/compaction/`: the pattern (meter thresholds, STATE.md hand-back, summary save) is adapted from Glitch Cat
  Club's "Controlled Compaction". The four-line brief follows the same source's orchestration guidance. **Licence confirmation pending** for both.
- `memory/session-digest/` (filter, headless write-up, distil, heading-aware index with rank fusion) and
  `memory/client-graph/` (three-table graph, quote-checked extraction, recursive recall, recall hook, evals): adapted
  from Glitch Cat Club's memory starter and graph memory starter. **Licence confirmation pending.**
- `hooks/memory/`, `memory/vault-graph/` and the memory templates: OGL Cortex.
- The Orwell rules come from George Orwell, "Politics and the English Language" (1946). The word lists are original.

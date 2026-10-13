# OGL Cortex harness

The command-line tool is named `cortextos`.

The harness is the layer OGL Cortex adds on top of the framework install (daemon, bus and `cortextos` CLI). It holds guard hooks, operating skills and
seat templates. You install it into one seat (one agent directory) at a time.

| Piece | Path | What it does |
|-------|------|--------------|
| Guard hooks | `hooks/` | Claude Code hooks that block unsafe or sloppy tool calls before they run |
| Hook tests | `tests/` | Feed sample hook JSON to each hook and check the exit code |
| Settings block | `settings.example.json` | The `hooks` block that wires the guards into a seat |
| Skills | `skills/` | Four operating skills: tasks, approvals, cron-management, complex-decomposition |
| Templates | `templates/` | A seat `CLAUDE.md` and a `STATE.md` that encode the operating rules |
| Tools | `tools/` | Command-line tools the operating rules call: ship.sh, adversarial-pass.sh, brief_audit.py, emit-truth-correction.sh |
| Installer | `install.sh` | Copies all of the above into a seat. Dry run by default |
| Licences | `third_party/` | Licence texts for code derived from other projects |

Requirements: the OGL Cortex framework installed, with its CLI on `PATH` as `cortextos`, Claude Code, Python 3.9 or later, bash. The hooks
use the Python standard library only.

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
| `OGL_PENTEST_GATE_CMD` | placeholder text | the command printed in the block message to produce the report |
| `OGL_PENTEST_OVERRIDE` | unset | `accepted-risk` plus a risk-acceptance file lets ship commands through |
| `OGL_SHIP_EXTRA_PATTERNS` | unset | extra regexes, one per line, that also count as ship commands (for example `\bdeploy\.sh\b`) |

The report format is the only contract. Any pentest tool works if it writes that JSON file.

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

- `templates/CLAUDE.md`: a seat's operating rules. Session start, tasks, dispatch, approval gates, memory protocol,
  STATE.md checkpoints, messages, crons, guards, restart, compact instructions. Replace every `<placeholder>`. Roles:
  orchestrator, specialist, auditor, sentinel.
- `templates/STATE.md`: the checkpoint file the compaction kit hands back. Checkpoint, promises, live surfaces and
  their rollback, changes of plan, decisions, dead ends, open dispatches, the user's rules.

## Tools

Command-line tools that the operating rules call. They are not hooks, so `install.sh` does not copy them. Run them
from the repo checkout, or copy `tools/` to a folder on your `PATH`. Each prints its usage with `--help`
(`brief_audit.py` with `-h`).

### `tools/ship.sh`: gate, deploy, live re-check

Every production deploy goes through one command, so the gate cannot be skipped by accident.

```bash
harness/tools/ship.sh <dir> <prod-url> \
  --gate-cmd 'python3 /path/to/pentest_gate.py . --output security ${1:+--url "$1"}' \
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

# 2. Install.
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
| `<seat>/.claude/settings.json` | hook entries from `settings.example.json` merged in; entries already present are skipped; other keys are kept |
| `<seat>/.claude/skills/<name>/SKILL.md` | created, or replaced with a backup when different |
| `<seat>/CLAUDE.md` | created only if missing; otherwise the template goes to `CLAUDE.ogl-template.md` for you to merge by hand |
| `<seat>/STATE.md` | created only if missing |

Every file it changes is first copied to `<file>.bak-<UTC timestamp>`. Running it twice changes nothing.

### Machine-wide guards: `--user-level`

The ship gate, shared-surface guard and Orwell send-lint protect the whole machine. With `--user-level` they are
wired once in `~/.claude/settings.json` (hooks copied to `~/.claude/hooks/ogl/`) and left out of the seat's
settings, so they do not run twice. Seat-scoped hooks (brief guard, future-time guard, compaction kit) stay in the
seat. Without the flag the installer never reads or writes `~/.claude`.

```bash
harness/install.sh "$CORTEX_HOME/orgs/<org>/agents/<seat>" --apply --user-level
```

### Manual install

Copy `hooks/` to `<seat>/.claude/hooks/ogl/` and merge the `hooks` block of `settings.example.json` into
`<seat>/.claude/settings.json`. Claude Code expands `$CLAUDE_PROJECT_DIR` in hook commands to the seat directory.

### Configuration

The hooks read their settings from environment variables. Set them where the seat's Claude Code process starts (the
seat's `.env` loaded by the daemon, or the shell that launches it). Claude Code's settings `"env"` block also sets
variables for the session; check on your Claude Code version that hook processes inherit them.

## Test

```bash
python3 harness/tests/run_all.py
```

Each hook test feeds `PreToolUse` JSON to one hook on stdin and asserts the exit code: every must-block case exits
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
ALL PASS
```

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
4. Delete `<seat>/CLAUDE.ogl-template.md` if present. Keep or delete `STATE.md` and `compactions/`.
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
- The Orwell rules come from George Orwell, "Politics and the English Language" (1946). The word lists are original.

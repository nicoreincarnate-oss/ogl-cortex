# Getting Started with OGL Cortex

This guide takes you from an empty machine to a running fleet: an orchestrator seat you talk to on Telegram, a specialist seat it can hand work to, scheduled crons, and the OGL Cortex harness layer (hooks and skills) on top.

OGL Cortex has two layers:

1. **cortextOS**, the MIT-licensed framework (upstream: `github.com/grandamenium/cortextos`). It runs each seat as a persistent Claude Code session under a Node.js daemon, supervised by PM2, with a file bus for messages, tasks, approvals and crons.
2. **The OGL Cortex harness**, from this repo's `harness/` folder: guard hooks, skills, seat templates and a doctor script.

You install the framework first, prove one seat works end to end, then add the harness.

There are two ways through this guide:

- **[Path A: Let Claude set it up](#path-a-let-claude-set-it-up).** Claude Code runs the steps, explains each one, and asks before every install and every secret.
- **[Path B: Do it yourself](#path-b-do-it-yourself).** Numbered steps with exact commands.

Both paths end at the same place and use the same checks.

---

## Contents

- [Prerequisites](#prerequisites)
- [Names used in this guide](#names-used-in-this-guide)
- [Path A: Let Claude set it up](#path-a-let-claude-set-it-up)
- [Path B: Do it yourself](#path-b-do-it-yourself)
- [The --instance gotcha](#the---instance-gotcha)
- [Day 2: using the fleet](#day-2-using-the-fleet)
- [Where logs and state live](#where-logs-and-state-live)
- [Known limitations](#known-limitations)
- [Next](#next)

---

## Prerequisites

| Requirement | Version | Check | Install |
|---|---|---|---|
| macOS or Linux | any current release | `uname -s` | Windows works upstream through Task Scheduler but this guide does not cover it |
| Node.js | 20 or newer (`engines.node >=20.0.0`) | `node --version` | [nodejs.org](https://nodejs.org), Homebrew (`brew install node`) or nvm |
| npm | ships with Node | `npm --version` | with Node |
| git | any | `git --version` | `xcode-select --install` (macOS) or your package manager |
| python3 | 3.9 or newer | `python3 --version` | Homebrew or your package manager. The harness hooks and `scripts/doctor.sh` use it |
| Claude Code CLI | current | `claude --version` | `npm install -g @anthropic-ai/claude-code` |
| Claude login | | `claude auth status --text` | `claude auth login` |
| PM2 | current | `pm2 --version` | `npm install -g pm2` |
| jq, curl | any | `jq --version`, `curl --version` | Homebrew or your package manager. Bus shell scripts and the Telegram helpers use them |
| C/C++ toolchain | | `xcode-select -p` (macOS), `gcc --version` (Linux) | Needed to build `node-pty`. macOS: `xcode-select --install`. Debian/Ubuntu: `sudo apt install build-essential` |
| Telegram account | | | Phone or desktop app |

Hardware: every seat is a full Claude Code process that stays in memory around the clock. Size RAM for the number of seats you plan to run, and keep at least 10 GB of free disk. The doctor script checks disk and swap pressure.

Use a Node install you own (Homebrew or nvm). With a system Node, `npm install -g` and `npm link` need `sudo`, and that causes permission trouble later.

---

## Names used in this guide

| Placeholder | Meaning | Example |
|---|---|---|
| `$CORTEX_HOME` | Your cortextOS checkout | `~/cortextos` |
| `<instance>` | Instance id. Picks the state dir `~/.cortextos/<instance>/` | `default` |
| `<org>` | Organization name, lowercase `[a-z0-9_-]` | `myorg` |
| `boss` | Example orchestrator seat | any lowercase name |
| `builder` | Example specialist seat | any lowercase name |
| `$CTX_ROOT` | `~/.cortextos/<instance>` | |

A **seat** is one persistent agent: a folder under `$CORTEX_HOME/orgs/<org>/agents/<seat>/` plus its state under `$CTX_ROOT`.

---

## Path A: Let Claude set it up

```bash
git clone <ogl-cortex-repo-url> ogl-cortex     # URL of this repository
cd ogl-cortex
claude
```

Inside Claude Code, run:

```
/cortex-setup
```

The command lives in `.claude/commands/cortex-setup.md`. Claude then:

1. Checks every prerequisite in the table above and shows you what is missing.
2. Explains each step before it runs it.
3. Asks for a yes before **every** install (`npm install -g`, `brew install`, `npm link`, `pm2 startup`) and before anything that writes into `~/.claude`.
4. Never asks you to paste a secret into the chat. You type the bot token into `.env` yourself, in your own editor.
5. Never starts a seat until that seat's `.env` holds `BOT_TOKEN`, `CHAT_ID` and `ALLOWED_USER`.
6. Stops and waits whenever a step needs you:
   - logging in to Claude (`claude auth login` opens a browser),
   - creating a Telegram bot with @BotFather,
   - pasting the bot token into `.env`,
   - sending the first message to your bot,
   - running any `sudo` command that `pm2 startup` prints.
7. Finishes by running `bash scripts/doctor.sh --instance <instance>` and showing you the result. Setup is done when the doctor reports zero FAIL lines and your orchestrator has answered you on Telegram.

You can stop at any point and run `/cortex-setup` again. Every step checks current state first and skips what is already done.

If you prefer to see every command, use Path B. The steps are the same.

---

## Path B: Do it yourself

Run each block in a terminal. Every block ends with a check. Do not move on until the check passes.

### Step 1. Check prerequisites

```bash
uname -s; node --version; npm --version; git --version; python3 --version
claude --version; pm2 --version; jq --version
claude auth status --text
```

Check: Node prints `v20` or higher and `claude auth status` says you are logged in. Install anything missing from the [Prerequisites](#prerequisites) table. If Claude Code is not logged in:

```bash
claude auth login
```

### Step 2. Install cortextOS

```bash
export CORTEX_HOME="$HOME/cortextos"
git clone https://github.com/grandamenium/cortextos.git "$CORTEX_HOME"
cd "$CORTEX_HOME"
npm install
npm run build
npm link            # puts the `cortextos` command on your PATH
```

Check:

```bash
cortextos --version
ls "$CORTEX_HOME/dist/daemon.js"
```

> The upstream project also ships a one-line installer (`install.mjs`, run with `curl ... | node`). It clones into `~/cortextos`, builds, links, installs PM2 and installs Claude Code if missing. This guide uses the explicit steps so you see and approve each one.

### Step 3. Pick an instance id and set your shell

The instance id selects the state directory `~/.cortextos/<instance>/`. Pick one now and use it everywhere. Read [The --instance gotcha](#the---instance-gotcha) before you continue.

Add these lines to `~/.zshrc` or `~/.bashrc`, then open a new terminal:

```bash
export CORTEX_HOME="$HOME/cortextos"
export CTX_INSTANCE_ID="default"                        # your instance id
export CTX_ROOT="$HOME/.cortextos/$CTX_INSTANCE_ID"
export CTX_FRAMEWORK_ROOT="$CORTEX_HOME"
```

`cortextos bus ...` commands have no `--instance` flag. They read `CTX_INSTANCE_ID` and `CTX_ROOT` from the environment. The cron commands in particular resolve `crons.json` from `CTX_ROOT`, and fall back to the current directory when it is unset.

### Step 4. Create the state directories and the organization

```bash
cd "$CORTEX_HOME"
cortextos install --instance "$CTX_INSTANCE_ID"
cortextos init myorg --instance "$CTX_INSTANCE_ID"
```

`install` checks dependencies and creates `$CTX_ROOT`. If Claude Code is missing it tries `npm install -g @anthropic-ai/claude-code` on its own, which is why Step 1 installs it first.

`init` creates `$CORTEX_HOME/orgs/myorg/` (from `templates/org/`) and the org state dirs under `$CTX_ROOT/orgs/myorg/`.

Now edit `$CORTEX_HOME/orgs/myorg/context.json`. At minimum set `name`, `timezone` and `orchestrator`:

```json
{
  "name": "myorg",
  "description": "What this fleet is for, in one sentence",
  "timezone": "America/New_York",
  "orchestrator": "boss",
  "day_mode_start": "08:00",
  "day_mode_end": "00:00",
  "default_approval_categories": ["external-comms", "financial", "deployment", "data-deletion"],
  "communication_style": "direct and casual"
}
```

Check:

```bash
ls "$CTX_ROOT" "$CORTEX_HOME/orgs/myorg"
```

### Step 5. Create the orchestrator seat from a template

```bash
cd "$CORTEX_HOME"
cortextos add-agent boss --template orchestrator --org myorg --instance "$CTX_INSTANCE_ID"
```

This copies `templates/orchestrator/` into `orgs/myorg/agents/boss/`, writes a placeholder `.env` with mode `600`, generates `SYSTEM.md` from `context.json`, and registers `boss` as enabled in `$CTX_ROOT/config/enabled-agents.json`.

Templates you can pass to `--template`:

| Template | Use |
|---|---|
| `orchestrator` | Coordinates the fleet: decomposes work, dispatches tasks, routes approvals, sends briefings |
| `analyst` | Fleet health, metrics, overnight experiments |
| `agent` | General specialist. Base for most seats |
| `agent-codex`, `agent-opencode` | Same specialist on a different runtime (`--runtime codex-app-server` or `opencode`) |

The seat is registered as enabled but nothing runs yet, because the daemon is not started. Keep it that way until Step 7 is done.

Optional: set the model in `orgs/myorg/agents/boss/config.json` by adding a `"model"` field. The rest of `config.json` holds the session length (`max_session_seconds`), crash budget (`max_crashes_per_day`), working hours and the seed crons.

### Step 6. Create a Telegram bot

Do this part by hand. Nobody else should see the token.

1. In Telegram, open a chat with **@BotFather**.
2. Send `/newbot`. Give it a display name and a username that ends in `bot`.
3. BotFather replies with an HTTP API token. Keep that chat open. Do not paste the token anywhere except the `.env` file in Step 7.
4. Tap the `t.me/...` link BotFather sends, press **Start**, and send your new bot any message, for example `hi`. A new bot cannot see a chat until you message it first.

### Step 7. Fill in the seat's .env

Open `$CORTEX_HOME/orgs/myorg/agents/boss/.env` in your editor and paste the token after `BOT_TOKEN=`. Save.

Now read your chat id and your numeric user id. This command reads the token from the file and passes it to curl on stdin, so the token stays out of your shell history and the process list:

```bash
ENVF="$CORTEX_HOME/orgs/myorg/agents/boss/.env"
TOKEN="$(grep -E '^BOT_TOKEN=' "$ENVF" | cut -d= -f2-)"
printf 'url = "https://api.telegram.org/bot%s/getUpdates?timeout=30"\n' "$TOKEN" \
  | curl -s -K - \
  | jq '.result[-1].message | {chat_id: .chat.id, user_id: .from.id}'
unset TOKEN
```

If it prints `null`, send the bot another message and run it again.

Add both values to `.env`. The finished file looks like this:

```dotenv
BOT_TOKEN=<token from BotFather>
CHAT_ID=<chat_id from the command above>
ALLOWED_USER=<user_id from the command above>
```

| Key | Required | What it does |
|---|---|---|
| `BOT_TOKEN` | yes, for Telegram | Format `<digits>:<secret>`. The daemon refuses to start Telegram on a malformed token |
| `CHAT_ID` | yes, for Telegram | Where the seat sends messages. In a private chat it equals your user id |
| `ALLOWED_USER` | yes when `BOT_TOKEN` is set | Comma-separated numeric Telegram user ids allowed to command the seat. Without it the daemon disables Telegram for the seat |
| `CLAUDE_CODE_DISABLE_1M_CONTEXT` | optional | Set `true` if compaction fails with "Extra usage is required for 1M context" |

Give every seat its own bot. Two seats polling one token steal each other's messages.

Check that the credentials work and that the file stays private:

```bash
cortextos enable boss --org myorg --instance "$CTX_INSTANCE_ID"
ls -l "$ENVF"        # expect -rw-------
```

`enable` reads `.env`, validates the token and chat against the Telegram API, and stops with an error if either is wrong. Fix the file and run it again.

### Step 8. Start the daemon

Generate the PM2 config with the instance id spelled out, then start it:

```bash
cd "$CORTEX_HOME"
cortextos ecosystem --instance "$CTX_INSTANCE_ID" --org myorg
pm2 start ecosystem.config.js
pm2 save
```

`ecosystem.config.js` defines `cortextos-daemon` (and `cortextos-dashboard` if `dashboard/` has its dependencies installed). The daemon starts every seat that is enabled in both `enabled-agents.json` and the seat's `config.json`.

You can also run `cortextos start --instance "$CTX_INSTANCE_ID"` from `$CORTEX_HOME`. It generates the ecosystem file if missing and starts it under PM2. It must run from `$CORTEX_HOME`, because it looks for `dist/daemon.js` in the current directory.

To survive a reboot:

```bash
pm2 startup        # prints a sudo command; run that command yourself
pm2 save
```

Check:

```bash
pm2 list                                        # cortextos-daemon: online
cortextos status --instance "$CTX_INSTANCE_ID"  # boss: running
```

### Step 9. First message round trip

Send your bot a message on Telegram, for example `hello`.

On first boot the seat finds no `.onboarded` flag and runs its onboarding skill in the chat: it confirms its role, goals, working hours and crons with you. Answer it there.

Check both directions on disk:

```bash
tail -n 3 "$CTX_ROOT/logs/boss/inbound-messages.jsonl"
tail -n 3 "$CTX_ROOT/logs/boss/outbound-messages.jsonl"
```

If nothing comes back within two minutes:

```bash
pm2 logs cortextos-daemon --lines 50
tail -n 50 "$CTX_ROOT/logs/boss/stdout.log"
cortextos doctor --instance "$CTX_INSTANCE_ID"
```

### Step 10. Add crons

Crons are owned by the daemon and stored per seat in `$CTX_ROOT/.cortextOS/state/agents/<seat>/crons.json`. They survive restarts. Seed crons from the template's `config.json` migrate into that file the first time the seat starts.

```bash
# wall-clock schedule, 5-field cron expression, in the seat's timezone
cortextos bus add-cron boss morning-inbox "0 8 * * *" \
  "Check the inbox, summarise anything that needs me, and send the summary on Telegram." \
  --desc "Daily 08:00 inbox summary"

# interval schedule
cortextos bus add-cron boss fleet-check 6h "Run cortextos bus read-all-heartbeats and report any stale seat."

cortextos bus list-crons boss
cortextos bus test-cron-fire boss morning-inbox     # fire once now
cortextos bus get-cron-log boss morning-inbox       # proof that it fired
```

Change or remove a cron:

```bash
cortextos bus update-cron boss fleet-check --interval 4h
cortextos bus update-cron boss fleet-check --enabled false
cortextos bus remove-cron boss fleet-check
```

Do not schedule recurring work with Claude Code's in-session tools (`CronCreate`, `/loop`). Those live inside one session and vanish on restart.

### Step 11. Add a specialist seat

Repeat Steps 5 to 7 for the new seat with its own bot. The daemon is already running, so it does not start the new seat until you enable it.

```bash
cd "$CORTEX_HOME"
cortextos add-agent builder --template agent --org myorg --instance "$CTX_INSTANCE_ID"
# create a second bot with @BotFather, fill orgs/myorg/agents/builder/.env (Step 7)
cortextos enable builder --org myorg --instance "$CTX_INSTANCE_ID"   # validates, then starts it
cortextos status --instance "$CTX_INSTANCE_ID"
```

`add-agent` registers the new seat as enabled at once. If the daemon restarts before `.env` is filled, it starts the seat with no Telegram. Fill `.env` straight after `add-agent`.

Prove the bus works between seats. In your orchestrator's Telegram chat, ask: "Create a task for builder to reply with the word pong, then tell me when it is done." Then:

```bash
cortextos bus list-tasks --agent builder
```

From a shell you can send to a seat's inbox as yourself:

```bash
CTX_AGENT_NAME=me cortextos bus send-message builder normal 'ping from the operator'
```

### Step 12. Install the OGL Cortex harness layer

The harness adds the guard hooks, skills and seat templates from this repo's `harness/` folder on top of the plain cortextOS seats. Read `harness/README.md` first. It lists every hook, what it blocks, and which settings file each one goes into.

```bash
cd /path/to/ogl-cortex
bash harness/install.sh --help      # read the options first
```

What the installer touches:

- **Seat level**: `$CORTEX_HOME/orgs/<org>/agents/<seat>/.claude/settings.json` and `.claude/hooks/`, `.claude/skills/`.
- **User level** (optional): `~/.claude/settings.json` and `~/.claude/hooks/`. These apply to every Claude Code session on the machine, not only your seats. Install them only if you want that.

Back up each `settings.json` before the installer edits it. Restart a seat after its hooks change, so the new session loads them:

```bash
cortextos restart boss --instance "$CTX_INSTANCE_ID"
```

A Claude Code hook blocks a tool call only when it exits with code 2. Any other non-zero exit is reported and the call goes ahead. After installing, prove each guard fires by feeding it a case it must block (see `harness/README.md`).

> `harness/install.sh` and `harness/README.md` are part of this repo's harness layer. Their exact flags are documented there. Not verified by this guide.

### Step 13. Verify everything with the doctor

```bash
cd /path/to/ogl-cortex
bash scripts/doctor.sh --instance "$CTX_INSTANCE_ID"
```

The doctor is read-only. It never writes, restarts or sends, and it prints `.env` key names only, never values. It checks:

- prerequisites and versions, Claude login, `cortextos` on `PATH`, `dist/daemon.js` built
- `cortextos-daemon` online under PM2 and running the same `--instance` you asked about
- the instance dir, `enabled-agents.json`, and the daemon IPC socket
- per seat: `.env` key names and mode `600`, token format, `ALLOWED_USER` present, Telegram `getMe`, `crons.json` readable, every hook script path in `.claude/settings.json` exists
- user-level hooks in `~/.claude/settings.json`
- free disk against a floor (`--disk-floor-gb`, default 10) and swap pressure

Every line is `PASS`, `WARN` or `FAIL`. The script exits non-zero on any `FAIL`. Options: `--framework <dir>` (default `$CTX_FRAMEWORK_ROOT` or `~/cortextos`), `--offline` (skip Telegram calls).

The framework has its own check too: `cortextos doctor --instance "$CTX_INSTANCE_ID"`.

Setup is complete when the doctor shows zero `FAIL` lines and the round trip in Step 9 works.

---

## The --instance gotcha

Most `cortextos` commands take `--instance <id>` and **default to `default`** when you leave it out. If your fleet runs under any other id, a command without the flag talks to an empty instance. It reports things like "Daemon is not running" or "No agents configured" while your fleet runs fine.

Rules that prevent it:

1. Pass `--instance "$CTX_INSTANCE_ID"` on every `install`, `init`, `add-agent`, `enable`, `disable`, `start`, `stop`, `restart`, `status`, `ecosystem`, `doctor`, `dashboard` and `uninstall`.
2. Export `CTX_INSTANCE_ID` and `CTX_ROOT` in your shell profile (Step 3). `cortextos status` and all `cortextos bus ...` commands read them.
3. Generate `ecosystem.config.js` with `--instance` spelled out. The generated file falls back to the instance it was generated with, and it bakes `CTX_ROOT` in at generation time. Regenerate it whenever you change instance.
4. When in doubt, ask the daemon: `bash scripts/doctor.sh --instance <id>` fails loudly if the PM2 daemon runs a different instance.

The commands that stop or restart do not touch the daemon process itself. Use `pm2 restart cortextos-daemon` or `pm2 stop cortextos-daemon` for that.

---

## Day 2: using the fleet

### Talk to it

Telegram is the main control surface. Message the orchestrator, and it breaks the request into tasks for specialist seats. Each seat answers in its own bot chat. Optional web dashboard:

```bash
cortextos dashboard --instance "$CTX_INSTANCE_ID" --install   # first run
cortextos dashboard --instance "$CTX_INSTANCE_ID"             # http://localhost:3000
```

### Tasks

Every piece of work longer than a few minutes gets a task, so it shows on the dashboard and survives restarts.

```bash
cortextos bus create-task "Draft the onboarding email" --assignee builder --priority high \
  --desc "TASK: ... FILES: ... BAR: ... RETURN: ..."
cortextos bus update-task <task-id> in_progress
cortextos bus complete-task <task-id> --result "Draft at deliverables/onboarding-email.md"
cortextos bus list-tasks --status pending
cortextos bus check-stale-tasks
```

Statuses: `pending`, `in_progress`, `blocked`, `completed`, `cancelled`. Use `--blocked-by <ids>` for dependencies and `--needs-approval` for work that must wait for a human yes.

### Approvals

Seats must ask before any external or irreversible action: sending email, posting, deploying, spending money, deleting data. They file an approval and stop until you answer.

```bash
cortextos bus create-approval "Send the launch email to the waitlist" external-comms "Draft: deliverables/launch.md"
cortextos bus list-approvals --format text
cortextos bus update-approval <approval-id> approved "Go"
cortextos bus update-approval <approval-id> denied "Hold until Monday"
```

Categories: `external-comms`, `financial`, `deployment`, `data-deletion`, `other`. You can also approve from Telegram or the dashboard. The orchestrator's `check-approvals` cron reminds you of anything pending.

### Memory protocol

Seats restart. Context compacts. Memory on disk is what carries work across both. Every seat keeps:

| Layer | File | Written when |
|---|---|---|
| Daily memory | `<seat>/memory/YYYY-MM-DD.md` | session start, before and after each task, each heartbeat, session end |
| Long-term memory | `<seat>/MEMORY.md` | when a fact must outlive today |
| Goals | `<seat>/goals.json`, rendered to `GOALS.md` | each morning review |

Regenerate `GOALS.md` after editing `goals.json`:

```bash
cortextos goals generate-md --agent boss --org myorg
```

If a seat resumes and seems to have forgotten its work, check that it wrote today's memory file.

### Heartbeats

Each seat writes a heartbeat on its heartbeat cron. The orchestrator reads them all to spot a stuck or silent seat.

```bash
cortextos bus read-all-heartbeats
cortextos list-agents --instance "$CTX_INSTANCE_ID"
cortextos status --instance "$CTX_INSTANCE_ID"
```

A heartbeat is self-reported. A seat that hangs before its next beat looks healthy until the beat is late, so judge freshness by the timestamp, not by the status text.

### Restarts

```bash
cortextos restart builder --instance "$CTX_INSTANCE_ID"   # stop + start one seat, re-reads config.json and .env
cortextos stop builder --instance "$CTX_INSTANCE_ID"
cortextos disable builder --instance "$CTX_INSTANCE_ID"   # stop and keep it stopped across daemon restarts
pm2 restart cortextos-daemon                              # the daemon itself
```

From inside a seat, `cortextos bus self-restart --reason "..."` keeps the conversation and `cortextos bus hard-restart --reason "..."` starts a fresh session. The daemon also rotates each session after `max_session_seconds` (default 255600, about 71 hours).

### Keep it current

```bash
cd "$CORTEX_HOME"
cortextos update --check      # see what changed upstream, apply nothing
cortextos update              # apply, after a confirmation prompt
```

Run the doctor after every update and every harness change.

---

## Where logs and state live

**Seat files** (what the seat is), under `$CORTEX_HOME/orgs/<org>/agents/<seat>/`:

| Path | Contents |
|---|---|
| `CLAUDE.md`, `AGENTS.md` | Seat instructions and session-start checklist |
| `IDENTITY.md`, `SOUL.md`, `GUARDRAILS.md`, `HEARTBEAT.md`, `TOOLS.md`, `USER.md`, `SYSTEM.md` | Bootstrap files the seat reads on boot |
| `config.json` | Runtime, model, session length, crash budget, timezone, seed crons |
| `.env` | `BOT_TOKEN`, `CHAT_ID`, `ALLOWED_USER`. Mode `600`. Never commit it |
| `goals.json`, `GOALS.md`, `MEMORY.md`, `memory/` | Goals and memory |
| `.claude/settings.json`, `.claude/hooks/`, `.claude/skills/` | Hooks and skills for this seat |

**Runtime state** (what the seat is doing), under `$CTX_ROOT` = `~/.cortextos/<instance>/`:

| Path | Contents |
|---|---|
| `config/enabled-agents.json` | Which seats the daemon starts |
| `daemon.sock`, `daemon.pid` | Daemon IPC socket and pid |
| `logs/<seat>/stdout.log` | The seat's session output. First place to look |
| `logs/<seat>/crashes.log`, `restarts.log` | Crash and restart history |
| `logs/<seat>/inbound-messages.jsonl`, `outbound-messages.jsonl` | Telegram traffic in and out |
| `state/<seat>/heartbeat.json` | Last heartbeat |
| `.cortextOS/state/agents/<seat>/crons.json`, `cron-execution.log` | Crons and their fire log |
| `inbox/<seat>/`, `inflight/<seat>/`, `processed/<seat>/` | Agent-to-agent message bus |
| `orgs/<org>/tasks/`, `approvals/`, `analytics/` | Tasks, approvals, events |

**Daemon logs**: `pm2 logs cortextos-daemon` (files in `~/.pm2/logs/`).

---

## Known limitations

- **One instance per command.** Commands default to the `default` instance. See [The --instance gotcha](#the---instance-gotcha).
- **`cortextos start` depends on the working directory.** It looks for `dist/daemon.js` under the current directory. Run it from `$CORTEX_HOME`.
- **Bus cron commands need `CTX_ROOT`.** Without it they read and write `crons.json` relative to the current directory and report an empty schedule.
- **New seats register as enabled.** `add-agent` marks a seat enabled before its `.env` exists. A daemon restart in that window starts the seat without Telegram.
- **One bot per seat.** Telegram allows one poller per bot token.
- **Hooks fail open.** A hook that crashes or exits with any code other than 2 does not block the tool call. Test every guard with a case it must block.
- **Heartbeats are self-reported.** Freshness, not status text, tells you a seat is alive.
- **Resource use scales with seats.** Each seat is a full Claude Code session with its own memory footprint and its own share of your Claude usage limits.

---

## Next

- [docs/01-core-architecture.md](docs/01-core-architecture.md): how the daemon, seats, bus and harness fit together.
- [docs/04-failsafe-boundary-log.md](docs/04-failsafe-boundary-log.md): the guards, gates and boundaries, and what each one stops.
- [docs/14-readme-quickstart.md](docs/14-readme-quickstart.md): install, run, change safely, ship.
- [docs/30-sre-runbooks.md](docs/30-sre-runbooks.md): what to do when a seat, the daemon or Telegram breaks.
- [docs/20-architecture-decision-records.md](docs/20-architecture-decision-records.md): why it is built this way.
- [harness/README.md](harness/README.md): every hook and skill in the harness layer.

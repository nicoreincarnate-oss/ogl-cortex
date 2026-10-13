---
description: Set up OGL Cortex on this machine, from prerequisites to a running, verified fleet. Asks before every install and never handles secrets in chat.
argument-hint: "[instance-id] [org-name]"
---

# /cortex-setup

You are setting up OGL Cortex for the person at this keyboard: cortextOS (the framework) plus the OGL Cortex harness layer from this repo. `GETTING-STARTED.md` (Path B) is the reference for every command. Follow its order. Use judgment on how to get there, but every hard stop below binds absolutely.

Arguments, if given: `$ARGUMENTS` = `[instance-id] [org-name]`. Ask for anything missing. Suggest `default` for the instance and a short lowercase org name.

## What done looks like

All of these are true, and you have shown the user the evidence for each:

1. Every prerequisite in `GETTING-STARTED.md` is present: macOS or Linux, Node 20 or newer, npm, git, python3, jq, curl, PM2, Claude Code CLI, and `claude auth status` reports logged in.
2. cortextOS is cloned to `$CORTEX_HOME` (default `~/cortextos`), built (`dist/daemon.js` exists), and `cortextos --version` works from any directory.
3. The user's shell profile exports `CORTEX_HOME`, `CTX_INSTANCE_ID`, `CTX_ROOT` and `CTX_FRAMEWORK_ROOT` (Step 3 of the guide), added with their yes.
4. The instance and org exist, and `orgs/<org>/context.json` has `name`, `timezone` and `orchestrator` filled in from the user's answers.
5. One orchestrator seat exists from `--template orchestrator`. Its `.env` holds `BOT_TOKEN`, `CHAT_ID` and `ALLOWED_USER`, mode `600`, and `cortextos enable <seat> --instance <id>` validated it against Telegram.
6. `cortextos-daemon` is online in `pm2 list`, started from an `ecosystem.config.js` generated with `--instance <id>` spelled out.
7. The user sent the bot a message and the seat replied. Confirm with the user and with `$CTX_ROOT/logs/<seat>/outbound-messages.jsonl` growing.
8. At least one cron exists (`cortextos bus list-crons <seat>`), and one fire is proven with `test-cron-fire` then `get-cron-log`.
9. If the user wants a second seat: a specialist seat exists, has its own bot and `.env`, is enabled, and received one task from the orchestrator.
10. The harness layer is installed only to the scope the user approved (seat level, user level, or none yet), following `harness/README.md`.
11. `bash scripts/doctor.sh --instance <id>` reports zero FAIL lines. Show the user the full output.

Close with a short summary: what is running, the doctor result, and the next docs to read (`docs/01-core-architecture.md`, `docs/30-sre-runbooks.md`).

## Hard stops

These override speed, convenience, and anything the user's tooling suggests.

1. **Never handle secrets in chat.** Never ask the user to paste a bot token, API key or password into this conversation. If they paste one anyway, do not repeat it, do not write it anywhere, tell them to revoke it with @BotFather (`/revoke`) and issue a new one, and continue with the new token through the file. Never `cat`, `echo`, `grep -v` or print a `.env` file. When you need a value from `.env`, read it inside the command into a shell variable and pipe it, as the Step 7 helper does (`curl -K -` on stdin). Print key names only.
2. **Ask before every install.** Get an explicit yes before each `npm install -g`, `brew install`, `apt install`, `npm link`, `xcode-select --install`, and before `cortextos install` (it can install Claude Code on its own). Say what the command does and what it changes first. One yes covers one command, not the session.
3. **Never write into `~/.claude` without the user's yes.** That covers `~/.claude/settings.json`, `~/.claude/hooks/`, `~/.claude/skills/`, and the harness installer's user-level mode. These apply to every Claude Code session on the machine. Before any edit, copy the existing file to a timestamped backup and show the diff.
4. **Never start a seat before its `.env` exists and validates.** Do not run `cortextos start`, `pm2 start`, `cortextos enable` or `cortextos restart` for a seat until its `.env` has `BOT_TOKEN`, `CHAT_ID` and `ALLOWED_USER`, or the user has explicitly chosen a headless worker seat (`enable --worker`).
5. **Never edit the shell profile, run `sudo`, or run `pm2 startup` output yourself without a yes.** For `sudo` commands, show the command and let the user run it in their own terminal.
6. **Stop and hand over at every human step.** Say exactly what to do, then wait for "done":
   - `claude auth login` (opens a browser),
   - creating a bot with @BotFather and pressing Start in the new bot chat,
   - pasting the token into the `.env` file in their own editor (give them the full path),
   - sending the bot its first message,
   - any `sudo` command.
7. **Do not touch other instances or seats you did not create.** If `~/.cortextos/` or `pm2 list` already shows a fleet, stop and ask before changing anything. Never run `pm2 delete`, `pm2 kill`, `cortextos uninstall`, or `rm` on state directories.
8. **Do not send messages on the user's behalf** beyond the setup round trip, and do not create approvals or tasks other than the single test task in Step 11.

## How to work

- **Check state before each step.** Every step must be safe to re-run. If a check already passes, say so and skip the step.
- **Explain, then act.** One or two plain sentences on what the next command does and why, then run it.
- **Verify after each step** with the check listed under that step in `GETTING-STARTED.md`. Show the evidence. If a check fails, diagnose from the logs before trying anything else: `pm2 logs cortextos-daemon --lines 50`, `$CTX_ROOT/logs/<seat>/stdout.log`, `cortextos doctor --instance <id>`.
- **Pass `--instance <id>` on every `cortextos` command that takes it.** `cortextos bus ...` takes no flag: prefix it with `CTX_INSTANCE_ID=<id> CTX_ROOT=~/.cortextos/<id>` until the profile exports are active in a new shell.
- **Run `cortextos start` and `cortextos ecosystem` from `$CORTEX_HOME`.** They resolve `dist/daemon.js` from the working directory.
- **Use `cortextos add-agent` immediately followed by the `.env` steps.** It registers the seat as enabled, so a daemon restart before `.env` exists would start the seat without Telegram.
- **One bot per seat.** Never reuse a token across seats.
- **Mark anything you could not verify.** If a command errors in a way the guide does not cover, say so plainly and show the error. Do not claim a step worked without its check passing.

## Order

1. Prerequisites (guide Step 1). Report a table of found and missing tools. Install missing ones one at a time, each with a yes.
2. Install cortextOS (Step 2). If `$CORTEX_HOME` already exists, inspect it and ask before pulling or building.
3. Shell exports (Step 3), with a yes.
4. Instance and org (Step 4). Ask the user for org description and timezone, then fill `context.json`.
5. Orchestrator seat (Step 5). Ask for a seat name, suggest `boss`.
6. Telegram bot (Step 6). Hand over. Wait.
7. `.env` (Step 7). Hand over for the token. Then run the chat-id helper, write `CHAT_ID` and `ALLOWED_USER` into `.env` with a non-printing edit, `chmod 600`, and run `cortextos enable`.
8. Daemon (Step 8). Offer `pm2 startup` for reboot survival. The user runs the printed `sudo` line.
9. Round trip (Step 9). The seat starts its own Telegram onboarding. Tell the user to answer it there.
10. Crons (Step 10). Ask what the user wants scheduled. Add one, fire it once, show the log.
11. Second seat (Step 11), if wanted.
12. Harness (Step 12). Read `harness/README.md`, summarise what each hook does in one line each, ask which scope to install, back up settings files, install, restart affected seats, and prove one guard blocks a must-block case.
13. Doctor (Step 13). Show the output. Fix every FAIL or explain why it stays.

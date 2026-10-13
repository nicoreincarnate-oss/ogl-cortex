# Security

OGL Cortex runs Claude Code agents on your machine, as your user, with access to your files, your shell and whatever accounts you connect. This page covers how to report a problem, what the guards protect and what they do not, and the hardening steps to take before you connect real accounts.

The full threat model is in [docs/32-security-red-team-log.md](docs/32-security-red-team-log.md).

## Reporting a vulnerability

Report security problems privately. Do not open a public issue, and do not post details in discussions or pull requests.

1. Use GitHub's private vulnerability reporting on this repository: the **Security** tab, then **Report a vulnerability**.
2. Include the affected file and version (commit hash), what an attacker can do, and the smallest reproduction you have. For a hook bypass, the hook input JSON and the exit code you got are enough.
3. Leave out real secrets, tokens, chat IDs and personal data. Use placeholders.

You get an acknowledgement, then a fix or a documented decision. Fixes to a guard land with a test that fails without the fix.

Problems in cortextOS itself belong upstream at [grandamenium/cortextos](https://github.com/grandamenium/cortextos). Problems in Claude Code belong with Anthropic.

## What the guards cover

The harness hooks run before tool calls. A hook blocks a call only when it exits `2`; the tests in `harness/tests/` check that every must-block case does. Details and settings: [harness/README.md](harness/README.md).

| Guard | Protects against | Fails |
|---|---|---|
| `ship_gate.py` | pushing, publishing or deploying (`git push`, `vercel --prod`, `npm publish`, `wrangler deploy`, `rsync` to a host and more) without a passing security report at `security/pentest-gate-report.json` | closed: a ship-looking command is blocked if the hook errors |
| `shared_surface_guard.py` | one seat changing what every seat shares: `~/.claude`, the uv cache, global npm packages, `brew upgrade`, plus roots you add | closed when the input names a guarded surface, open otherwise |
| `orwell_lint.py` | outgoing human-facing text that breaks the writing rules | closed when the input looks like a send, open otherwise |
| `brief_guard.py` | dispatching work to another seat without a TASK, FILES, BAR, RETURN brief | closed when the input looks like a dispatch |
| `future_time_guard.py` | memory, `STATE.md` or sends stamped with a time that has not happened yet | open |

Approval gates (`cortextos bus create-approval`) hold external and irreversible actions for a human. They are a rule the seat follows, backed by its `CLAUDE.md` and skills, not a hook.

## What the guards do not cover

- **No sandbox.** Seats run as your user. Anything your user can do, a seat can attempt. Hooks are a fence on known paths, not a wall.
- **Command text only.** The ship gate and shared-surface guard read the command string. A deploy hidden inside a script (`./deploy.sh`) passes unless you add it to `OGL_SHIP_EXTRA_PATTERNS`. A path built at run time is not seen.
- **Per-project hooks.** Seat-level hooks run only in sessions started in that seat's folder. A Claude Code session started elsewhere runs only the user-level hooks in `~/.claude/settings.json`. Install the machine-wide guards with `harness/install.sh <seat> --apply --user-level` if you want them everywhere.
- **Pass tokens are files.** The one-time release tokens under `~/.ogl-cortex/state/` can be created by any process running as your user.
- **Prompt injection.** Text a seat reads (web pages, emails, files from others) can carry instructions. The guards catch some resulting actions, not the injection.
- **Secrets in chat.** No hook stops a person pasting a key into Telegram.

## Hardening checklist

Do these before you connect real accounts.

- [ ] **Encrypt the disk.** FileVault on macOS, LUKS on Linux. Seat folders hold tokens, logs and memory in plain files.
- [ ] **Back up.** Put seat folders, `~/.claude` (hooks, settings, memory) and `~/.cortextos/<instance>/` under a backup you have restored from at least once. A git remote for each seat repo also counts, once secrets are out of it.
- [ ] **Keep secrets out of chat.** Never paste a token, key or password into Telegram or a Claude Code prompt. Put it in the seat's `.env` with mode `600`. `/cortex-setup` never asks for one.
- [ ] **Keep secrets out of git.** `.env`, `.secrets/` and key files go in `.gitignore` before the first commit. Check with `git ls-files | grep -iE 'env|secret|key'`. If a secret was ever committed, untracking it is not enough: it is still in history.
- [ ] **Rotate any key that was pasted or committed.** Revoke it in the vendor's dashboard, issue a new one, update every consumer, then prove the old one fails. For a Telegram bot token, use `/revoke` in @BotFather. Steps: [TROUBLESHOOTING.md](TROUBLESHOOTING.md#15-a-secret-was-pasted-into-chat-or-committed-to-git).
- [ ] **Run the ship gate before every deploy.** Install `ship_gate.py`, point `OGL_PENTEST_GATE_CMD` at your scanner, and add your own deploy scripts to `OGL_SHIP_EXTRA_PATTERNS`. Check it fires: `echo '{"tool_name":"Bash","tool_input":{"command":"npx vercel --prod"},"cwd":"/tmp"}' | python3 harness/hooks/ship_gate.py; echo "exit $?"` must print `exit 2`.
- [ ] **Lock Telegram to you.** Every seat's `.env` sets `ALLOWED_USER` to your Telegram user ID. The daemon ignores everyone else.
- [ ] **Run the tests and the doctor.** `python3 harness/tests/run_all.py` must end in `ALL PASS`; `bash scripts/doctor.sh --instance <instance>` must show zero `FAIL` lines.
- [ ] **Use a dedicated user account** for the fleet if the machine is shared, so a seat cannot read another person's files.

More steps for a new install: [docs/32 section 6](docs/32-security-red-team-log.md#6-hardening-checklist-for-a-new-install).

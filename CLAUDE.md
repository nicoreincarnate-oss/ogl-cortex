# OGL Cortex: instructions for Claude in this repo

OGL Cortex documents and installs an agent system: the framework (daemon, bus and CLI; MIT, upstream `github.com/grandamenium/cortextos`) plus the harness layer (hooks, skills, seat templates, tools, doctor). This repo holds docs and harness files. It does not vendor the framework.

## Layout

- `GETTING-STARTED.md`: setup guide. Path A is `/cortex-setup`, Path B is manual.
- `.claude/commands/cortex-setup.md`: the guided setup command.
- `docs/`: numbered product docs (`01-...` architecture onward).
- `harness/`: hooks, skills, templates, config, tests, and `install.sh` with its `README.md`.
- `scripts/doctor.sh`: read-only health check. `bash scripts/doctor.sh --instance <id>`.

## Rules

1. **Secrets never enter chat or files in this repo.** Do not print `.env` values, tokens, chat ids, user ids, emails or account ids. Read key names only. No real values in examples: use `<token from BotFather>` style placeholders.
2. **Public-safe writing.** Docs describe the product for a stranger on their own machine. No references to any particular install, person, client, machine or incident. Paths are install-relative: `$CORTEX_HOME`, `$CTX_ROOT`, `<instance>`, `<org>`, `<seat>`, `~`. Example seats use neutral role names (orchestrator, specialist, auditor, sentinel; e.g. `boss`, `builder`).
3. **Every documented command must exist.** Check it with `cortextos <cmd> --help` or `cortextos bus <cmd> --help`, or read the framework source (`src/cli/`). Mark anything you could not check as unverified.
4. **Ask before installing anything or writing to `~/.claude`.** Back up any `settings.json` before editing it.
5. **`scripts/doctor.sh` stays read-only.** No writes, no restarts, no sends, no values printed. Run `bash -n scripts/doctor.sh` after editing, then run it and grep its output for token-shaped strings.
6. **Hooks block only on exit code 2.** Any harness hook change ships with a test that feeds a must-block case and a must-allow case.
7. **Style.** Plain English, short sentences, active voice, present tense. No em dashes. Real commands, real file paths, real JSON shapes.
8. **No pushes or remote writes** (`git push`, `gh repo create`, publishing) without the user's explicit yes.

## Useful checks

```bash
bash scripts/doctor.sh --instance "${CTX_INSTANCE_ID:-default}"
cortextos --help
cortextos bus --help
grep -rn $'\u2014' --include=*.md .   # em dash check
```

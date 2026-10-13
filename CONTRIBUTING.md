# Contributing to OGL Cortex

Thanks for helping. This repo holds the OGL Cortex harness (hooks, skills, seat templates, installer), the doctor script and the documentation. cortextOS itself lives upstream at [grandamenium/cortextos](https://github.com/grandamenium/cortextos); framework changes go there.

## Layout

| Path | What it holds |
|---|---|
| `harness/hooks/` | guard hooks (Python, standard library only) |
| `harness/tests/` | hook tests; `run_all.py` runs them all |
| `harness/skills/`, `harness/templates/` | operating skills and seat templates |
| `harness/install.sh` | installer, dry run by default |
| `scripts/doctor.sh` | read-only health check |
| `scripts/build-docs-site.py` | builds the HTML edition of `docs/` into `docs/site/` |
| `docs/` | numbered product docs |
| `.claude/commands/cortex-setup.md` | the guided setup command |
| `docs/assets/readme/` | README hero and icons; `src/render.py` rebuilds the hero |

## Branches

- `main` is what users install. Do not commit to it directly.
- Branch from `main` with a prefix that says what the change is: `fix/<topic>`, `feat/<topic>`, `docs/<topic>`, `hook/<hook-name>`.
- One topic per branch. A hook change and an unrelated doc fix go in two pull requests.
- Rebase on `main` before you open the pull request.

## Tests

Run all of these before you push.

```bash
# every hook: must-block cases exit 2, must-allow cases exit 0
python3 harness/tests/run_all.py

# built-in self-tests
python3 harness/hooks/shared_surface_guard.py --selftest
python3 harness/hooks/orwell_lint.py --selftest
python3 harness/hooks/future_time_guard.py --selftest
python3 harness/hooks/ship_gate.py --selftest

# installer: dry run against a scratch seat writes nothing
mkdir -p /tmp/seat-test && harness/install.sh /tmp/seat-test

# doctor: syntax, then a real run on your install
bash -n scripts/doctor.sh
bash scripts/doctor.sh --instance <instance>
```

`run_all.py` must end in `ALL PASS`. The doctor must show zero `FAIL` lines on a working install.

### Rules for hook changes

- A hook blocks only by exiting `2`. Any other non-zero exit lets the call through. Every blocking path exits `2`.
- Every change ships with at least one must-block case and one must-allow case in `harness/tests/`. A fix comes with a test that fails without the fix: run it against the old code once and see it fail.
- Decide how the hook fails. Guards that protect shipping or shared state fail closed on inputs in their scope; tripwires fail open. Say which in `harness/README.md`.
- Standard library only. No network calls from a hook.
- Update the hook's section in `harness/README.md`, including any new environment variable.

### Rules for `scripts/doctor.sh`

It stays read-only: no writes, no restarts, no sends. It prints `.env` key names, never values. After a change, run it and search the output for anything that looks like a token.

## Writing docs

Docs describe the product for a stranger installing it on their own machine.

- Present tense. Say what the system does and how to configure it.
- Install-relative paths: `$CORTEX_HOME`, `$CTX_ROOT`, `<instance>`, `<org>`, `<seat>`, `~`. No real home-directory paths.
- Example seats use role names: orchestrator, specialist, auditor, sentinel (for example `boss`, `builder`).
- No references to a particular install, person, machine, client or incident. Limitations go in a "Known limitations" section, written as properties of the software.
- Every command you document must exist. Check it with `cortextos <cmd> --help`, `cortextos bus <cmd> --help` or the source, and mark anything you could not check.
- Short sentences, active voice, no em dashes.
- After editing `docs/`, rebuild the HTML edition with `python3 scripts/build-docs-site.py` (needs `pandoc`; `mmdc` renders the diagrams).

## No secrets

- Never commit a token, key, password, chat ID, user ID, email address or account ID, even in an example. Use placeholders such as `<token from BotFather>`.
- Never paste test output that contains a secret into an issue or pull request.
- Before you push, check the diff: `git diff main --stat` and `git diff main | grep -nE '[0-9]{8,}:[A-Za-z0-9_-]{30,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}'` should print nothing.
- If you committed a secret, do not push. Rotate it first, then rewrite the branch history. See [SECURITY.md](SECURITY.md).

## Pull request checklist

Copy this into the pull request description.

```markdown
- [ ] One topic, branched from current `main`
- [ ] `python3 harness/tests/run_all.py` ends in ALL PASS
- [ ] Hook change: new must-block and must-allow cases; the new test failed before the fix
- [ ] Hook change: blocking paths exit 2; fail mode stated in harness/README.md
- [ ] `bash -n scripts/doctor.sh` passes; doctor output shows no secret values
- [ ] Every new or changed command checked with --help or the source
- [ ] Docs: present tense, install-relative paths, no em dashes; HTML edition rebuilt
- [ ] No secrets, IDs, emails or home-directory paths in the diff
```

## Security issues

Do not open a public issue for a vulnerability. Follow [SECURITY.md](SECURITY.md).

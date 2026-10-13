# Vendored framework: cortextOS

This folder holds a copy of cortextOS, the daemon, bus, Telegram bridge,
dashboard and agent templates that OGL Cortex runs on. It is vendored so that
one clone of this repository gives you a known, tested framework version.

| Field | Value |
|---|---|
| Upstream | https://github.com/grandamenium/cortextos |
| Licence | MIT, Copyright (c) 2026 Cortext LLC (see `LICENSE` in this folder) |
| Base commit of this copy | `5f2d487375d14f2136548d75d4349ec25a13bd73` |
| Upstream merge base | `5a0882d055dd0279629e46aa8130018801241140` |
| Package version | `cortextos` 0.1.1 (`package.json`) |

## What this copy contains

The copy is `git archive` of the base commit above: tracked files only. It
never contains:

- `orgs/` (your organisations, seats, memory and state live there at runtime)
- `.env` files or any other secret (only `*.env.example` templates)
- `node_modules/` and `dist/` (you build them; see below)

## OGL patches on top of upstream

The base commit is upstream cortextOS plus these OGL changes. They are generic
and do not depend on any one install.

1. **Delivery harness (shadow mode).** `src/harness/`, `src/cli/harness.ts`,
   `src/cli/roster.ts`, `config/harness/`, `migrations/harness/`. A shadow task
   store, scheduler, staged pipeline with an Align stage and a human sign-off
   gate, and roster validate/provision commands. It is off by default and the
   generated schema in `migrations/harness/0021_v21.sql` is never installed by
   the shadow store.
2. **Daemon hardening.** A singleton lock for the daemon and stricter IPC.
3. **Telegram.** Document attachments are always delivered, never dropped.
4. **Auto-commit scope.** Auto-commit stages the seat directory, not the
   project root.
5. **Codex sandbox.** Codex PTY seats run `workspace-write` instead of
   `danger-full-access`.
6. **Knowledge base.** Embedding calls are paced under the free-tier rate, and
   per-minute and per-day `429` responses are handled differently.
7. **Guardrails.** Every seat template carries a memory-injection row: content
   that asks the seat to edit its own memory or identity files is refused.
8. **CI.** The leak-guard workflow reads `github.base_ref` through an
   environment variable (closes a template-injection path).

### Publication scrub (applied when this copy was made)

These edits remove install-specific values. Behaviour is unchanged except
where noted.

| File | Change |
|---|---|
| `migrations/harness/0021_v21.sql` | The home-path guard in five CHECK/trigger clauses now refuses any `/Users/` path instead of one user's home. Byte count and SHA-256 updated in `0021_v21.manifest.json`, `config/harness/implementation-status.v21.json` and `tests/unit/harness/migration.test.ts`. |
| `migrations/harness/0021_v21.manifest.json`, `config/harness/implementation-status.v21.json` | Local path of the planning document replaced with a neutral label. |
| `src/harness/scheduler.ts`, `tests/integration/harness-shadow.test.ts` | Align sign-off requests are assigned to `operator`. |
| `config/harness/f0-operator-prompt.md`, `src/cli/roster.ts`, `templates/*/GUARDRAILS.md` | Personal names replaced with "operator". |
| `tests/unit/harness/roster.test.ts` | Two legacy host names replaced with neutral placeholders. |
| `src/bus/system.ts`, `src/bus/catalog.ts`, `.github/scripts/leak-guard.sh`, `community/agents/security/TOOLS.md` | Secret-prefix patterns written as equivalent character classes (for example `gh[p]_`), so the source does not match its own secret scanners. Matching is unchanged. |
| `skills/mcp-integration/SKILL.md` | Token placeholder is `<your-github-token>`. |

## Build

```bash
cd framework
npm ci
npm run build        # writes dist/cli.js, dist/daemon.js, dist/hooks/
npm link             # optional: puts `cortextos` on your PATH
```

`scripts/install.sh` at the repository root runs these steps for you (dry run
by default).

## Update from upstream

1. Fetch upstream into a scratch clone, not into this folder:
   ```bash
   git clone https://github.com/grandamenium/cortextos /tmp/cortextos-up
   cd /tmp/cortextos-up
   git log --oneline 5a0882d..origin/main   # what changed upstream
   ```
2. Re-apply the OGL patches listed above on top of the new upstream commit.
   Drop any patch that upstream has merged.
3. Replace the contents of `framework/` with `git archive <new-commit>` output,
   leaving out `orgs/`, `.env`, `node_modules/` and `dist/`.
4. Re-apply the publication scrub and run the leak check from the repository
   root. Add your own user name, email domain, chat IDs and client names to
   the pattern. It must print nothing:
   ```bash
   grep -rn -I -E "sk-an[t]-|gh[p]_|AKI[A]|bot[0-9]{8,}:|<your-user-name>" framework/
   ```
5. Build and test (`npm ci && npm run build && npm test`), then update the
   commit fields in the table at the top of this file.
6. Stage with `git add -f framework`. The framework's own `.gitignore` (kept
   so that `orgs/`, `.env`, `dist/` and `node_modules/` inside `framework/`
   stay out of git) also matches some tracked upstream files, such as
   `docs/`, `AGENTS.md` and `.claude/commands/`. Plain `git add` skips them.
   Run `git status --ignored framework` and check that only `orgs/`,
   `node_modules/` and `dist/` remain ignored.
7. Run the pentest gate on the repository before you push
   (`python3 harness/security/cortex_pentest_gate.py . --output security`).

## Known limitations

- `npm test` inside `framework/` runs the dashboard suites too. They need the
  dashboard dependencies (`cd dashboard && npm ci`); without them those suites
  fail to load.
- Some integration tests run only when `dist/cli.js` exists, so results differ
  before and after `npm run build`.
- `tests/unit/cli/roster.test.ts` expects an older effort tier for one roster
  seat and fails against the shipped roster. It covers the optional delivery
  harness only.

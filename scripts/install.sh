#!/usr/bin/env bash
# OGL Cortex installer: one command from a fresh clone to a built framework and an instance.
#
# Dry run by default: it checks prerequisites, then prints every step and the
# command it would run. Nothing is written until you pass --apply.
# With --apply it asks before every step that writes outside this repository.
# It never reads, asks for or writes a secret (bot tokens, API keys, .env values).
#
# Usage:
#   bash scripts/install.sh [--instance <id>] [--org <name>] [--apply]
#
# Options:
#   --instance <id>   instance id; state lives in ~/.cortextos/<id> (default: $CTX_INSTANCE_ID, else "default")
#   --org <name>      also create this organization (lowercase letters, digits, - and _)
#   --apply           run the steps (still asks before each write outside the repo)
#   -h, --help        show this help
#
# Steps:
#   1. prerequisites   read-only, reuses scripts/doctor.sh
#   2. build           npm ci && npm run build inside framework/ (writes inside the repo)
#   3. link            npm link, puts `cortextos` on your PATH (asks: writes to the global npm prefix)
#   4. install         cortextos install --instance <id> (asks: writes ~/.cortextos/<id>; may install
#                      missing tools such as pm2, jq, ffmpeg, whisper-cpp and a speech model)
#   5. init            cortextos init <org> --instance <id> (asks: writes ~/.cortextos/<id>/orgs/<org>;
#                      the org folder goes in framework/orgs/, which git ignores)
#   6. next steps      printed only: shell exports, seat creation, .env, harness, doctor
#
# Exit code: 0 done (or dry run complete), 1 a step failed or a prerequisite is missing, 2 bad usage.

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRAMEWORK="$REPO/framework"
INSTANCE="${CTX_INSTANCE_ID:-default}"
ORG=""
APPLY=0

usage() { sed -n '2,29p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --instance) [ $# -ge 2 ] || { usage >&2; exit 2; }; INSTANCE="$2"; shift 2 ;;
    --instance=*) INSTANCE="${1#*=}"; shift ;;
    --org) [ $# -ge 2 ] || { usage >&2; exit 2; }; ORG="$2"; shift 2 ;;
    --org=*) ORG="${1#*=}"; shift ;;
    --apply) APPLY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$INSTANCE" in *[!a-zA-Z0-9_-]*|"") echo "invalid instance id: $INSTANCE" >&2; exit 2 ;; esac
if [ -n "$ORG" ]; then
  case "$ORG" in *[!a-z0-9_-]*) echo "invalid org name: $ORG (use lowercase letters, digits, - and _)" >&2; exit 2 ;; esac
fi

tidy() { printf '%s' "${1/#$HOME/~}"; }
# Same path, written so it still expands inside double quotes in a shell profile.
homevar() { printf '%s' "${1/#$HOME/\$HOME}"; }
step() { printf '\n== %s\n' "$*"; }
say() { printf '   %s\n' "$*"; }

# ask "<question>": yes only on an explicit y/yes typed at a terminal. No terminal means no.
ask() {
  local reply=""
  if [ ! -r /dev/tty ]; then say "no terminal to ask on; skipping"; return 1; fi
  printf '   %s [y/N] ' "$1" > /dev/tty
  read -r reply < /dev/tty || return 1
  case "$reply" in y|Y|yes|YES) return 0 ;; *) say "skipped"; return 1 ;; esac
}

# run <writes-outside-repo: 0|1> <description> <command...>   (runs inside framework/)
FAILED=0
run() {
  local outside="$1" desc="$2"; shift 2
  say "$desc"
  say "\$ (cd $(tidy "$FRAMEWORK") && $*)"
  if [ "$APPLY" -eq 0 ]; then
    if [ "$outside" -eq 1 ]; then say "(dry run; --apply will ask first)"; else say "(dry run)"; fi
    return 0
  fi
  if [ "$outside" -eq 1 ] && ! ask "Run this step? It writes outside the repository."; then
    return 2
  fi
  (cd "$FRAMEWORK" && "$@")
  local rc=$?
  if [ $rc -ne 0 ]; then say "FAILED (exit $rc)"; FAILED=1; fi
  return $rc
}

printf 'OGL Cortex installer: %s\n' "$([ "$APPLY" -eq 1 ] && echo "APPLY (asks before writing outside the repo)" || echo "DRY RUN (nothing is written; add --apply)")"
printf 'repo:      %s\n' "$(tidy "$REPO")"
printf 'framework: %s\n' "$(tidy "$FRAMEWORK")"
printf 'instance:  %s (state: %s)\n' "$INSTANCE" "$(tidy "$HOME/.cortextos/$INSTANCE")"
printf 'org:       %s\n' "${ORG:-(none; pass --org <name> to create one)}"

if [ ! -f "$FRAMEWORK/package.json" ]; then
  echo "framework/ not found in this checkout; clone the full repository" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
step "1. Prerequisites (read-only, from scripts/doctor.sh)"
DOCTOR_OUT="$(bash "$REPO/scripts/doctor.sh" --instance "$INSTANCE" --framework "$FRAMEWORK" --offline 2>&1)"
PREREQ="$(printf '%s\n' "$DOCTOR_OUT" | awk '/^== Prerequisites/{on=1; next} /^== /{on=0} on')"
DISK="$(printf '%s\n' "$DOCTOR_OUT" | grep -E '^(PASS|WARN|FAIL) +disk free' || true)"
printf '%s\n' "$PREREQ" | grep -vE 'framework (built|at)|framework dir' | sed 's/^/   /'
[ -n "$DISK" ] && say "$DISK"

MISSING=0
for need in "node " "npm:" "git:" "python3:"; do
  if ! printf '%s\n' "$PREREQ" | grep -qE "^PASS +$need"; then
    say "BLOCKER: ${need%[: ]} is missing or too old. Install it, then re-run."
    MISSING=1
  fi
done
case "$DISK" in FAIL*) say "BLOCKER: not enough free disk for the build and the seats."; MISSING=1 ;; esac
if ! printf '%s\n' "$PREREQ" | grep -qE "^PASS +pm2:"; then
  say "NOTE: pm2 is missing. Step 4 offers to install it (npm install -g pm2)."
fi
if ! printf '%s\n' "$PREREQ" | grep -qE "^PASS +claude auth:"; then
  say "NOTE: Claude Code is missing or logged out. Install it and log in yourself before step 4:"
  say "      npm install -g @anthropic-ai/claude-code && claude auth login"
fi
if [ "$MISSING" -eq 1 ]; then
  echo
  echo "Stopped: fix the BLOCKER lines above, then run this again."
  exit 1
fi

# ---------------------------------------------------------------------------
step "2. Build the framework (writes framework/node_modules and framework/dist inside the repo)"
if [ -f "$FRAMEWORK/dist/cli.js" ] && [ -f "$FRAMEWORK/dist/daemon.js" ]; then
  say "already built: $(tidy "$FRAMEWORK")/dist/cli.js. Re-running keeps it current."
fi
run 0 "install exact dependency versions from package-lock.json" npm ci --no-audit --no-fund \
  && run 0 "compile TypeScript to dist/" npm run build
if [ "$APPLY" -eq 1 ] && [ ! -f "$FRAMEWORK/dist/cli.js" ]; then
  echo "Stopped: the build did not produce dist/cli.js." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
step "3. Put the cortextos command on your PATH"
if command -v cortextos >/dev/null 2>&1; then
  say "cortextos is already on PATH at $(tidy "$(command -v cortextos)")."
  say "If that is a different checkout, run this step to point it at this framework/."
fi
run 1 "npm link creates a global 'cortextos' symlink to $(tidy "$FRAMEWORK")" npm link

# ---------------------------------------------------------------------------
step "4. Create the instance state directory"
if [ -d "$HOME/.cortextos/$INSTANCE" ]; then
  say "$(tidy "$HOME/.cortextos/$INSTANCE") exists. install only adds what is missing."
fi
say "This also checks node-pty, pm2, jq, ffmpeg and whisper-cpp, and may install missing ones"
say "(npm install -g, brew or apt-get) and download a speech model."
run 1 "cortextos install" node dist/cli.js install --instance "$INSTANCE"

# ---------------------------------------------------------------------------
step "5. Create the organization"
if [ -z "$ORG" ]; then
  say "skipped: no --org given. Later: cd $(tidy "$FRAMEWORK") && cortextos init <org> --instance $INSTANCE"
else
  run 1 "cortextos init $ORG (org folder: framework/orgs/$ORG, git-ignored)" \
    node dist/cli.js init "$ORG" --instance "$INSTANCE"
fi

# ---------------------------------------------------------------------------
step "6. Next steps (printed only; this script does not run them)"
O="${ORG:-<org>}"
cat <<EOF
   a. Add to your shell profile (~/.zshrc or ~/.bashrc), then open a new terminal:
        export CORTEX_HOME="$(homevar "$FRAMEWORK")"
        export CTX_INSTANCE_ID="$INSTANCE"
        export CTX_ROOT="\$HOME/.cortextos/$INSTANCE"
        export CTX_FRAMEWORK_ROOT="\$CORTEX_HOME"
   b. Set name, timezone and orchestrator in framework/orgs/$O/context.json.
   c. Create the orchestrator seat:
        cd "\$CORTEX_HOME" && cortextos add-agent <seat> --template orchestrator --org $O --instance $INSTANCE
   d. Create a Telegram bot with @BotFather and type its token and your chat id into
      framework/orgs/$O/agents/<seat>/.env yourself (chmod 600). This script never handles them.
   e. Install the harness layer into the seat (dry run first):
        bash harness/install.sh "\$CORTEX_HOME/orgs/$O/agents/<seat>"
   f. Start and verify:
        cortextos enable <seat> --org $O --instance $INSTANCE
        bash scripts/doctor.sh --instance $INSTANCE --framework "\$CORTEX_HOME"
   g. Before any push or deploy, run the pentest gate from the project root:
        python3 "$(homevar "$REPO")/harness/security/cortex_pentest_gate.py" . --output security
EOF

echo
if [ "$APPLY" -eq 0 ]; then
  echo "Dry run complete. Nothing was written. Re-run with --apply to perform steps 2 to 5."
  exit 0
fi
if [ "$FAILED" -eq 1 ]; then
  echo "Finished with a failed step. Read the FAILED lines above."
  exit 1
fi
echo "Install steps finished. Work through the next steps, then run the doctor."
exit 0

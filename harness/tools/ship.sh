#!/usr/bin/env bash
# ship.sh: the deploy chain as one command. Pentest gate -> deploy -> live re-check. It stops on any non-pass.
#
# Usage:
#   ship.sh <dir> <prod-url> --gate-cmd "<cmd>" [--deploy-cmd "<cmd>"] [--promote-cmd "<cmd>"] [--remove-cmd "<cmd>"]
#
# <dir>       the project to ship; every command runs inside it
# <prod-url>  the production URL (http or https), checked after the deploy
#
# --gate-cmd     your pentest gate. Runs as: bash -c "<cmd>" _ "<url>", so "$1" is the URL to scan ("" for the
#                static pre-deploy run). It must write security/pentest-gate-report.json in <dir> with
#                "status": "pass". Example:
#                  --gate-cmd 'python3 /opt/gate/pentest_gate.py . --output security ${1:+--url "$1"}'
# --deploy-cmd   default: vercel deploy --prod --yes
# --promote-cmd  turns on preview-then-promote. The deploy command must then print the candidate URL (JSON
#                with deployment.url, or a bare https:// line). The candidate is checked for HTTP 200 (no
#                redirects followed) and gated with its URL. Only on pass does the promote command run, with the
#                candidate URL appended. Example for Vercel:
#                  --deploy-cmd 'vercel deploy --prod --skip-domain --yes --format json' --promote-cmd 'vercel promote --yes'
# --remove-cmd   with --promote-cmd: run with the candidate URL appended when the candidate fails
#
# Each option also reads an environment variable: OGL_SHIP_GATE_CMD, OGL_SHIP_DEPLOY_CMD, OGL_SHIP_PROMOTE_CMD,
# OGL_SHIP_REMOVE_CMD. The command line wins.
#
# A gate step passes only if the report exists, was written during that step, and says "pass". Before each gate
# run the previous report is moved to security/pentest-gate-report.json.prev, so an old verdict is never reused.
#
# Exit codes:
#   0  shipped: gate passed, deploy succeeded, prod answers 200 and the live gate passed
#   2  usage error
#   3  pre-deploy gate did not pass; nothing was deployed
#   4  deploy command failed (or, with --promote-cmd, printed no candidate URL); prod untouched
#   5  LIVE AND WRONG: the deploy went out but prod is not 200 or the live gate failed. Check or roll back now.
#      A ship_postgate_failed warning event is logged when the cortextos CLI is available.
#   6  (promote mode) the candidate was not 200 or failed its gate; prod untouched; candidate removed if
#      --remove-cmd is set
#   7  (promote mode) the promote command failed; prod still serves the old deployment; safe to retry
#
# Test seams: OGL_SHIP_HTTP (a command printing the HTTP status for "<url> [-L]"), OGL_NO_BUS=1.
set -uo pipefail

usage() { sed -n '2,39p' "$0" | sed 's/^# \{0,1\}//'; }
[[ "${1:-}" == "-h" || "${1:-}" == "--help" ]] && { usage; exit 0; }
[[ $# -ge 2 ]] || { usage >&2; exit 2; }
DIR="$1"; URL="$2"; shift 2
GATE_CMD="${OGL_SHIP_GATE_CMD:-}"
DEPLOY_CMD="${OGL_SHIP_DEPLOY_CMD:-vercel deploy --prod --yes}"
PROMOTE_CMD="${OGL_SHIP_PROMOTE_CMD:-}"
REMOVE_CMD="${OGL_SHIP_REMOVE_CMD:-}"
while [[ $# -gt 0 ]]; do
  [[ $# -ge 2 && -n "$2" ]] || { echo "usage: $1 needs a value" >&2; exit 2; }
  case "$1" in
    --gate-cmd) GATE_CMD="$2";; --deploy-cmd) DEPLOY_CMD="$2";;
    --promote-cmd) PROMOTE_CMD="$2";; --remove-cmd) REMOVE_CMD="$2";;
    *) echo "usage: unknown argument '$1'" >&2; exit 2;;
  esac
  shift 2
done
[[ -d "$DIR" ]] || { echo "usage: <dir> '$DIR' is not a directory" >&2; exit 2; }
[[ "$URL" =~ ^https?://[^[:space:]]+$ ]] || { echo "usage: invalid prod URL '$URL'" >&2; exit 2; }
[[ -n "$GATE_CMD" ]] || { echo "usage: no gate command (--gate-cmd or OGL_SHIP_GATE_CMD)" >&2; exit 2; }
cd "$DIR" || exit 2
REPORT="$PWD/security/pentest-gate-report.json"
CAND=""

fail() { echo "ABORT ($1): $2"; exit "$1"; }
http_code() {   # http_code <url> [-L]
  if [[ -n "${OGL_SHIP_HTTP:-}" ]]; then bash -c "$OGL_SHIP_HTTP \"\$@\"" _ "$@"
  else curl -s -o /dev/null -w '%{http_code}' --max-time 30 ${2:+"$2"} "$1"; fi
}
bus_event() {   # bus_event <event> <severity> <why>
  [[ -n "${OGL_NO_BUS:-}" ]] && return 0
  command -v cortextos >/dev/null || return 0
  local meta
  meta=$(python3 -c 'import json,sys; print(json.dumps({"url":sys.argv[1],"candidate":sys.argv[2],"why":sys.argv[3],"dir":sys.argv[4]}))' "$URL" "$CAND" "$3" "$PWD")
  cortextos bus log-event action "$1" "$2" --meta "$meta" >/dev/null 2>&1 || true
}
gate() {        # gate <url-or-empty>: run the gate, then require a fresh passing report
  local start
  start=$(python3 -c 'import time; print(int(time.time()))')
  [[ -f "$REPORT" ]] && mv -f "$REPORT" "$REPORT.prev"   # the previous verdict can never be read as this one
  bash -c "$GATE_CMD" _ "$1" >/dev/null 2>&1
  python3 - "$REPORT" "$start" <<'PY'
import json, os, sys
rep, start = sys.argv[1], int(sys.argv[2])
if not os.path.exists(rep): print(f"no report at {rep}"); sys.exit(1)
if int(os.path.getmtime(rep)) < start: print("report is older than this gate run (stale)"); sys.exit(1)
try: status = json.load(open(rep)).get("status")
except ValueError: print("report is not valid JSON"); sys.exit(1)
if status != "pass": print(f"report status={status!r}, not pass"); sys.exit(1)
PY
}
live_check() {  # live_check: prod 200 (redirects followed) and the live gate passes, else exit 5
  local code why
  code=$(http_code "$URL" -L)
  if [[ "$code" != 200 ]]; then bus_event ship_postgate_failed warning "prod HTTP $code"
    fail 5 "DEPLOYED, but $URL answers HTTP $code. Prod is live: check or roll back now."; fi
  if ! why=$(gate "$URL"); then bus_event ship_postgate_failed warning "live gate: $why"
    fail 5 "DEPLOYED, but the live gate did not pass: $why. Prod is live: check or roll back now."; fi
}

echo "[1] gate (static) in $PWD"
why=$(gate "") || fail 3 "pre-deploy gate did not pass: $why. Nothing deployed."
echo "    pass"

if [[ -z "$PROMOTE_CMD" ]]; then
  echo "[2] deploy: $DEPLOY_CMD"
  bash -c "$DEPLOY_CMD" || fail 4 "deploy command failed. Prod untouched by this run."
  echo "[3] live check: $URL"
  live_check
  echo "SHIPPED $URL"
  exit 0
fi

echo "[2] candidate deploy: $DEPLOY_CMD"
OUT=$(bash -c "$DEPLOY_CMD") || fail 4 "candidate deploy failed. Prod untouched."
CAND=$(printf '%s' "$OUT" | python3 -c '
import json, re, sys
t = sys.stdin.read()
try: print((json.loads(t).get("deployment") or {}).get("url") or "")
except ValueError:
    urls = [l.strip() for l in t.splitlines() if re.fullmatch(r"https://\S+", l.strip())]
    print(urls[-1] if urls else "")')
[[ "$CAND" =~ ^https://[^[:space:]\"]+$ ]] || fail 4 "candidate deploy printed no deployment URL. Prod untouched."
echo "    candidate: $CAND"

cand_fail() {
  local note="kept (no --remove-cmd)"
  if [[ -n "$REMOVE_CMD" ]]; then
    if bash -c "$REMOVE_CMD \"\$1\"" _ "$CAND" >/dev/null 2>&1; then note="removed"; else note="REMOVE FAILED, remove it by hand"; fi
  fi
  bus_event ship_candidate_rejected info "$1"
  fail 6 "$1. Prod untouched; candidate $CAND $note."
}
echo "[3] candidate check and gate"
code=$(http_code "$CAND")
[[ "$code" == 200 ]] || cand_fail "candidate answered HTTP $code, not 200"
why=$(gate "$CAND") || cand_fail "candidate gate did not pass: $why"
echo "    pass"

echo "[4] promote: $PROMOTE_CMD $CAND"
bash -c "$PROMOTE_CMD \"\$1\"" _ "$CAND" || { bus_event ship_promote_not_taken info "promote failed"
  fail 7 "promote failed. Prod still serves the old deployment; safe to retry."; }

echo "[5] live check: $URL"
live_check
echo "SHIPPED $URL (candidate $CAND)"
exit 0

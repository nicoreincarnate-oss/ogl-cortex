#!/usr/bin/env bash
# OGL Cortex doctor: a read-only health check for a cortextOS install.
#
# It reads files and asks tools for their versions. It never writes, never
# restarts anything, and never prints a secret value. For .env files it
# prints key NAMES only.
#
# Usage:
#   bash scripts/doctor.sh [--instance <id>] [--framework <dir>]
#                          [--disk-floor-gb <n>] [--offline]
#
# Defaults:
#   --instance       $CTX_INSTANCE_ID, else "default"
#   --framework      $CTX_FRAMEWORK_ROOT, else ~/cortextos
#   --disk-floor-gb  10
#
# Exit code: 0 when no FAIL lines, 1 when any check FAILs, 2 on bad usage.

set -u

INSTANCE="${CTX_INSTANCE_ID:-default}"
FRAMEWORK="${CTX_FRAMEWORK_ROOT:-$HOME/cortextos}"
DISK_FLOOR_GB=10
OFFLINE=0

usage() {
  sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --instance) [ $# -ge 2 ] || { usage; exit 2; }; INSTANCE="$2"; shift 2 ;;
    --instance=*) INSTANCE="${1#*=}"; shift ;;
    --framework) [ $# -ge 2 ] || { usage; exit 2; }; FRAMEWORK="$2"; shift 2 ;;
    --framework=*) FRAMEWORK="${1#*=}"; shift ;;
    --disk-floor-gb) [ $# -ge 2 ] || { usage; exit 2; }; DISK_FLOOR_GB="$2"; shift 2 ;;
    --offline) OFFLINE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage; exit 2 ;;
  esac
done

case "$INSTANCE" in
  *[!a-zA-Z0-9_-]*|"") echo "invalid instance id: $INSTANCE" >&2; exit 2 ;;
esac
case "$DISK_FLOOR_GB" in
  *[!0-9]*|"") echo "--disk-floor-gb must be a whole number" >&2; exit 2 ;;
esac

CTX_ROOT_DIR="$HOME/.cortextos/$INSTANCE"
N_PASS=0; N_WARN=0; N_FAIL=0

# Show paths with ~ instead of the home directory.
tidy() { printf '%s' "${1/#$HOME/~}"; }

pass() { N_PASS=$((N_PASS+1)); printf 'PASS  %s\n' "$*"; }
warn() { N_WARN=$((N_WARN+1)); printf 'WARN  %s\n' "$*"; }
fail() { N_FAIL=$((N_FAIL+1)); printf 'FAIL  %s\n' "$*"; }
info() { printf '      %s\n' "$*"; }
section() { printf '\n== %s\n' "$*"; }

have() { command -v "$1" >/dev/null 2>&1; }

# Read one key from an env file without sourcing it. Prints the raw value.
# The value stays inside the script; callers only test it.
env_value() {
  # $1 = file, $2 = key
  grep -E "^[[:space:]]*(export[[:space:]]+)?$2=" "$1" 2>/dev/null | tail -n 1 \
    | sed -E "s/^[[:space:]]*(export[[:space:]]+)?$2=//; s/^[\"']//; s/[\"'][[:space:]]*$//"
}

printf 'OGL Cortex doctor (read-only)\n'
printf 'instance:  %s\n' "$INSTANCE"
printf 'state:     %s\n' "$(tidy "$CTX_ROOT_DIR")"
printf 'framework: %s\n' "$(tidy "$FRAMEWORK")"

# ---------------------------------------------------------------------------
section "Prerequisites"

OS="$(uname -s)"
case "$OS" in
  Darwin|Linux) pass "os: $OS $(uname -r)" ;;
  *) warn "os: $OS is not a tested platform (macOS or Linux expected)" ;;
esac

if have node; then
  NODE_V="$(node --version 2>/dev/null)"
  NODE_MAJOR="$(printf '%s' "$NODE_V" | sed -E 's/^v([0-9]+).*/\1/')"
  if [ "${NODE_MAJOR:-0}" -ge 20 ] 2>/dev/null; then pass "node $NODE_V (needs >= 20)"
  else fail "node $NODE_V is too old (needs >= 20)"; fi
else
  fail "node not found (needs >= 20)"
fi

for tool in npm git python3 jq curl; do
  if have "$tool"; then
    case "$tool" in
      jq) v="$(jq --version 2>/dev/null)" ;;
      *) v="$("$tool" --version 2>/dev/null | head -n 1)" ;;
    esac
    pass "$tool: $v"
  else
    case "$tool" in
      jq|curl) warn "$tool not found (bus shell scripts and Telegram helpers use it)" ;;
      *) fail "$tool not found" ;;
    esac
  fi
done

if have pm2; then
  pass "pm2: $(pm2 --version 2>/dev/null | tail -n 1)"
else
  fail "pm2 not found (npm install -g pm2)"
fi

if have claude; then
  pass "claude: $(claude --version 2>/dev/null | head -n 1)"
  # Print only the login flag and method. The full status JSON holds account data.
  AUTH="$(claude auth status --json 2>/dev/null | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
    print("yes" if d.get("loggedIn") else "no", d.get("authMethod") or "unknown")
except Exception:
    print("unknown -")
' 2>/dev/null)"
  case "$AUTH" in
    yes*) pass "claude auth: logged in (${AUTH#yes })" ;;
    no*)  fail "claude auth: not logged in (run: claude auth login)" ;;
    *)    warn "claude auth: could not read status (run: claude auth status)" ;;
  esac
else
  fail "claude (Claude Code CLI) not found"
fi

if have cortextos; then
  pass "cortextos on PATH: $(tidy "$(command -v cortextos)") v$(cortextos --version 2>/dev/null)"
else
  fail "cortextos not on PATH (run npm link inside the framework checkout)"
fi

if [ -f "$FRAMEWORK/dist/daemon.js" ]; then
  pass "framework built: $(tidy "$FRAMEWORK")/dist/daemon.js"
elif [ -d "$FRAMEWORK" ]; then
  fail "framework at $(tidy "$FRAMEWORK") has no dist/daemon.js (run npm run build)"
else
  fail "framework dir $(tidy "$FRAMEWORK") not found (pass --framework <dir>)"
fi

# ---------------------------------------------------------------------------
section "Daemon"

PM2_PID_FILE="$HOME/.pm2/pm2.pid"
PM2_UP=0
if [ -f "$PM2_PID_FILE" ] && kill -0 "$(cat "$PM2_PID_FILE" 2>/dev/null)" 2>/dev/null; then
  PM2_UP=1
fi

if [ "$PM2_UP" -eq 1 ] && have pm2; then
  # pm2 jlist includes each process env, which can hold secrets.
  # Parse it in-process and print only name, status, and the --instance arg.
  PM2_REPORT="$(pm2 jlist 2>/dev/null | python3 -c '
import json, sys
raw = sys.stdin.read()
start = raw.find("[")
try:
    procs = json.loads(raw[start:]) if start >= 0 else []
except Exception:
    procs = None
if procs is None:
    print("ERR"); sys.exit(0)
for p in procs:
    name = p.get("name", "?")
    env = p.get("pm2_env", {}) or {}
    status = env.get("status", "?")
    args = env.get("args") or []
    if isinstance(args, str):
        args = args.split()
    inst = ""
    for i, a in enumerate(args):
        if a == "--instance" and i + 1 < len(args):
            inst = args[i + 1]
    print("%s\t%s\t%s\t%s" % (name, status, inst, env.get("restart_time", 0)))
' 2>/dev/null)"
  if [ "$PM2_REPORT" = "ERR" ] || [ -z "$PM2_REPORT" ]; then
    fail "pm2 is up but its process list could not be read"
  else
    DAEMON_LINE="$(printf '%s\n' "$PM2_REPORT" | awk -F'\t' '$1=="cortextos-daemon"')"
    if [ -z "$DAEMON_LINE" ]; then
      fail "no cortextos-daemon process in pm2 (run cortextos ecosystem --instance $INSTANCE, then pm2 start ecosystem.config.js)"
    else
      D_STATUS="$(printf '%s' "$DAEMON_LINE" | cut -f2)"
      D_INST="$(printf '%s' "$DAEMON_LINE" | cut -f3)"
      D_RESTARTS="$(printf '%s' "$DAEMON_LINE" | cut -f4)"
      if [ "$D_STATUS" = "online" ]; then pass "cortextos-daemon: online under pm2 (pm2 restarts: $D_RESTARTS)"
      else fail "cortextos-daemon: $D_STATUS"; fi
      if [ -z "$D_INST" ]; then
        warn "cortextos-daemon has no --instance arg; it runs on the 'default' instance"
      elif [ "$D_INST" != "$INSTANCE" ]; then
        fail "cortextos-daemon runs --instance $D_INST but you asked about $INSTANCE (the --instance gotcha)"
      else
        pass "cortextos-daemon --instance matches ($INSTANCE)"
      fi
    fi
    printf '%s\n' "$PM2_REPORT" | awk -F'\t' '$1!="cortextos-daemon"{printf "      other pm2 process: %s (%s)\n", $1, $2}'
  fi
else
  fail "pm2 daemon not running (doctor does not start it; run: pm2 resurrect or cortextos start --instance $INSTANCE)"
fi

if [ -S "$CTX_ROOT_DIR/daemon.sock" ]; then
  pass "daemon IPC socket present: $(tidy "$CTX_ROOT_DIR")/daemon.sock"
else
  warn "no daemon IPC socket at $(tidy "$CTX_ROOT_DIR")/daemon.sock (daemon down or other instance)"
fi

# ---------------------------------------------------------------------------
section "Instance"

ENABLED="$CTX_ROOT_DIR/config/enabled-agents.json"
if [ -d "$CTX_ROOT_DIR" ]; then
  pass "instance dir exists: $(tidy "$CTX_ROOT_DIR")"
else
  fail "instance dir missing: $(tidy "$CTX_ROOT_DIR") (run cortextos install --instance $INSTANCE)"
fi

SEATS=""
if [ -r "$ENABLED" ]; then
  SEATS="$(python3 -c '
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    print("ERR"); sys.exit(0)
for name, e in sorted(d.items()):
    e = e or {}
    print("%s\t%s\t%s" % (name, e.get("org", ""), "on" if e.get("enabled", True) else "off"))
' "$ENABLED")"
  if [ "$SEATS" = "ERR" ]; then
    fail "enabled-agents.json is not valid JSON"
    SEATS=""
  else
    N_SEATS="$(printf '%s\n' "$SEATS" | grep -c . )"
    pass "enabled-agents.json readable ($N_SEATS seats registered)"
  fi
else
  fail "cannot read $(tidy "$ENABLED") (no seats registered yet: cortextos add-agent)"
fi

# ---------------------------------------------------------------------------
section "Seats"

TOKENS_SEEN=""   # newline list kept in memory only; never printed
TG_DONE=0

check_hooks() {
  # $1 = seat dir, $2 = settings.json path, $3 = label
  python3 - "$1" "$2" "$3" "$HOME" <<'PY'
import json, os, shlex, sys
seat, path, label, home = sys.argv[1:5]
def out(level, msg):
    print("%s\t%s" % (level, msg))
try:
    d = json.load(open(path))
except Exception as e:
    out("FAIL", "%s: settings.json is not valid JSON" % label); sys.exit(0)
hooks = d.get("hooks") or {}
if not hooks:
    out("WARN", "%s: no hooks wired" % label); sys.exit(0)
n = 0; missing = []
for event, groups in hooks.items():
    for g in groups or []:
        for h in (g or {}).get("hooks", []) or []:
            cmd = (h or {}).get("command", "")
            if not cmd:
                continue
            n += 1
            cmd = cmd.split(" #", 1)[0]
            try:
                toks = shlex.split(cmd)
            except ValueError:
                toks = cmd.split()
            for t in toks:
                if "=" in t and "/" not in t.split("=", 1)[0] and t.split("=", 1)[0].isidentifier():
                    continue  # VAR=value prefix
                t = t.replace("$CLAUDE_PROJECT_DIR", seat).replace("${CLAUDE_PROJECT_DIR}", seat)
                t = t.replace("$HOME", home).replace("${HOME}", home)
                if t.startswith("~/"):
                    t = os.path.join(home, t[2:])
                if "/" not in t or "$" in t:
                    continue
                if not (t.endswith((".py", ".sh", ".js", ".mjs", ".ts")) or "/bin/" in t):
                    continue
                full = t if os.path.isabs(t) else os.path.join(seat, t)
                if not os.path.exists(full):
                    missing.append("%s -> %s" % (event, full.replace(home, "~", 1)))
events = ", ".join(sorted(hooks.keys()))
if missing:
    out("FAIL", "%s: %d hook commands, %d point at missing files" % (label, n, len(missing)))
    for m in missing:
        out("INFO", "missing hook script: " + m)
else:
    out("PASS", "%s: %d hook commands wired, all script paths exist (%s)" % (label, n, events))
PY
}

emit() {
  # Reads "LEVEL<TAB>message" lines from stdin and routes them.
  while IFS="$(printf '\t')" read -r lvl msg; do
    case "$lvl" in
      PASS) pass "$msg" ;;
      WARN) warn "$msg" ;;
      FAIL) fail "$msg" ;;
      *) info "$msg" ;;
    esac
  done
}

if [ -n "$SEATS" ]; then
  while IFS="$(printf '\t')" read -r seat org state; do
    [ -n "$seat" ] || continue
    printf -- '-- seat %s (org %s, %s)\n' "$seat" "${org:-?}" "$state"
    SEAT_DIR="$FRAMEWORK/orgs/$org/agents/$seat"
    if [ -z "$org" ] || [ ! -d "$SEAT_DIR" ]; then
      warn "$seat: seat dir not found under $(tidy "$FRAMEWORK")/orgs/*/agents"
      continue
    fi

    ENVF="$SEAT_DIR/.env"
    if [ -f "$ENVF" ]; then
      KEYS="$(grep -E '^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*=' "$ENVF" \
        | sed -E 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=.*/\2/' | sort -u | tr '\n' ' ')"
      info ".env keys: ${KEYS:-none}"
      PERM="$(stat -f '%Lp' "$ENVF" 2>/dev/null || stat -c '%a' "$ENVF" 2>/dev/null)"
      if [ "$PERM" = "600" ] || [ "$PERM" = "400" ]; then pass "$seat: .env mode $PERM"
      else warn "$seat: .env mode $PERM (expected 600)"; fi

      BT="$(env_value "$ENVF" BOT_TOKEN)"
      CI="$(env_value "$ENVF" CHAT_ID)"
      AU="$(env_value "$ENVF" ALLOWED_USER)"
      if [ -n "$BT" ] && [ -n "$CI" ]; then
        if printf '%s' "$BT" | grep -Eq '^[0-9]+:[A-Za-z0-9_-]+$'; then
          pass "$seat: BOT_TOKEN and CHAT_ID set (token format ok)"
        else
          fail "$seat: BOT_TOKEN format invalid (expected <digits>:<secret>); daemon will not start Telegram"
        fi
        if [ -z "$AU" ]; then
          fail "$seat: BOT_TOKEN set but ALLOWED_USER empty; daemon refuses Telegram for this seat"
        elif printf '%s' "$AU" | grep -Eq '^[0-9]+(,[0-9]+)*$'; then
          pass "$seat: ALLOWED_USER set (numeric)"
        else
          fail "$seat: ALLOWED_USER must be numeric Telegram user IDs, comma separated"
        fi
        # Telegram reachability, once per distinct token.
        if [ "$OFFLINE" -eq 1 ]; then
          :
        elif ! have curl; then
          warn "$seat: curl missing, Telegram check skipped"
        elif printf '%s\n' "$TOKENS_SEEN" | grep -qxF -- "$BT"; then
          info "Telegram: token shared with an earlier seat, already checked"
        else
          TOKENS_SEEN="$(printf '%s\n%s' "$TOKENS_SEEN" "$BT")"
          # Feed the URL through stdin (-K -) so the token never appears in argv.
          TG_OK="$(printf 'url = "https://api.telegram.org/bot%s/getMe"\n' "$BT" \
            | curl -s --max-time 8 -K - 2>/dev/null \
            | python3 -c 'import json,sys
try:
    d=json.load(sys.stdin); print("ok" if d.get("ok") else "rejected:%s" % d.get("error_code","?"))
except Exception:
    print("unreachable")' 2>/dev/null)"
          TG_DONE=$((TG_DONE+1))
          case "$TG_OK" in
            ok) pass "$seat: Telegram getMe ok" ;;
            rejected*) fail "$seat: Telegram rejected the token (${TG_OK#rejected:})" ;;
            *) warn "$seat: Telegram API unreachable from this host" ;;
          esac
        fi
      else
        warn "$seat: BOT_TOKEN or CHAT_ID empty (fine only for a headless --worker seat)"
      fi
      unset BT CI AU
    else
      # The daemon starts a seat without .env, but with no Telegram at all.
      if [ "$state" = "on" ]; then warn "$seat: enabled but no .env, so it runs headless with no Telegram (create .env unless this is a worker seat)"
      else info "no .env (seat is disabled)"; fi
    fi

    CRONS="$CTX_ROOT_DIR/.cortextOS/state/agents/$seat/crons.json"
    if [ -f "$CRONS" ]; then
      CR="$(python3 -c '
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    c = d.get("crons", []) if isinstance(d, dict) else d
    print("%d %d" % (len(c), sum(1 for x in c if x.get("enabled", True))))
except Exception:
    print("ERR")
' "$CRONS")"
      if [ "$CR" = "ERR" ]; then fail "$seat: crons.json is not valid JSON"
      else pass "$seat: crons.json readable (${CR% *} crons, ${CR#* } enabled)"; fi
    else
      info "no crons.json yet (add one with cortextos bus add-cron)"
    fi

    if [ -f "$SEAT_DIR/.claude/settings.json" ]; then
      check_hooks "$SEAT_DIR" "$SEAT_DIR/.claude/settings.json" "$seat" | emit
    else
      warn "$seat: no .claude/settings.json (no seat hooks wired)"
    fi
  done <<EOF
$SEATS
EOF
fi

if [ -f "$HOME/.claude/settings.json" ]; then
  printf -- '-- user level\n'
  check_hooks "$HOME" "$HOME/.claude/settings.json" "~/.claude/settings.json" | emit
fi
if [ "$OFFLINE" -eq 1 ]; then info "Telegram checks skipped (--offline)"; fi
unset TOKENS_SEEN

# ---------------------------------------------------------------------------
section "Host"

FREE_KB="$(df -Pk "$HOME" 2>/dev/null | awk 'NR==2{print $4}')"
if [ -n "$FREE_KB" ]; then
  FREE_GB=$((FREE_KB / 1024 / 1024))
  if [ "$FREE_GB" -ge "$DISK_FLOOR_GB" ]; then pass "disk free: ${FREE_GB} GB (floor ${DISK_FLOOR_GB} GB)"
  else fail "disk free: ${FREE_GB} GB is under the ${DISK_FLOOR_GB} GB floor"; fi
else
  warn "disk free: could not read df"
fi

if [ "$OS" = "Darwin" ]; then
  SW="$(sysctl -n vm.swapusage 2>/dev/null)"
  # total = 2048.00M  used = 1024.00M  free = 1024.00M
  TOT="$(printf '%s' "$SW" | sed -E 's/.*total = ([0-9.]+)M.*/\1/')"
  USED="$(printf '%s' "$SW" | sed -E 's/.*used = ([0-9.]+)M.*/\1/')"
else
  TOT="$(awk '/^SwapTotal:/{printf "%.0f", $2/1024}' /proc/meminfo 2>/dev/null)"
  FREE_SW="$(awk '/^SwapFree:/{printf "%.0f", $2/1024}' /proc/meminfo 2>/dev/null)"
  USED=""; [ -n "$TOT" ] && [ -n "$FREE_SW" ] && USED=$((TOT - FREE_SW))
fi
if [ -n "${TOT:-}" ] && [ -n "${USED:-}" ]; then
  PCT="$(awk -v u="$USED" -v t="$TOT" 'BEGIN{ if (t>0) printf "%d", u*100/t; else print "-1" }')"
  if [ "$PCT" = "-1" ]; then
    warn "swap: none configured (each seat runs a full Claude Code session; add swap or RAM)"
  elif [ "$PCT" -ge 80 ]; then
    warn "swap: ${USED%.*} of ${TOT%.*} MB used (${PCT}%); memory pressure, run fewer seats"
  else
    pass "swap: ${USED%.*} of ${TOT%.*} MB used (${PCT}%)"
  fi
else
  warn "swap: could not read usage"
fi

# ---------------------------------------------------------------------------
printf '\n%d pass, %d warn, %d fail\n' "$N_PASS" "$N_WARN" "$N_FAIL"
[ "$N_FAIL" -eq 0 ]

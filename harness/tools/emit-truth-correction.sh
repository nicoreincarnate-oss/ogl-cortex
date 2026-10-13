#!/usr/bin/env bash
# emit-truth-correction.sh: validated emitter for the truth_correction ledger event.
#
# A truth correction records that an agent said something false and who caught it. The ledger is only worth
# reading if the "who caught it" field cannot be typed by hand, so this script derives it:
#
#   kind                      caught_by comes from
#   self_correction           the correcting agent itself (CTX_AGENT_NAME or --caught-agent)
#   verify_cleared            the correcting agent itself
#   peer_catch, enforcer_catch the catcher's bus message id (<ts>-<agent>-<rand>), via --triggering-msg
#   artifact_catch            the seat that owns the file that was read (.../state/<seat>/ or .../agents/<seat>/)
#   principal_catch           the principal (the human), proven by an inbound Telegram record
#   known_unrecordable_catch  the principal, with a required --candidate-set describing the search made
#
# Rules the script enforces (each failure exits 2 with the reason on stderr; nothing is emitted):
#   - kind is one of the seven above; catcher_type is party or instrument
#   - --claim, --correction and --dedupe-slug are required; a value flag with no value is refused, so a
#     missing value can never swallow --dry-run
#   - dedupe slug and caught agent match [a-z0-9-]+, so the key <agent>.<slug>.<occurred> is unambiguous
#   - --occurred-at parses as a time-zone-explicit instant no more than 2 minutes in the future; it is
#     normalised to YYYY-MM-DDTHH:MM:SSZ (default: now)
#   - peer/enforcer: --triggering-msg must have the msg_id shape
#   - artifact_catch: the path must exist, be readable, sit in a seat tree, and be older than occurred_at;
#     reading your own seat's file collapses to self_correction
#   - principal_catch: no --triggering-msg; --principal-evidence telegram:<chat_id>:<message_id> must match
#     a record in $CTX_ROOT/logs/*/inbound-messages.jsonl whose sender is OGL_PRINCIPAL_ID
#   - known_unrecordable_catch: --candidate-set must be a JSON object
#
# Usage:
#   emit-truth-correction.sh --kind <kind> --dedupe-slug <slug> --claim "<false claim>" --correction "<truth>" \
#       [--triggering-msg <msg_id>] [--evidence "<text>"] [--occurred-at <iso>] [--caught-agent <seat>] \
#       [--catcher-type party|instrument] [--artifact-path <path>] [--evidence-anchor <field>] \
#       [--principal-evidence telegram:<chat>:<msg>] [--candidate-set '<json>'] [--near-miss] [--dry-run]
#
# Output: with --dry-run, the event meta JSON on stdout. Otherwise it runs
#   cortextos bus log-event action truth_correction info --meta '<json>'
#
# Environment:
#   CTX_AGENT_NAME     default caught agent
#   CTX_ROOT           cortextOS instance root, for principal evidence lookup
#   OGL_PRINCIPAL_ID   Telegram sender id of the principal (required for principal_catch)
#   OGL_PRINCIPAL_NAME caught_by value for principal kinds (default: principal)
#
# Exit codes: 0 emitted (or printed with --dry-run), 2 input rejected, other = the cortextos CLI's exit code.
set -euo pipefail

CANONICAL_KINDS="self_correction peer_catch enforcer_catch principal_catch verify_cleared artifact_catch known_unrecordable_catch"
EXTERNAL_KINDS="peer_catch enforcer_catch"
CATCHER_TYPES="party instrument"
PRINCIPAL_NAME="${OGL_PRINCIPAL_NAME:-principal}"

die() { echo "ERROR: $*" >&2; exit 2; }
reqval() { case "${2:-}" in ''|--*) die "$1 requires a value (got '${2:-<end>}'); a missing value would swallow the next flag";; esac; }

KIND="" CLAIM="" CORRECTION="" TRIGGERING_MSG="" EVIDENCE="" OCCURRED_AT="" DEDUPE_SLUG=""
ARTIFACT_PATH="" EVIDENCE_ANCHOR="" PRINCIPAL_EVIDENCE="" CANDIDATE_SET=""
CAUGHT_AGENT="${CTX_AGENT_NAME:-}" CATCHER_TYPE="party" DRY=0 NEAR_MISS=0
while [ $# -gt 0 ]; do
  case "$1" in
    --kind)               reqval "$1" "${2:-}"; KIND="$2"; shift 2;;
    --claim)              reqval "$1" "${2:-}"; CLAIM="$2"; shift 2;;
    --correction)         reqval "$1" "${2:-}"; CORRECTION="$2"; shift 2;;
    --triggering-msg)     reqval "$1" "${2:-}"; TRIGGERING_MSG="$2"; shift 2;;
    --evidence)           reqval "$1" "${2:-}"; EVIDENCE="$2"; shift 2;;
    --occurred-at)        reqval "$1" "${2:-}"; OCCURRED_AT="$2"; shift 2;;
    --dedupe-slug)        reqval "$1" "${2:-}"; DEDUPE_SLUG="$2"; shift 2;;
    --caught-agent)       reqval "$1" "${2:-}"; CAUGHT_AGENT="$2"; shift 2;;
    --catcher-type)       reqval "$1" "${2:-}"; CATCHER_TYPE="$2"; shift 2;;
    --artifact-path)      reqval "$1" "${2:-}"; ARTIFACT_PATH="$2"; shift 2;;
    --evidence-anchor)    reqval "$1" "${2:-}"; EVIDENCE_ANCHOR="$2"; shift 2;;
    --principal-evidence) reqval "$1" "${2:-}"; PRINCIPAL_EVIDENCE="$2"; shift 2;;
    --candidate-set)      reqval "$1" "${2:-}"; CANDIDATE_SET="$2"; shift 2;;
    --near-miss) NEAR_MISS=1; shift;;
    --dry-run) DRY=1; shift;;
    -h|--help) sed -n '2,44p' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
    *) die "unknown arg: $1";;
  esac
done

case " $CANONICAL_KINDS " in *" $KIND "*) ;; *) die "kind '$KIND' not in: $CANONICAL_KINDS";; esac
case " $CATCHER_TYPES " in *" $CATCHER_TYPE "*) ;; *) die "catcher_type '$CATCHER_TYPE' not in: $CATCHER_TYPES";; esac
[ -n "$CLAIM" ] || die "--claim required"
[ -n "$CORRECTION" ] || die "--correction required"
[ -n "$DEDUPE_SLUG" ] || die "--dedupe-slug required (names the correction, keeps keys unique)"
[[ "$DEDUPE_SLUG" =~ ^[a-z0-9-]+$ ]] || die "--dedupe-slug '$DEDUPE_SLUG' must match [a-z0-9-]+"
[ -n "$CAUGHT_AGENT" ] || die "caught agent unresolved: set CTX_AGENT_NAME or pass --caught-agent (no default name)"
[[ "$CAUGHT_AGENT" =~ ^[a-z0-9-]+$ ]] || die "caught agent '$CAUGHT_AGENT' must match [a-z0-9-]+"

is_artifact=0; is_principal=0
if [ "$KIND" = "principal_catch" ]; then
  is_principal=1
  [ -z "$TRIGGERING_MSG" ] || die "--triggering-msg is not valid for principal_catch: the principal is not a bus sender; use --principal-evidence"
  [ -n "$PRINCIPAL_EVIDENCE" ] || die "--principal-evidence telegram:<chat_id>:<message_id> required for principal_catch"
  [[ "$PRINCIPAL_EVIDENCE" =~ ^telegram:[0-9]+:[0-9]+$ ]] || die "--principal-evidence must be telegram:<chat_id>:<message_id>"
  [ -n "${OGL_PRINCIPAL_ID:-}" ] || die "OGL_PRINCIPAL_ID is not set: cannot verify who sent the cited record"
  [ -n "${CTX_ROOT:-}" ] || die "CTX_ROOT is not set: cannot find inbound message logs"
  PE="$PRINCIPAL_EVIDENCE" PIN="$OGL_PRINCIPAL_ID" python3 -c '
import glob, json, os, sys
_, chat, msg = os.environ["PE"].split(":")
for p in sorted(glob.glob(os.path.join(os.environ["CTX_ROOT"], "logs", "*", "inbound-messages.jsonl"))):
    try:
        fh = open(p)
    except OSError:
        continue
    for line in fh:
        try: d = json.loads(line)
        except ValueError: continue
        if str(d.get("chat_id")) == chat and str(d.get("message_id")) == msg:
            frm = d.get("from") if d.get("from") is not None else d.get("chat_id")
            sys.exit(0 if str(frm) == os.environ["PIN"] else 3)
sys.exit(4)
' || die "--principal-evidence '$PRINCIPAL_EVIDENCE' does not match an inbound record from the principal"
  CAUGHT_BY="$PRINCIPAL_NAME"; CATCHER_TYPE="party"
elif [ "$KIND" = "artifact_catch" ]; then
  is_artifact=1
  [ -n "$ARTIFACT_PATH" ] || die "--artifact-path required for artifact_catch"
  CATCHER_TYPE="party"
  OWNING_SEAT=$(ARTIFACT_PATH="$ARTIFACT_PATH" python3 -c '
import os, re, sys
rp = os.path.realpath(os.environ["ARTIFACT_PATH"])
if not (os.path.exists(rp) and os.access(rp, os.R_OK)): sys.exit(2)
m = re.search(r"/(?:state|agents)/([a-z0-9-]+)/", rp)
if not m: sys.exit(3)
print(m.group(1))
') || die "--artifact-path '$ARTIFACT_PATH' must exist, be readable, and sit under .../state/<seat>/ or .../agents/<seat>/"
  if [ "$OWNING_SEAT" = "$CAUGHT_AGENT" ]; then
    echo "NOTE: the artifact belongs to '$CAUGHT_AGENT' itself; recording self_correction instead of artifact_catch" >&2
    KIND="self_correction"; is_artifact=0; CAUGHT_BY="$CAUGHT_AGENT"
  else
    CAUGHT_BY="$OWNING_SEAT"
  fi
elif [[ " $EXTERNAL_KINDS " == *" $KIND "* ]]; then
  [ -n "$TRIGGERING_MSG" ] || die "--triggering-msg (the catcher's message id) required for $KIND"
  [[ "$TRIGGERING_MSG" =~ ^[0-9]+-[a-z0-9-]+-[a-z0-9]+$ ]] || die "--triggering-msg '$TRIGGERING_MSG' is not a msg_id (<ts>-<agent>-<rand>)"
  CAUGHT_BY=$(printf '%s' "$TRIGGERING_MSG" | sed -E 's/^[0-9]+-//; s/-[^-]+$//')
else
  CAUGHT_BY="$CAUGHT_AGENT"
fi

if [ "$KIND" = "known_unrecordable_catch" ]; then
  CAUGHT_BY="$PRINCIPAL_NAME"
  [ -n "$CANDIDATE_SET" ] || die "--candidate-set required for known_unrecordable_catch: record what was searched"
  printf '%s' "$CANDIDATE_SET" | python3 -c 'import json,sys; sys.exit(0 if isinstance(json.load(sys.stdin), dict) else 4)' 2>/dev/null \
    || die "--candidate-set must be a JSON object"
fi

[ -n "$OCCURRED_AT" ] || OCCURRED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
ORIG_OCC="$OCCURRED_AT"
OCCURRED_AT=$(python3 -c '
import datetime as d, sys
try: t = d.datetime.fromisoformat(sys.argv[1].replace("Z", "+00:00"))
except ValueError: sys.exit(1)
if t.tzinfo is None: sys.exit(3)
t = t.astimezone(d.timezone.utc)
if t > d.datetime.now(d.timezone.utc) + d.timedelta(minutes=2): sys.exit(2)
print(t.strftime("%Y-%m-%dT%H:%M:%SZ"))
' "$ORIG_OCC") || die "--occurred-at '$ORIG_OCC' must be a valid, time-zone-explicit instant, not in the future"

if [ "$is_artifact" = 1 ]; then
  ARTIFACT_PATH="$ARTIFACT_PATH" CATCH_TIME="$OCCURRED_AT" python3 -c '
import datetime as d, os, sys
mt = os.path.getmtime(os.path.realpath(os.environ["ARTIFACT_PATH"]))
ct = d.datetime.fromisoformat(os.environ["CATCH_TIME"].replace("Z", "+00:00")).timestamp()
sys.exit(0 if mt < ct else 2)
' || die "artifact was modified at or after occurred_at ($OCCURRED_AT); pass the real read time"
  [ -n "$EVIDENCE_ANCHOR" ] || echo "WARN: artifact_catch without --evidence-anchor (the field or line that was read)" >&2
fi

OCC_COMPACT=$(printf '%s' "$OCCURRED_AT" | sed 's/[-:]//g; s/Z$//' | cut -c1-15)
DEDUPE_KEY="${CAUGHT_AGENT}.${DEDUPE_SLUG}.${OCC_COMPACT}"

META=$(KIND="$KIND" CAUGHT_AGENT="$CAUGHT_AGENT" CAUGHT_BY="$CAUGHT_BY" CATCHER_TYPE="$CATCHER_TYPE" \
  TRIGGERING_MSG="$TRIGGERING_MSG" OCCURRED_AT="$OCCURRED_AT" DEDUPE_KEY="$DEDUPE_KEY" CLAIM="$CLAIM" \
  CORRECTION="$CORRECTION" EVIDENCE="$EVIDENCE" IS_ARTIFACT="$is_artifact" ARTIFACT_PATH="$ARTIFACT_PATH" \
  EVIDENCE_ANCHOR="$EVIDENCE_ANCHOR" IS_PRINCIPAL="$is_principal" PRINCIPAL_EVIDENCE="$PRINCIPAL_EVIDENCE" \
  NEAR_MISS="$NEAR_MISS" CANDIDATE_SET="$CANDIDATE_SET" python3 -c '
import json, os
e = os.environ
meta = {"kind": e["KIND"], "caught_agent": e["CAUGHT_AGENT"], "caught_by": e["CAUGHT_BY"],
        "catcher_type": e["CATCHER_TYPE"], "triggering_msg": e["TRIGGERING_MSG"] or None,
        "occurred_at": e["OCCURRED_AT"], "dedupe_key": e["DEDUPE_KEY"], "claim": e["CLAIM"],
        "correction": e["CORRECTION"], "evidence": e["EVIDENCE"] or None}
if e["IS_ARTIFACT"] == "1":
    meta["artifact_provenance"] = {"path": e["ARTIFACT_PATH"], "catch_time": e["OCCURRED_AT"],
                                   "evidence_anchor": e["EVIDENCE_ANCHOR"] or None}
if e["IS_PRINCIPAL"] == "1":
    meta["principal_evidence"] = e["PRINCIPAL_EVIDENCE"]
if e["NEAR_MISS"] == "1":
    meta["near_miss"] = True
if e["KIND"] == "known_unrecordable_catch":
    meta["principal_evidence"] = None
    meta["candidate_set"] = json.loads(e["CANDIDATE_SET"])
    meta["resolve_mode"] = "propose-only"
print(json.dumps(meta))
')

if [ "$DRY" = 1 ]; then printf '%s\n' "$META"; exit 0; fi
cortextos bus log-event action truth_correction info --meta "$META"

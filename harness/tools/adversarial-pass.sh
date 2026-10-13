#!/usr/bin/env bash
# adversarial-pass.sh: one fenced adversarial pass ("the hunter") against ONE claim.
#
# A fresh model session, which did not write the code, tries to break a single rule you rely on. It gets
# read-only tools, a named file list, one round and a time budget. It must back every finding with file:line
# and an exact reproduction, and say whether real user or operator actions can reach it.
# The hunter finds. You judge each finding: can real actions reach it? Invented inputs are dropped.
#
# Usage:
#   adversarial-pass.sh --claim "<one rule>" --cd <dir> [--budget <minutes>] [--engine <model>|codex]
#                       [--out-dir <dir>] file1 [file2 ...]
#
#   --claim    the one rule under attack, e.g. "the guard blocks every write to ~/.claude"
#   --cd       directory the hunter runs in; files are read relative to it
#   --budget   minutes of reading (default 10); the run is killed at budget + 5 minutes when timeout(1) exists
#   --engine   a Claude model name or alias for `claude --model` (default: $OGL_HUNTER_MODEL or opus),
#              or "codex" to use the Codex CLI in read-only sandbox mode
#   --out-dir  where the run report goes (default: ./adversarial-runs)
#
# The Claude engine runs: claude -p --model <m> --allowedTools Read,Grep,Glob --setting-sources ""
#   --strict-mcp-config --no-session-persistence, with CLAUDECODE and every CTX_* variable removed, so the
#   hunter has no project settings, no MCP servers, no memory and no seat identity.
#
# Output: the path of the report, <out-dir>/<UTC time>-<claim slug>.md, on stdout.
# Exit codes: 0 report written and the engine exited 0; 2 usage error; 3 report written but the engine
#   failed or timed out (the report says so).
#
# Environment: OGL_HUNTER_MODEL (default model), OGL_HUNTER_CMD (replaces the engine command; used by tests).
set -euo pipefail

CLAIM="" CD="" BUDGET="10" ENGINE="${OGL_HUNTER_MODEL:-opus}" OUT_DIR="./adversarial-runs"
usage() { sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'; }
while [[ $# -gt 0 && "$1" == --* ]]; do
  case "$1" in
    --claim|--cd|--budget|--engine|--out-dir)
      [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || { echo "ERROR: $1 needs a value" >&2; exit 2; }
      case "$1" in --claim) CLAIM="$2";; --cd) CD="$2";; --budget) BUDGET="$2";; --engine) ENGINE="$2";; --out-dir) OUT_DIR="$2";; esac
      shift 2;;
    --help) usage; exit 0;;
    *) echo "ERROR: unknown option $1" >&2; exit 2;;
  esac
done
[[ -n "$CLAIM" && -n "$CD" && $# -gt 0 ]] || { echo "ERROR: need --claim, --cd and at least one file" >&2; usage >&2; exit 2; }
[[ -d "$CD" ]] || { echo "ERROR: --cd $CD is not a directory" >&2; exit 2; }
[[ "$BUDGET" =~ ^[0-9]+$ ]] || { echo "ERROR: --budget must be whole minutes" >&2; exit 2; }

mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
SLUG=$(printf '%s' "$CLAIM" | tr 'A-Z' 'a-z' | tr -cs 'a-z0-9' '-' | cut -c1-40)
OUT="$OUT_DIR/$(date -u +%Y%m%dT%H%M%SZ)-$SLUG.md"
BRIEF=$(mktemp)
trap 'rm -f "$BRIEF"' EXIT

cat > "$BRIEF" <<B
You are the HUNTER in a fenced adversarial pass. Your only job: break this ONE claim.

CLAIM: $CLAIM

FENCE (all binding):
1. One claim. Attack only the claim above. No general review, no style notes, no other worries.
2. Fresh eyes. You did not write this code.
3. Read-only. Never edit, create or delete any file. Never run anything that changes state.
4. Evidence. Every finding needs file:line AND an exact reproduction (input or sequence of actions) that breaks the claim.
5. One round. Report once and stop.
6. Budget: about $BUDGET minutes of reading.
Scope: only these files (you may read files they import): $*

For each finding also answer: what sequence of REAL user or operator actions produces this? If none can, say "invented input".
If you cannot break the claim inside the fence, say exactly: CLAIM HOLDS, and list what you tried.

Return markdown:
## Findings
### F1 <title>
- Evidence: file:line
- Reproduction: ...
- Real path: ... | invented input
## Tried and held
- ...
B

{ echo "# Adversarial pass $(date -u +%Y-%m-%dT%H:%M:%SZ)"; echo "Claim: $CLAIM"; echo "Files: $*"
  echo "Dir: $CD"; echo "Engine: $ENGINE"; echo; } > "$OUT"

LIMIT=()
if command -v timeout >/dev/null; then LIMIT=(timeout $(( BUDGET * 60 + 300 )))
elif command -v gtimeout >/dev/null; then LIMIT=(gtimeout $(( BUDGET * 60 + 300 ))); fi

UNSET=(-u CLAUDECODE)
while IFS= read -r v; do UNSET+=(-u "$v"); done < <(env | grep -oE '^CTX_[A-Z0-9_]*' || true)

rc=0
if [[ -n "${OGL_HUNTER_CMD:-}" ]]; then
  (cd "$CD" && ${LIMIT[@]+"${LIMIT[@]}"} bash -c "$OGL_HUNTER_CMD" < "$BRIEF") >> "$OUT" 2>&1 || rc=$?
elif [[ "$ENGINE" == "codex" ]]; then
  ${LIMIT[@]+"${LIMIT[@]}"} codex exec --cd "$CD" -s read-only - < "$BRIEF" >> "$OUT" 2>&1 || rc=$?
else
  (cd "$CD" && ${LIMIT[@]+"${LIMIT[@]}"} env "${UNSET[@]}" claude -p --model "$ENGINE" --allowedTools "Read,Grep,Glob" \
     --setting-sources "" --strict-mcp-config --no-session-persistence < "$BRIEF") >> "$OUT" 2>&1 || rc=$?
fi
if [[ $rc -ne 0 ]]; then
  echo "" >> "$OUT"; echo "(engine exit $rc: this run is incomplete)" >> "$OUT"
  echo "$OUT"; exit 3
fi
echo "$OUT"

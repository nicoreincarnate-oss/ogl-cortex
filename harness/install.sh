#!/usr/bin/env bash
# OGL Cortex harness installer.
#
# Installs the guard hooks, memory hooks, skills and seat templates into ONE seat directory.
# Dry run by default: it prints what it would do and writes nothing. Pass --apply to write.
# Every existing file it would change is first copied to <file>.bak-<UTC timestamp>.
# It never touches ~/.claude unless you pass --user-level.
#
# Usage:
#   harness/install.sh <seat-dir> [options]
#
# Options:
#   --apply              write (default is a dry run)
#   --user-level         machine-wide guards go to ~/.claude instead of the seat, and the memory read-order
#                        block is merged into ~/.claude/CLAUDE.md
#   --with-digest        session digests: SessionEnd/PreCompact write-up into memory/digests/ plus a local index
#   --with-notes-recall  UserPromptSubmit hook that injects the top hits from the digest index (needs --with-digest)
#   --with-client-graph  client memory graph code and its UserPromptSubmit recall hook (you build graph.db yourself)
#
# Requires: bash, python3 (3.9+). No network access.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPLY=0
USER_LEVEL=0
WITH_DIGEST=0
WITH_RECALL=0
WITH_GRAPH=0
SEAT=""

usage() { sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'; }

for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --user-level) USER_LEVEL=1 ;;
    --with-digest) WITH_DIGEST=1 ;;
    --with-notes-recall) WITH_RECALL=1 ;;
    --with-client-graph) WITH_GRAPH=1 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "unknown option: $arg" >&2; usage >&2; exit 64 ;;
    *) if [[ -n "$SEAT" ]]; then echo "one seat directory only" >&2; exit 64; fi; SEAT="$arg" ;;
  esac
done

if [[ -z "$SEAT" ]]; then usage >&2; exit 64; fi
if [[ ! -d "$SEAT" ]]; then echo "seat directory not found: $SEAT" >&2; exit 66; fi
SEAT="$(cd "$SEAT" && pwd)"
if [[ "$SEAT" == "$HOME" || "$SEAT" == "$HOME/.claude" ]]; then
  echo "refusing to treat $SEAT as a seat; pass a seat directory (the folder that holds the seat's CLAUDE.md)" >&2
  exit 64
fi
if [[ $WITH_RECALL -eq 1 && $WITH_DIGEST -eq 0 ]]; then
  echo "--with-notes-recall needs --with-digest (it searches the digest index)" >&2
  exit 64
fi
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 69; }

SEAT_NAME="$(basename "$SEAT")"
ORG_DIR=""
ORG_NAME=""
if [[ "$(basename "$(dirname "$SEAT")")" == "agents" ]]; then
  ORG_DIR="$(dirname "$(dirname "$SEAT")")"
  ORG_NAME="$(basename "$ORG_DIR")"
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
MODE="DRY RUN (nothing written; add --apply)"
[[ $APPLY -eq 1 ]] && MODE="APPLY"
echo "OGL Cortex harness install: $MODE"
echo "  seat:       $SEAT"
echo "  org:        ${ORG_DIR:-(not under orgs/<org>/agents/; org files skipped)}"
echo "  user-level: $([[ $USER_LEVEL -eq 1 ]] && echo "yes (~/.claude)" || echo "no")"
echo "  optional:   digest=$WITH_DIGEST notes-recall=$WITH_RECALL client-graph=$WITH_GRAPH"
echo

CHANGED=0

# put SRC DEST: copy SRC to DEST, backing up DEST first if it exists and differs.
put() {
  local src="$1" dest="$2"
  if [[ -f "$dest" ]] && cmp -s "$src" "$dest"; then
    echo "  same     $dest"
    return
  fi
  if [[ -f "$dest" ]]; then
    echo "  update   $dest   (backup: $(basename "$dest").bak-$STAMP)"
  else
    echo "  create   $dest"
  fi
  CHANGED=$((CHANGED + 1))
  [[ $APPLY -eq 1 ]] || return 0
  mkdir -p "$(dirname "$dest")"
  [[ -f "$dest" ]] && cp -p "$dest" "$dest.bak-$STAMP"
  cp "$src" "$dest"
}

# keep SRC DEST: create DEST only if it does not exist (user-tuned config and seat files are never overwritten).
keep() {
  local src="$1" dest="$2"
  if [[ -e "$dest" ]]; then
    echo "  keep     $dest   (exists; left as is)"
    return
  fi
  put "$src" "$dest"
}

# ensure_dir DIR: create a folder if missing.
ensure_dir() {
  if [[ -d "$1" ]]; then echo "  same     $1/"; return; fi
  echo "  create   $1/"
  CHANGED=$((CHANGED + 1))
  [[ $APPLY -eq 1 ]] && mkdir -p "$1"
  return 0
}

# merge_block TEMPLATE TARGET NAME [FROM_HEADING]: keep the target's own text and add or refresh one marked block
#   <!-- OGL-CORTEX:BEGIN NAME --> ... <!-- OGL-CORTEX:END NAME -->
# taken from TEMPLATE. A missing target gets the whole template inside the block. An existing target gets the
# template from FROM_HEADING on (so the framework's own sections are not duplicated); a target that holds only
# our block keeps the whole template. Re-running replaces the block
# in place, so the result is the same however many times you run it. <seat> and <org> are filled in.
merge_block() {
  local template="$1" target="$2" name="$3" from="${4:-}" tmp rc=0
  tmp="$(mktemp)"
  python3 - "$template" "$target" "$name" "$from" "$SEAT_NAME" "$ORG_NAME" "$tmp" <<'PY' || rc=$?
import os, re, sys
template, target, name, start, seat, org, out = sys.argv[1:8]
text = open(template, encoding="utf-8").read()
cur = open(target, encoding="utf-8").read() if os.path.exists(target) else ""
pat = re.compile(r"<!-- OGL-CORTEX:BEGIN " + re.escape(name) + r"\b.*?-->.*?<!-- OGL-CORTEX:END " + re.escape(name) + r" -->\n?", re.S)
own_text = pat.sub("", cur).strip()   # the target's text outside our block
if own_text and start:
    i = text.find("\n" + start)
    if i < 0:
        print(f"  ERROR    heading {start!r} not in {template}", file=sys.stderr); sys.exit(3)
    text = text[i + 1:]
text = text.replace("<seat>", seat)
if org:
    text = text.replace("<org>", org)
begin = f"<!-- OGL-CORTEX:BEGIN {name} (managed by harness/install.sh; edit the harness template, not this block) -->"
end = f"<!-- OGL-CORTEX:END {name} -->"
block = f"{begin}\n{text.rstrip()}\n{end}\n"
if pat.search(cur):
    new = pat.sub(lambda m: block, cur, count=1)
elif cur:
    new = cur.rstrip("\n") + "\n\n" + block
else:
    new = block
if new == cur:
    sys.exit(10)
open(out, "w", encoding="utf-8").write(new)
PY
  if [[ $rc -eq 10 ]]; then
    echo "  same     $target   (block '$name' current)"
  elif [[ $rc -eq 0 ]]; then
    put "$tmp" "$target"
  else
    rm -f "$tmp"; exit "$rc"
  fi
  rm -f "$tmp"
}

HOOK_FILES=(ship_gate.py shared_surface_guard.py surface.py codewrites.py orwell_lint.py brief_guard.py future_time_guard.py)
COMPACTION_FILES=(common.py meter.py after_compact.py save_summary.py)
MEMORY_HOOK_FILES=(transcript.py precompact_checkpoint.py sessionstart_inject.py session_facts.py)
DIGEST_FILES=(digest/common.py digest/session_end.py digest/headless_run.py digest/session_start.py digest/digest-prompt.md
              index/build_index.py index/search.py index/distil.py index/distil-prompt.md index/recall_hook.py requirements.txt)
GRAPH_FILES=(schema.sql build_graph.py recall.py recall_hook.py evals.py config.example.json)
MACHINE_WIDE="ship_gate.py shared_surface_guard.py orwell_lint.py"
MEMDEST="$SEAT/.claude/hooks/ogl/memory"

install_hooks() {
  local dest="$1"
  for f in "${HOOK_FILES[@]}"; do put "$HERE/hooks/$f" "$dest/$f"; done
  for f in "${COMPACTION_FILES[@]}"; do put "$HERE/hooks/compaction/$f" "$dest/compaction/$f"; done
  keep "$HERE/hooks/compaction/compaction.json" "$dest/compaction/compaction.json"
}

# merge_settings SOURCE TARGET PREFIX SELECT: merge hook entries (and autoCompactWindow, if missing) from SOURCE.
#   PREFIX replaces "$CLAUDE_PROJECT_DIR"/.claude/hooks/ogl in each command.
#   SELECT is "all", "machine" (machine-wide guards only) or "seat" (everything except machine-wide guards).
merge_settings() {
  local source="$1" target="$2" prefix="$3" select="$4" tmp
  tmp="$(mktemp)"
  local rc=0
  python3 - "$source" "$target" "$prefix" "$select" "$MACHINE_WIDE" "$tmp" <<'PY' || rc=$?
import json, os, sys
example, target, prefix, select, machine, out = sys.argv[1:7]
machine = machine.split()
doc = json.load(open(example))
src = doc["hooks"]
try:
    cur = json.load(open(target)) if os.path.exists(target) else {}
except ValueError:
    print(f"  ERROR    {target} is not valid JSON; fix it first", file=sys.stderr); sys.exit(3)
hooks = cur.setdefault("hooks", {})
have = {h.get("command") for groups in hooks.values() for g in groups for h in g.get("hooks", [])}
added = 0
for event, groups in src.items():
    for g in groups:
        keep = []
        for h in g["hooks"]:
            is_machine = any(m in h["command"] for m in machine)
            if (select == "machine" and not is_machine) or (select == "seat" and is_machine):
                continue
            h = dict(h, command=h["command"].replace('"$CLAUDE_PROJECT_DIR"/.claude/hooks/ogl', prefix))
            if h["command"] in have:
                continue
            keep.append(h)
        if keep:
            hooks.setdefault(event, []).append(dict(g, hooks=keep))
            for h in keep:
                print(f"           + {event} [{g.get('matcher', '*')}] {h['command']}")
            added += len(keep)
if select != "machine" and "autoCompactWindow" in doc and "autoCompactWindow" not in cur:
    cur["autoCompactWindow"] = doc["autoCompactWindow"]
    print(f"           + autoCompactWindow {doc['autoCompactWindow']}")
    added += 1
json.dump(cur, open(out, "w"), indent=2)
open(out, "a").write("\n")
sys.exit(0 if added else 10)
PY
  if [[ $rc -eq 10 ]]; then
    echo "  same     $target   (all entries from $(basename "$(dirname "$source")")/$(basename "$source") already present)"
  elif [[ $rc -eq 0 ]]; then
    put "$tmp" "$target"
  else
    rm -f "$tmp"; exit "$rc"
  fi
  rm -f "$tmp"
}

echo "Hooks"
install_hooks "$SEAT/.claude/hooks/ogl"
for f in "${MEMORY_HOOK_FILES[@]}"; do put "$HERE/hooks/memory/$f" "$MEMDEST/$f"; done
if [[ $USER_LEVEL -eq 1 ]]; then
  install_hooks "$HOME/.claude/hooks/ogl"
fi
echo

if [[ $WITH_DIGEST -eq 1 ]]; then
  echo "Session digest (memory/digests/ + local index)"
  for f in "${DIGEST_FILES[@]}"; do put "$HERE/memory/session-digest/$f" "$MEMDEST/session-digest/$f"; done
  keep "$HERE/memory/session-digest/digest/config.json" "$MEMDEST/session-digest/digest/config.json"
  echo
fi
if [[ $WITH_GRAPH -eq 1 ]]; then
  echo "Client memory graph (code only; graph.db is built by you and never shipped)"
  for f in "${GRAPH_FILES[@]}"; do put "$HERE/memory/client-graph/$f" "$MEMDEST/client-graph/$f"; done
  echo
fi

echo "Settings"
SEAT_SETTINGS="$SEAT/.claude/settings.json"
if [[ $USER_LEVEL -eq 1 ]]; then
  merge_settings "$HERE/settings.example.json" "$SEAT_SETTINGS" '"$CLAUDE_PROJECT_DIR"/.claude/hooks/ogl' seat
  merge_settings "$HERE/settings.example.json" "$HOME/.claude/settings.json" '"$HOME"/.claude/hooks/ogl' machine
else
  merge_settings "$HERE/settings.example.json" "$SEAT_SETTINGS" '"$CLAUDE_PROJECT_DIR"/.claude/hooks/ogl' all
fi
# On a dry run the seat settings are not written, so later merges read the original file; the printed
# "+" lines still show every entry that --apply would add.
[[ $WITH_DIGEST -eq 1 ]] && merge_settings "$HERE/memory/session-digest/hooks.json" "$SEAT_SETTINGS" '"$CLAUDE_PROJECT_DIR"/.claude/hooks/ogl' all
[[ $WITH_RECALL -eq 1 ]] && merge_settings "$HERE/memory/session-digest/hooks.recall.json" "$SEAT_SETTINGS" '"$CLAUDE_PROJECT_DIR"/.claude/hooks/ogl' all
[[ $WITH_GRAPH -eq 1 ]] && merge_settings "$HERE/memory/client-graph/hooks.json" "$SEAT_SETTINGS" '"$CLAUDE_PROJECT_DIR"/.claude/hooks/ogl' all
echo

echo "Skills"
for d in "$HERE"/skills/*/; do
  name="$(basename "$d")"
  put "$d/SKILL.md" "$SEAT/.claude/skills/$name/SKILL.md"
done
echo

echo "Seat templates"
merge_block "$HERE/templates/CLAUDE.md" "$SEAT/CLAUDE.md" seat-rules "## Session start"
merge_block "$HERE/templates/GUARDRAILS.md" "$SEAT/GUARDRAILS.md" seat-gates "## Named gates"
merge_block "$HERE/templates/HEARTBEAT.md" "$SEAT/HEARTBEAT.md" memory-steps "## OGL Cortex memory steps"
keep "$HERE/templates/STATE.md" "$SEAT/STATE.md"
keep "$HERE/templates/ENTITIES.md" "$SEAT/ENTITIES.md"
keep "$HERE/templates/MEMORY.md" "$SEAT/MEMORY.md"
ensure_dir "$SEAT/memory"
echo

if [[ -n "$ORG_DIR" ]]; then
  echo "Org templates ($ORG_NAME)"
  merge_block "$HERE/templates/org-GUARDRAILS.md" "$ORG_DIR/GUARDRAILS.md" cardinal-rule "## Cardinal rule"
  merge_block "$HERE/templates/org-knowledge.md" "$ORG_DIR/knowledge.md" fleet-rules "## Cardinal rules"
  echo
fi

if [[ $USER_LEVEL -eq 1 ]]; then
  echo "User-level memory read order"
  merge_block "$HERE/templates/user-CLAUDE.md" "$HOME/.claude/CLAUDE.md" memory-read-order "## Memory read order"
  echo
fi

if [[ $APPLY -eq 1 ]]; then
  echo "Done: $CHANGED change(s) written. Backups end in .bak-$STAMP."
  echo "Check: python3 \"$SEAT/.claude/hooks/ogl/shared_surface_guard.py\" --selftest"
  if [[ $WITH_DIGEST -eq 1 ]]; then
    echo "Digest index: CLAUDE_PROJECT_DIR=\"$SEAT\" python3 \"$MEMDEST/session-digest/index/build_index.py\""
  fi
  if [[ $WITH_GRAPH -eq 1 ]]; then
    echo "Client graph: copy $MEMDEST/client-graph/config.example.json to graph.config.json, fill it in, then"
    echo "  python3 \"$MEMDEST/client-graph/build_graph.py\" all --config \"$MEMDEST/client-graph/graph.config.json\""
  fi
  echo "Restart the seat's Claude Code session so it loads the new hooks."
else
  echo "Dry run: $CHANGED change(s) would be made. Re-run with --apply to write them."
fi

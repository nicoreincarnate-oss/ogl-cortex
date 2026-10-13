#!/usr/bin/env bash
# OGL Cortex harness installer.
#
# Installs the guard hooks, example skills and seat templates into ONE seat directory.
# Dry run by default: it prints what it would do and writes nothing. Pass --apply to write.
# Every existing file it would change is first copied to <file>.bak-<UTC timestamp>.
# It never touches ~/.claude unless you pass --user-level.
#
# Usage:
#   harness/install.sh <seat-dir>                      # dry run
#   harness/install.sh <seat-dir> --apply              # install into the seat
#   harness/install.sh <seat-dir> --apply --user-level # machine-wide guards go to ~/.claude instead of the seat
#
# Requires: bash, python3 (3.9+). No network access.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPLY=0
USER_LEVEL=0
SEAT=""

usage() { sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; }

for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --user-level) USER_LEVEL=1 ;;
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
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 69; }

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
MODE="DRY RUN (nothing written; add --apply)"
[[ $APPLY -eq 1 ]] && MODE="APPLY"
echo "OGL Cortex harness install: $MODE"
echo "  seat:       $SEAT"
echo "  user-level: $([[ $USER_LEVEL -eq 1 ]] && echo "yes (~/.claude)" || echo "no")"
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

HOOK_FILES=(ship_gate.py shared_surface_guard.py surface.py codewrites.py orwell_lint.py brief_guard.py future_time_guard.py)
COMPACTION_FILES=(common.py meter.py after_compact.py save_summary.py)
MACHINE_WIDE="ship_gate.py shared_surface_guard.py orwell_lint.py"

install_hooks() {
  local dest="$1"
  for f in "${HOOK_FILES[@]}"; do put "$HERE/hooks/$f" "$dest/$f"; done
  for f in "${COMPACTION_FILES[@]}"; do put "$HERE/hooks/compaction/$f" "$dest/compaction/$f"; done
  keep "$HERE/hooks/compaction/compaction.json" "$dest/compaction/compaction.json"
}

# merge_settings TARGET PREFIX SELECT: merge hook entries from settings.example.json into TARGET.
#   PREFIX replaces "$CLAUDE_PROJECT_DIR"/.claude/hooks/ogl in each command.
#   SELECT is "all", "machine" (machine-wide guards only) or "seat" (everything except machine-wide guards).
merge_settings() {
  local target="$1" prefix="$2" select="$3" tmp
  tmp="$(mktemp)"
  local rc=0
  python3 - "$HERE/settings.example.json" "$target" "$prefix" "$select" "$MACHINE_WIDE" "$tmp" <<'PY' || rc=$?
import json, os, sys
example, target, prefix, select, machine, out = sys.argv[1:7]
machine = machine.split()
src = json.load(open(example))["hooks"]
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
json.dump(cur, open(out, "w"), indent=2)
open(out, "a").write("\n")
sys.exit(0 if added else 10)
PY
  if [[ $rc -eq 10 ]]; then
    echo "  same     $target   (all hook entries already present)"
  elif [[ $rc -eq 0 ]]; then
    put "$tmp" "$target"
  else
    rm -f "$tmp"; exit "$rc"
  fi
  rm -f "$tmp"
}

echo "Hooks"
install_hooks "$SEAT/.claude/hooks/ogl"
if [[ $USER_LEVEL -eq 1 ]]; then
  install_hooks "$HOME/.claude/hooks/ogl"
fi
echo

echo "Settings"
if [[ $USER_LEVEL -eq 1 ]]; then
  merge_settings "$SEAT/.claude/settings.json" '"$CLAUDE_PROJECT_DIR"/.claude/hooks/ogl' seat
  merge_settings "$HOME/.claude/settings.json" '"$HOME"/.claude/hooks/ogl' machine
else
  merge_settings "$SEAT/.claude/settings.json" '"$CLAUDE_PROJECT_DIR"/.claude/hooks/ogl' all
fi
echo

echo "Skills"
for d in "$HERE"/skills/*/; do
  name="$(basename "$d")"
  put "$d/SKILL.md" "$SEAT/.claude/skills/$name/SKILL.md"
done
echo

echo "Seat templates"
if [[ -e "$SEAT/CLAUDE.md" ]]; then
  echo "  keep     $SEAT/CLAUDE.md   (exists; template written beside it to merge by hand)"
  put "$HERE/templates/CLAUDE.md" "$SEAT/CLAUDE.ogl-template.md"
else
  put "$HERE/templates/CLAUDE.md" "$SEAT/CLAUDE.md"
fi
keep "$HERE/templates/STATE.md" "$SEAT/STATE.md"
echo

if [[ $APPLY -eq 1 ]]; then
  echo "Done: $CHANGED file(s) written. Backups end in .bak-$STAMP."
  echo "Check: python3 \"$SEAT/.claude/hooks/ogl/shared_surface_guard.py\" --selftest"
  echo "Restart the seat's Claude Code session so it loads the new hooks."
else
  echo "Dry run: $CHANGED file(s) would change. Re-run with --apply to write them."
fi

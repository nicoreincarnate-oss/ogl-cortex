#!/usr/bin/env python3
# OGL Cortex client memory graph. Method from Glitch Cat Club's graph memory starter. See harness/README.md (Licences).
"""Known-answer checks for a client graph. Write the answers from the sources BEFORE you look at recall output.

    python3 evals.py --cases cases.json [--db graph.db]

cases.json: [{"q": "question", "must": ["text that must appear"], "must_not": ["text that must not"],
              "uncut": false}]   "uncut": true checks the full answer instead of the newest 20 facts.
Exit 1 on any failure.
"""
import argparse, json, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import recall  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cases", required=True)
    ap.add_argument("--db", default=str(recall.DB))
    a = ap.parse_args()
    cases = json.loads(Path(a.cases).read_text(encoding="utf-8"))
    fails = 0
    for c in cases:
        out = recall.as_text(c["q"], limit=None if c.get("uncut") else 20, db_path=a.db).lower()
        miss = [m for m in c.get("must", []) if m.lower() not in out]
        bad = [m for m in c.get("must_not", []) if m.lower() in out]
        ok = not miss and not bad
        fails += not ok
        print(("PASS " if ok else "FAIL ") + c["q"] + ("" if ok else f"  missing={miss} unwanted={bad}"))
    print(f"\n{len(cases) - fails}/{len(cases)} checks pass")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())

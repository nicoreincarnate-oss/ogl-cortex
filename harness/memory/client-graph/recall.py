#!/usr/bin/env python3
# OGL Cortex client memory graph. Method from Glitch Cat Club's graph memory starter. See harness/README.md (Licences).
"""Recall from the client graph: seed entities from the question, walk k hops, return dated facts with quotes.

Pure SQLite, no model call. This is what the UserPromptSubmit hook runs before the model reads the prompt.

    python3 recall.py [--db graph.db] "what is <client> upset about?"
"""
import json, os, re, sqlite3, sys, time
from pathlib import Path

DB = Path(os.environ.get("OGL_CLIENT_GRAPH_DB") or Path(__file__).resolve().parent / "graph.db")

WALK = """
WITH RECURSIVE walk(entity_id, depth) AS (
  SELECT id, 0 FROM entities WHERE id IN ({seeds})
  UNION
  SELECT CASE WHEN r.source_id = w.entity_id THEN r.target_id ELSE r.source_id END, w.depth + 1
  FROM relations r JOIN walk w ON w.entity_id IN (r.source_id, r.target_id)
  WHERE w.depth < ?
)
SELECT e1.name, e1.type, r.predicate, e2.name, e2.type, r.source, r.date, r.quote
FROM relations r
JOIN entities e1 ON e1.id = r.source_id
JOIN entities e2 ON e2.id = r.target_id
WHERE r.source_id IN (SELECT entity_id FROM walk) AND r.target_id IN (SELECT entity_id FROM walk)
"""

# question words -> predicates the answer must use (empty = any)
INTENT = [
    (r"\b(mad|angry|upset|complain\w*|annoyed|frustrat\w*|problem)", {"complained_about", "mood"}),
    (r"\b(mood|feel\w*|happy|unhappy)", {"mood", "praised", "complained_about"}),
    (r"\b(dislike|hate|reject\w*|remove|never|don'?t like)", {"rejected", "never_do", "complained_about"}),
    (r"\b(like|love|enjoy|praise\w*|prefer\w*)", {"praised", "prefers"}),
    (r"\b(deliver(ed|y)?|what (have|did) we (do|done|make|made|build|built|send|sent))\b", {"delivered_to"}),
    (r"\b(owe|due|deadline|promise\w*)", {"owed_to", "due_on"}),
    (r"\b(decid\w*|decision)", {"decided"}),
    (r"\b(who owns|owner|who runs|founder)", {"owns", "decides_for"}),
]
SIGNAL_PREDS = {"praised", "rejected", "complained_about", "mood", "prefers", "never_do", "decided"}


def meta(db, key, default):
    try:
        row = db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else default
    except (sqlite3.Error, ValueError):
        return default


def seeds(db, q):
    """Client and person ids the question names. The operator, own seats and generic words never seed."""
    ql = q.lower()
    no_seed = set(meta(db, "no_seed", []))
    own_names = [n.lower() for n in meta(db, "own_names", [])]
    own = {eid for (eid, name) in db.execute("SELECT id, lower(name) FROM entities") if name in own_names}
    rows = list(db.execute("SELECT id, name FROM entities WHERE type IN ('CLIENT','PERSON')"))
    rows += list(db.execute("SELECT a.entity_id, a.alias FROM aliases a JOIN entities e ON e.id = a.entity_id "
                            "WHERE e.type IN ('CLIENT','PERSON')"))
    return list({eid for eid, t in rows if t and len(t) > 3 and t.lower().strip() not in no_seed and eid not in own
                 and re.search(rf"\b{re.escape(t.lower())}\b", ql)})


def recall(q, hops=2, limit=20, db_path=None):
    t0 = time.perf_counter()
    db = sqlite3.connect(str(db_path or DB))
    s = seeds(db, q)
    words = re.sub(r"\S*[/\\]\S*", " ", q)  # paths and URLs are not words of the question
    hits = [p for rx, p in INTENT if re.search(rx, words, re.I)]
    want = set().union(*hits) if hits else set()
    recall.total = 0
    if not s:
        return [], want, (time.perf_counter() - t0) * 1000
    rows = db.execute(WALK.format(seeds=",".join("?" * len(s))), (*s, hops)).fetchall()
    if want:
        rows = [r for r in rows if r[2] in want]
    # a view belongs to whoever holds it: if the question names people, keep only their own signals
    people = {n for (n,) in db.execute(f"SELECT name FROM entities WHERE type='PERSON' AND id IN ({','.join('?' * len(s))})", s)}
    if people:
        rows = [r for r in rows if r[2] not in SIGNAL_PREDS or r[0] in people]
    rows.sort(key=lambda r: (r[6] or ""), reverse=True)
    recall.total = len(rows)
    db.close()
    return (rows if limit is None else rows[:limit]), want, (time.perf_counter() - t0) * 1000


def as_text(q, limit=20, db_path=None):
    rows, want, ms = recall(q, limit=limit, db_path=db_path)
    cut = f", showing the {len(rows)} newest of {recall.total}" if recall.total > len(rows) else ""
    head = f"memory: {len(rows)} facts in {ms:.0f} ms{cut}" + (f" (looking for: {', '.join(sorted(want))})" if want else "")
    if not rows:
        return head + "\n(no memory matches for this question)"
    lines = []
    for a, at, p, b, bt, src, date, quote in rows:
        lines.append(f"- {a} --[{p}]--> {b}  ({date or 'undated'}; {src})" + (f'\n    "{quote}"' if quote else ""))
    return head + "\n" + "\n".join(lines)


if __name__ == "__main__":
    args = sys.argv[1:]
    path = None
    if args[:1] == ["--db"] and len(args) > 1:
        path, args = args[1], args[2:]
    if not args:
        sys.exit('usage: python3 recall.py [--db graph.db] "question"')
    print(as_text(" ".join(args), db_path=path))

# OGL Cortex session digest. Pattern adapted from Glitch Cat Club's memory starter. See harness/README.md (Licences).
"""Build the index: chunk markdown on headings, index keywords and meaning.

    python3 build_index.py [--corpus <notes folder>] [--db <file>] [--update <rel> ...]

Reads the notes folder (default: $CLAUDE_PROJECT_DIR/memory, else ./memory), plus any distilled
entries in distilled/. Subfolders are included, so the digests/ folder is indexed like any note.
Writes index.db next to this script. Run again any time; the files stay the truth and the index
is disposable. Without fastembed installed the index is keyword-only and says so.
"""

import argparse
import os
import re
import sqlite3
import struct
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
DB = HERE / "index.db"
CHUNK_BUDGET = 1600  # characters, roughly 400 tokens
SKIP_DIRS = {".git", "node_modules", "__pycache__", "archive", "checkpoints"}  # archive and checkpoints copy live notes

SCHEMA = """
DROP TABLE IF EXISTS chunks;
DROP TABLE IF EXISTS chunks_fts;
DROP TABLE IF EXISTS vectors;
DROP TABLE IF EXISTS meta;
CREATE TABLE chunks (
    id INTEGER PRIMARY KEY,
    file TEXT NOT NULL,
    section TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    text TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'chunk'
);
CREATE VIRTUAL TABLE chunks_fts USING fts5(text, file, section);
CREATE TABLE vectors (id INTEGER PRIMARY KEY, vec BLOB NOT NULL);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""


def note_files(corpus):
    """Every markdown file under the corpus, subfolders included.

    Skipped: hidden files and folders, .git, node_modules, __pycache__, and
    this starter's own folder when it has been cloned inside the notes.
    """
    root = Path(corpus).resolve()
    starter = HERE.parent.resolve()
    # the starter is skipped only when it sits INSIDE your notes, which is the
    # case the rule exists for. A corpus inside the starter is the bundled demo
    # folders, and those are meant to be indexed.
    skip_starter = starter != root and root in starter.parents
    out = []
    for path in sorted(root.rglob("*.md")):
        rel = path.relative_to(root)
        if any(part.startswith(".") or part in SKIP_DIRS for part in rel.parts):
            continue
        if skip_starter and (starter == path.parent or starter in path.parents):
            continue
        out.append(path)
    return out


def sections(lines):
    """Split markdown lines into (heading, start, end) sections."""
    out = []
    heading, start = None, 0
    for i, line in enumerate(lines):
        if re.match(r"^#{1,3} ", line):
            if i > start or heading is not None:
                out.append((heading, start, i))
            heading, start = line.lstrip("# ").strip(), i
    out.append((heading, start, len(lines)))
    return [(h, s, e) for h, s, e in out if any(l.strip() for l in lines[s:e])]


def chunk_file(path):
    """Yield (section, start_line, end_line, text) chunks packed to the budget."""
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    packed = []
    for heading, s, e in sections(lines):
        text = "\n".join(lines[s:e]).strip()
        title = heading or path.stem
        if len(text) <= CHUNK_BUDGET:
            packed.append((title, s + 1, e, text))
            continue
        # oversized section: split on line groups within the budget
        buf, buf_start = [], s
        for i in range(s, e):
            buf.append(lines[i])
            if sum(len(l) + 1 for l in buf) >= CHUNK_BUDGET:
                packed.append((title, buf_start + 1, i + 1, "\n".join(buf).strip()))
                buf, buf_start = [], i + 1
        if any(l.strip() for l in buf):
            packed.append((title, buf_start + 1, e, "\n".join(buf).strip()))
    return packed


def parse_entry(text):
    """Read a distilled entry: source, questions, summary, rule, quote.

    distil.py checks its own output through this, so the writer and the reader
    can never drift into two spellings of the format.
    """
    entry = {"questions": []}
    for line in text.splitlines():
        if line.startswith("source:"):
            entry["source"] = line.split(":", 1)[1].strip()
        elif line.startswith("- ") and line.rstrip().endswith("?"):
            # only questions; the model sometimes adds "- **note:** ..." lines
            entry["questions"].append(line[2:].strip())
        elif line.startswith("summary:"):
            entry["summary"] = line.split(":", 1)[1].strip()
        elif line.startswith("rule:"):
            entry["rule"] = line.split(":", 1)[1].strip()
        elif line.startswith("quote:"):
            entry["quote"] = line.split(":", 1)[1].strip().strip('"')
    return entry


def parse_distilled(path):
    """Read a distilled entry from a file."""
    return parse_entry(path.read_text(encoding="utf-8", errors="replace"))


def normalise(text):
    return " ".join(text.split())


def utf8_out():
    """Write UTF-8 whatever the console's code page is.

    Windows consoles default to cp1252, which cannot encode an arrow, a curly
    quote or a pound sign, and file names and notes are full of them.
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass


def file_docs(path, rel):
    """(embed_text, row) for every chunk of one note."""
    return [(f"[{rel} § {section}]\n" + text, (rel, section, s, e, text, "chunk"))
            for section, s, e, text in chunk_file(path)]


def distilled_docs(corpus, only_sources=None):
    """(embed_text, row) for distilled entries whose quote checks out; and the drop count."""
    docs, dropped = [], 0
    distilled_dir = HERE / "distilled"
    for path in sorted(distilled_dir.glob("*.md")) if distilled_dir.is_dir() else []:
        entry = parse_distilled(path)
        if only_sources is not None and entry.get("source") not in only_sources:
            continue
        source = corpus / entry.get("source", "")
        quote = entry.get("quote", "")
        # grounding check: the quote must appear in the source, word for word
        if not source.is_file() or normalise(quote) not in normalise(source.read_text(encoding="utf-8", errors="replace")):
            dropped += 1
            print(f"dropped {path.name}: quote not found in {entry.get('source', '?')}")
            continue
        body = "\n".join(entry["questions"] + [entry.get("summary", ""), entry.get("rule", ""), quote]).strip()
        docs.append((f"[{entry['source']} § distilled]\n" + body, (entry["source"], "distilled", 0, 0, body, "distilled")))
    return docs, dropped


def insert(db, docs):
    """Insert rows, keyword index and vectors. Vectors key on the real row id."""
    ids = []
    for embed_text, row in docs:
        cur = db.execute("INSERT INTO chunks (file, section, start_line, end_line, text, kind) VALUES (?,?,?,?,?,?)", row)
        db.execute("INSERT INTO chunks_fts (rowid, text, file, section) VALUES (?,?,?,?)", (cur.lastrowid, embed_text, row[0], row[1]))
        ids.append(cur.lastrowid)
    if not docs:
        return "nothing to index"
    try:
        from fastembed import TextEmbedding
    except ImportError:
        return "keyword only (pip install fastembed for the meaning leg)"
    model = TextEmbedding()  # default: BAAI/bge-small-en-v1.5
    vecs = list(model.embed([t for t, _ in docs]))
    for rowid, vec in zip(ids, vecs):
        norm = sum(x * x for x in vec) ** 0.5 or 1.0
        db.execute("INSERT INTO vectors (id, vec) VALUES (?,?)", (rowid, struct.pack(f"{len(vec)}f", *(x / norm for x in vec))))
    return f"model {model.model_name} ({len(vecs[0])}d) + keyword sqlite fts5"


def update(db, corpus, rels):
    """Re-index only these notes. A full build of a large folder takes minutes;
    one digest file takes seconds."""
    for rel in rels:
        ids = [r[0] for r in db.execute("SELECT id FROM chunks WHERE file=?", (rel,))]
        for i in ids:
            db.execute("DELETE FROM chunks_fts WHERE rowid=?", (i,))
            db.execute("DELETE FROM vectors WHERE id=?", (i,))
        db.execute("DELETE FROM chunks WHERE file=?", (rel,))
    docs = []
    for rel in rels:
        path = corpus / rel
        if path.is_file():
            docs += file_docs(path, rel)
    extra, dropped = distilled_docs(corpus, set(rels))
    line = insert(db, docs + extra)
    print(f"updated {len(rels)} files, {len(docs)} chunks, {len(extra)} distilled, {dropped} dropped; {line}")


def main():
    utf8_out()
    ap = argparse.ArgumentParser()
    seat = os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    ap.add_argument("--corpus", default=str(Path(seat) / "memory"), help="notes folder (default: <seat>/memory)")
    ap.add_argument("--db", default=str(DB))
    ap.add_argument("--update", nargs="+", metavar="REL", help="re-index only these notes (paths relative to the corpus)")
    args = ap.parse_args()
    corpus = Path(args.corpus).resolve()
    if not corpus.is_dir():
        sys.exit(f"not a folder: {corpus}")

    db = sqlite3.connect(args.db)
    if args.update and db.execute("SELECT name FROM sqlite_master WHERE name='chunks'").fetchone():
        update(db, corpus, args.update)
        db.commit()
        db.close()
        return
    db.executescript(SCHEMA)
    db.execute("INSERT INTO meta VALUES ('corpus', ?)", (str(corpus),))
    files = note_files(corpus)
    docs = []
    for path in files:
        docs += file_docs(path, path.relative_to(corpus).as_posix())
    extra, dropped = distilled_docs(corpus)
    model_line = insert(db, docs + extra)
    db.commit()
    db.close()
    print(f"indexed {len(files)} files, {len(docs)} chunks, {len(extra)} distilled entries, {dropped} dropped")
    print(model_line)


if __name__ == "__main__":
    main()

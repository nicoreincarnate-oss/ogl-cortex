#!/usr/bin/env python3
"""Build a link graph from a markdown vault, with no model and no dependencies.

    python3 vault_graph.py <vault> [--out <vault>/graphify-out/graph.json]

One node per note (id = path inside the vault, label = title), one edge per resolved [[wikilink]] (relation
"links_to"), and one edge per shared #tag or frontmatter tag (relation "tagged", through a tag node). The output
uses the same node-link JSON shape as graphify (`nodes`, `links`, each link with `source`, `target`,
`relation`), so graph_mcp.py and neo4j_load.py read either file. Use graphify when you want model-extracted
concepts and communities; use this when you want the explicit links only, fast and free.
Hidden folders, .git, node_modules and graphify-out are skipped.
"""
import argparse, json, re, sys
from pathlib import Path

SKIP = {".git", ".obsidian", ".trash", "node_modules", "graphify-out", "__pycache__"}
LINK = re.compile(r"\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]")
TAG = re.compile(r"(?<![\w/#])#([A-Za-z][\w/-]{1,40})")


def notes(root):
    for p in sorted(root.rglob("*.md")):
        rel = p.relative_to(root)
        if any(part.startswith(".") or part in SKIP for part in rel.parts):
            continue
        yield p, rel.as_posix()


def frontmatter(text):
    if not text.startswith("---\n"):
        return {}, text
    end = text.find("\n---", 4)
    if end < 0:
        return {}, text
    meta = {}
    key = None
    for line in text[4:end].splitlines():
        m = re.match(r"^([A-Za-z_][\w-]*):\s*(.*)$", line)
        if m:
            key, val = m.group(1), m.group(2).strip()
            meta[key] = [v.strip(" '\"") for v in val.strip("[]").split(",") if v.strip()] if val else []
        elif key and line.strip().startswith("- "):
            meta.setdefault(key, []).append(line.strip()[2:].strip(" '\""))
    return meta, text[end + 4:]


def build(root):
    files = list(notes(root))
    by_stem, by_path = {}, {}
    for _, rel in files:
        by_path[rel[:-3].lower()] = rel
        by_stem.setdefault(Path(rel).stem.lower(), rel)
    nodes, links, tags = {}, [], {}
    for path, rel in files:
        text = path.read_text(encoding="utf-8", errors="replace")
        meta, body = frontmatter(text)
        title = (meta.get("title") or [None])[0] or next((l[2:].strip() for l in body.splitlines() if l.startswith("# ")), Path(rel).stem)
        nodes[rel] = {"id": rel, "label": title, "file_type": "note", "source_file": rel, "community": None}
        for target in LINK.findall(body):
            t = target.strip().lower()
            hit = by_path.get(t) or by_path.get(t.removesuffix(".md")) or by_stem.get(Path(t).stem)
            if hit and hit != rel:
                links.append({"source": rel, "target": hit, "relation": "links_to", "confidence": "EXTRACTED", "source_file": rel})
        found = set(TAG.findall(body)) | set(meta.get("tags", []))
        for tag in sorted(found):
            tid = f"tag:{tag.lower()}"
            tags.setdefault(tid, {"id": tid, "label": f"#{tag}", "file_type": "tag", "source_file": "", "community": None})
            links.append({"source": rel, "target": tid, "relation": "tagged", "confidence": "EXTRACTED", "source_file": rel})
    seen, uniq = set(), []
    for l in links:
        key = (l["source"], l["target"], l["relation"])
        if key not in seen:
            seen.add(key)
            uniq.append(l)
    return {"directed": False, "multigraph": False, "graph": {"builder": "vault_graph.py"},
            "nodes": list(nodes.values()) + list(tags.values()), "links": uniq}


def main():
    ap = argparse.ArgumentParser(description="Build a link graph from a markdown vault.")
    ap.add_argument("vault")
    ap.add_argument("--out")
    a = ap.parse_args()
    root = Path(a.vault).expanduser().resolve()
    if not root.is_dir():
        sys.exit(f"not a folder: {root}")
    out = Path(a.out) if a.out else root / "graphify-out" / "graph.json"
    g = build(root)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(g, indent=1), encoding="utf-8")
    print(f"wrote {out}: {len(g['nodes'])} nodes, {len(g['links'])} links")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Load a graph.json (graphify or vault_graph.py output) into Neo4j, replacing the previous load.

    python3 neo4j_load.py <graph.json> [--uri bolt://127.0.0.1:7687] [--user neo4j] [--dry-run]

The password comes from NEO4J_PASSWORD (never a flag, so it stays out of shell history and process lists).
Nodes become (:Note {id, label, file_type, source_file, community}); links become [:LINK {relation}].
Needs the `neo4j` Python driver (pip install neo4j) unless --dry-run, which prints the Cypher and parameters
it would run and connects to nothing.
"""
import argparse, json, os, sys
from pathlib import Path

BATCH = 500
STATEMENTS = [
    ("CREATE CONSTRAINT note_id IF NOT EXISTS FOR (n:Note) REQUIRE n.id IS UNIQUE", None),
    ("MATCH (n:Note) DETACH DELETE n", None),
]
NODE_CYPHER = ("UNWIND $rows AS r MERGE (n:Note {id: r.id}) "
               "SET n.label = r.label, n.file_type = r.file_type, n.source_file = r.source_file, n.community = r.community")
LINK_CYPHER = ("UNWIND $rows AS r MATCH (a:Note {id: r.source}) MATCH (b:Note {id: r.target}) "
               "MERGE (a)-[l:LINK {relation: r.relation}]->(b)")


def plan(g):
    nodes = [{"id": str(n["id"]), "label": str(n.get("label") or n["id"]), "file_type": n.get("file_type"),
              "source_file": n.get("source_file"), "community": n.get("community")} for n in g.get("nodes", []) if "id" in n]
    ids = {n["id"] for n in nodes}
    links = [{"source": str(l["source"]), "target": str(l["target"]), "relation": str(l.get("relation") or "related")}
             for l in g.get("links", g.get("edges", [])) if str(l.get("source")) in ids and str(l.get("target")) in ids]
    steps = list(STATEMENTS)
    steps += [(NODE_CYPHER, nodes[i:i + BATCH]) for i in range(0, len(nodes), BATCH)]
    steps += [(LINK_CYPHER, links[i:i + BATCH]) for i in range(0, len(links), BATCH)]
    return steps, len(nodes), len(links)


def main():
    ap = argparse.ArgumentParser(description="Load graph.json into Neo4j.")
    ap.add_argument("graph")
    ap.add_argument("--uri", default=os.environ.get("NEO4J_URI", "bolt://127.0.0.1:7687"))
    ap.add_argument("--user", default=os.environ.get("NEO4J_USER", "neo4j"))
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    g = json.loads(Path(a.graph).read_text(encoding="utf-8"))
    steps, n_nodes, n_links = plan(g)
    if a.dry_run:
        for cypher, rows in steps:
            print(json.dumps({"cypher": cypher, "rows": len(rows) if rows is not None else 0}))
        print(f"dry run: {n_nodes} nodes, {n_links} links, {len(steps)} statements")
        return
    password = os.environ.get("NEO4J_PASSWORD")
    if not password:
        sys.exit("set NEO4J_PASSWORD")
    try:
        from neo4j import GraphDatabase
    except ImportError:
        sys.exit("pip install neo4j (or use --dry-run)")
    with GraphDatabase.driver(a.uri, auth=(a.user, password)) as driver:
        with driver.session() as s:
            for cypher, rows in steps:
                s.run(cypher, rows=rows) if rows is not None else s.run(cypher)
    print(f"loaded {n_nodes} nodes and {n_links} links into {a.uri}")


if __name__ == "__main__":
    main()

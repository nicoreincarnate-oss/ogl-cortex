"""Vault graph add-on: vault_graph.py builds a link graph, graph_mcp.py answers MCP tool calls over it,
neo4j_load.py plans the Neo4j load (dry run). All on a synthetic vault."""
import json, os, subprocess, sys, tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import memfixtures as fx  # noqa: E402

VG = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "memory", "vault-graph")


def vault():
    v = tempfile.mkdtemp(prefix="ogl-vault-")
    fx.write(os.path.join(v, "People", "Ada Park.md"), "---\ntags: [person]\n---\n# Ada Park\nRuns billing. Works with [[Billing Export]].\n")
    fx.write(os.path.join(v, "Projects", "Billing Export.md"), "# Billing Export\nOwned by [[Ada Park|Ada]]. Feeds [[Ledger]]. #finance\n")
    fx.write(os.path.join(v, "Ledger.md"), "# Ledger\nThe ledger. See [[Missing Note]].\n")
    fx.write(os.path.join(v, "Island.md"), "# Island\nNo links here.\n")
    fx.write(os.path.join(v, ".obsidian", "workspace.md"), "# hidden [[Ledger]]\n")
    fx.write(os.path.join(os.path.dirname(v), "outside-secret.md"), "SECRET-OUTSIDE\n")
    return v


def mcp(lines, env):
    r = subprocess.run([sys.executable, os.path.join(VG, "graph_mcp.py")], input="\n".join(lines) + "\n",
                       capture_output=True, text=True, env=dict(os.environ, **env), timeout=30)
    return r.returncode, [json.loads(l) for l in r.stdout.splitlines() if l.strip()], r.stderr


def call(i, name, args):
    return json.dumps({"jsonrpc": "2.0", "id": i, "method": "tools/call", "params": {"name": name, "arguments": args}})


def text(resp):
    return resp["result"]["content"][0]["text"]


def main():
    work, broke = [], []
    v = vault()
    r = subprocess.run([sys.executable, os.path.join(VG, "vault_graph.py"), v], capture_output=True, text=True)
    gpath = os.path.join(v, "graphify-out", "graph.json")
    g = json.load(open(gpath)) if os.path.exists(gpath) else {"nodes": [], "links": []}
    ids = {n["id"] for n in g["nodes"]}
    work.append(("vault_graph writes graph.json: 4 notes + 2 tags", r.returncode == 0 and len(ids) == 6))
    rels = {(l["source"], l["target"], l["relation"]) for l in g["links"]}
    work.append(("wikilinks resolve by title, alias and path", ("People/Ada Park.md", "Projects/Billing Export.md", "links_to") in rels
                 and ("Projects/Billing Export.md", "People/Ada Park.md", "links_to") in rels
                 and ("Projects/Billing Export.md", "Ledger.md", "links_to") in rels))
    work.append(("hidden folders skipped, dangling links dropped", not any(".obsidian" in i for i in ids) and len([l for l in g["links"] if l["relation"] == "links_to"]) == 3))

    env = {"OGL_GRAPH_JSON": gpath, "OGL_VAULT_DIR": v}
    init = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "0"}}})
    c, out, err = mcp([init, json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}),
                       json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}),
                       call(3, "memory_query", {"query": "who runs billing export"}),
                       call(4, "memory_neighbors", {"node": "Ada Park", "hops": 2}),
                       call(5, "memory_shortest_path", {"source": "Ada Park", "target": "Ledger"}),
                       call(6, "memory_read_note", {"path": "Ledger.md"}),
                       call(7, "memory_shortest_path", {"source": "Ada Park", "target": "Island"})], env)
    by = {m.get("id"): m for m in out}
    work.append(("initialize echoes the protocol version, tools capability", by.get(1, {}).get("result", {}).get("protocolVersion") == "2025-06-18"
                 and "tools" in by[1]["result"]["capabilities"]))
    work.append(("a notification gets no reply", len(out) == 7))
    work.append(("tools/list names the four tools", sorted(t["name"] for t in by[2]["result"]["tools"]) ==
                 ["memory_neighbors", "memory_query", "memory_read_note", "memory_shortest_path"]))
    work.append(("memory_query finds the note and its links", "Billing Export" in text(by[3]) and "--links_to-->" in text(by[3])))
    work.append(("memory_neighbors walks 2 hops", "Ledger" in text(by[4]) and "(2)" in text(by[4])))
    work.append(("memory_shortest_path returns the hops", text(by[5]).startswith("2 hop(s)")))
    work.append(("memory_read_note reads a vault note", "The ledger." in text(by[6])))
    work.append(("no path is said plainly", "no path between" in text(by[7])))

    graphify_shaped = os.path.join(tempfile.mkdtemp(), "graph.json")
    json.dump({"directed": False, "multigraph": False, "graph": {}, "hyperedges": [],
               "nodes": [{"id": "a", "label": "Alpha Service", "community": 0, "file_type": "code", "source_file": "a.py", "source_location": "L1"},
                         {"id": "b", "label": "Beta Queue", "community": 0, "file_type": "code", "source_file": "b.py", "source_location": "L1"}],
               "links": [{"source": "a", "target": "b", "relation": "calls", "confidence": "EXTRACTED", "confidence_score": 1.0,
                          "source_file": "a.py", "source_location": "L3", "weight": 1.0, "_src": "a", "_tgt": "b"}]}, open(graphify_shaped, "w"))
    c, out, _ = mcp([call(1, "memory_neighbors", {"node": "alpha"})], {"OGL_GRAPH_JSON": graphify_shaped})
    work.append(("reads graphify's node-link output", "--calls--> Beta Queue" in text(out[0])))

    r = subprocess.run([sys.executable, os.path.join(VG, "neo4j_load.py"), gpath, "--dry-run"], capture_output=True, text=True, env=dict(os.environ, NEO4J_PASSWORD=""))
    work.append(("neo4j_load --dry-run plans 6 nodes and the links, connects to nothing", r.returncode == 0 and "dry run: 6 nodes, 5 links" in r.stdout))

    # must-not-break
    c, out, err = mcp(["{garbage", json.dumps({"jsonrpc": "2.0", "id": 9, "method": "nope/x"}), call(10, "memory_query", {"query": "ledger"})], env)
    broke.append(("garbage line: parse error, server keeps serving", c == 0 and out[0]["error"]["code"] == -32700 and "Ledger" in text(out[2])))
    broke.append(("unknown method: -32601", out[1]["error"]["code"] == -32601))
    c, out, _ = mcp([call(1, "memory_read_note", {"path": "../outside-secret.md"}), call(2, "memory_read_note", {"path": "/etc/hosts"})], env)
    broke.append(("read_note refuses paths outside the vault", all("not a note inside the vault" in text(o) for o in out) and "SECRET-OUTSIDE" not in json.dumps(out)))
    c, out, _ = mcp([call(1, "memory_query", {"query": "x y z"})], {"OGL_GRAPH_JSON": "/nonexistent/graph.json"})
    broke.append(("missing graph file: isError with the build hint, no crash", c == 0 and out[0]["result"]["isError"] and "vault_graph.py" in text(out[0])))
    c, out, _ = mcp([call(1, "no_such_tool", {})], env)
    broke.append(("unknown tool: isError, no crash", out[0]["result"]["isError"]))
    c, out, _ = mcp([call(1, "memory_neighbors", {"node": "Ada Park", "hops": 99})], env)
    broke.append(("hops capped at 3", c == 0 and "within 3 hop(s)" in text(out[0])))
    r = subprocess.run([sys.executable, os.path.join(VG, "vault_graph.py"), "/nonexistent-vault"], capture_output=True, text=True)
    broke.append(("vault_graph on a missing folder: clear error", r.returncode != 0 and "not a folder" in r.stderr))
    r = subprocess.run([sys.executable, os.path.join(VG, "neo4j_load.py"), gpath], capture_output=True, text=True, env={k: v for k, v in os.environ.items() if k != "NEO4J_PASSWORD"})
    broke.append(("neo4j_load without NEO4J_PASSWORD refuses", r.returncode != 0 and "NEO4J_PASSWORD" in r.stderr))

    for label, ok in work + broke:
        if not ok:
            print(f"[vault_graph] FAIL: {label}")
    w, b = sum(ok for _, ok in work), sum(ok for _, ok in broke)
    passed = w == len(work) and b == len(broke)
    print(f"{'vault graph + MCP':<22} must-work {w}/{len(work)}   must-not-break {b}/{len(broke)}   {'PASS' if passed else 'FAIL'}")
    return passed


if __name__ == "__main__":
    sys.exit(0 if main() else 1)

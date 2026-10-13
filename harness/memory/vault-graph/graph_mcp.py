#!/usr/bin/env python3
"""A stdio MCP server for graph traversal over a graph.json (graphify output or vault_graph.py output).

    claude mcp add --scope user vault-graph -- env OGL_GRAPH_JSON=<vault>/graphify-out/graph.json \
        OGL_VAULT_DIR=<vault> python3 <path>/graph_mcp.py

Tools:
  memory_query(query, limit)            nodes whose label or id matches the words, with their direct links
  memory_neighbors(node, hops)          everything within N hops of one node (default 1, max 3)
  memory_shortest_path(source, target)  the shortest link path between two nodes
  memory_read_note(path)                the text of one note, only from inside OGL_VAULT_DIR

Standard library only. JSON-RPC 2.0 over newline-delimited stdin/stdout. The graph file is re-read when its
modification time changes, so a rebuild needs no restart. The server only reads; it never writes.
"""
import json, os, re, sys
from collections import deque
from pathlib import Path

SERVER = {"name": "ogl-vault-graph", "version": "1.0.0"}
TOOLS = [
    {"name": "memory_query", "description": "Find graph nodes whose label or id matches the words of a question, with their direct links.",
     "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}, "limit": {"type": "integer", "default": 8}}, "required": ["query"]}},
    {"name": "memory_neighbors", "description": "List the nodes within N hops of one node (by id or label).",
     "inputSchema": {"type": "object", "properties": {"node": {"type": "string"}, "hops": {"type": "integer", "default": 1}}, "required": ["node"]}},
    {"name": "memory_shortest_path", "description": "Shortest link path between two nodes (by id or label).",
     "inputSchema": {"type": "object", "properties": {"source": {"type": "string"}, "target": {"type": "string"}}, "required": ["source", "target"]}},
    {"name": "memory_read_note", "description": "Read one markdown note from the vault by its path inside the vault.",
     "inputSchema": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}},
]


class Graph:
    def __init__(self, path):
        self.path, self.mtime = Path(path), None
        self.nodes, self.adj = {}, {}

    def load(self):
        try:
            m = self.path.stat().st_mtime
        except OSError:
            raise RuntimeError(f"graph file not found: {self.path}. Build it with graphify or vault_graph.py")
        if m == self.mtime:
            return
        g = json.loads(self.path.read_text(encoding="utf-8"))
        self.nodes = {str(n["id"]): n for n in g.get("nodes", []) if "id" in n}
        self.adj = {k: [] for k in self.nodes}
        for l in g.get("links", g.get("edges", [])):
            s, t, rel = str(l.get("source")), str(l.get("target")), l.get("relation") or "related"
            if s in self.adj and t in self.adj:
                self.adj[s].append((t, rel))
                self.adj[t].append((s, rel))
        self.mtime = m

    def label(self, nid):
        n = self.nodes.get(nid, {})
        return f"{n.get('label') or nid} [{nid}]"

    def find(self, sel):
        sel = (sel or "").strip()
        if sel in self.nodes:
            return sel
        low = sel.lower()
        exact = [k for k, n in self.nodes.items() if str(n.get("label", "")).lower() == low]
        if exact:
            return sorted(exact)[0]
        part = [k for k, n in self.nodes.items() if low and (low in str(n.get("label", "")).lower() or low in k.lower())]
        return sorted(part, key=len)[0] if part else None

    def query(self, q, limit=8):
        words = [w for w in re.findall(r"\w+", q.lower()) if len(w) > 2]
        if not words:
            return "no searchable words in the query"
        scored = []
        for k, n in self.nodes.items():
            hay = f"{n.get('label', '')} {k}".lower()
            score = sum(w in hay for w in words)
            if score:
                scored.append((-score, -len(self.adj.get(k, [])), k))
        if not scored:
            return f"no nodes match: {q}"
        out = []
        for _, _, k in sorted(scored)[:max(1, min(int(limit), 50))]:
            out.append(f"- {self.label(k)}")
            for t, rel in self.adj.get(k, [])[:6]:
                out.append(f"    --{rel}--> {self.label(t)}")
        return "\n".join(out)

    def neighbors(self, sel, hops=1):
        start = self.find(sel)
        if not start:
            return f"node not found: {sel}"
        hops = max(1, min(int(hops), 3))
        seen, frontier, out = {start: 0}, deque([start]), []
        while frontier:
            cur = frontier.popleft()
            if seen[cur] >= hops:
                continue
            for t, rel in self.adj.get(cur, []):
                if t not in seen:
                    seen[t] = seen[cur] + 1
                    frontier.append(t)
                    out.append(f"{'  ' * (seen[t] - 1)}- ({seen[t]}) {self.label(cur)} --{rel}--> {self.label(t)}")
        return f"{self.label(start)}: {len(seen) - 1} nodes within {hops} hop(s)\n" + "\n".join(out[:200])

    def shortest(self, a, b):
        s, t = self.find(a), self.find(b)
        if not s or not t:
            return f"node not found: {a if not s else b}"
        prev, q = {s: None}, deque([s])
        while q:
            cur = q.popleft()
            if cur == t:
                break
            for n, rel in self.adj.get(cur, []):
                if n not in prev:
                    prev[n] = (cur, rel)
                    q.append(n)
        if t not in prev:
            return f"no path between {self.label(s)} and {self.label(t)}"
        steps, cur = [], t
        while prev[cur]:
            p, rel = prev[cur]
            steps.append(f"{self.label(p)} --{rel}--> {self.label(cur)}")
            cur = p
        return f"{len(steps)} hop(s):\n" + "\n".join(reversed(steps))


def read_note(vault, rel):
    if not vault:
        return "OGL_VAULT_DIR is not set"
    root = Path(vault).expanduser().resolve()
    p = (root / rel).resolve()
    if root not in p.parents or p.suffix != ".md" or not p.is_file():
        return f"not a note inside the vault: {rel}"
    text = p.read_text(encoding="utf-8", errors="replace")
    return text if len(text) <= 12000 else text[:12000] + "\n[...truncated]"


def handle(graph, msg):
    method, mid = msg.get("method"), msg.get("id")
    if method == "initialize":
        ver = (msg.get("params") or {}).get("protocolVersion") or "2024-11-05"
        return {"protocolVersion": ver, "capabilities": {"tools": {}}, "serverInfo": SERVER}
    if method == "ping":
        return {}
    if method == "tools/list":
        return {"tools": TOOLS}
    if method == "tools/call":
        p = msg.get("params") or {}
        name, args = p.get("name"), p.get("arguments") or {}
        try:
            if name == "memory_read_note":
                text = read_note(os.environ.get("OGL_VAULT_DIR"), str(args.get("path", "")))
            else:
                graph.load()
                if name == "memory_query":
                    text = graph.query(str(args.get("query", "")), args.get("limit", 8))
                elif name == "memory_neighbors":
                    text = graph.neighbors(str(args.get("node", "")), args.get("hops", 1))
                elif name == "memory_shortest_path":
                    text = graph.shortest(str(args.get("source", "")), str(args.get("target", "")))
                else:
                    raise KeyError(f"unknown tool: {name}")
            return {"content": [{"type": "text", "text": text}], "isError": False}
        except Exception as exc:
            return {"content": [{"type": "text", "text": f"{type(exc).__name__}: {exc}"}], "isError": True}
    if mid is None:
        return None  # a notification
    raise LookupError(method)


def main():
    graph = Graph(os.environ.get("OGL_GRAPH_JSON") or "graphify-out/graph.json")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            print(json.dumps({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse error"}}), flush=True)
            continue
        if not isinstance(msg, dict):
            continue
        mid = msg.get("id")
        try:
            result = handle(graph, msg)
        except LookupError as exc:
            print(json.dumps({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"method not found: {exc}"}}), flush=True)
            continue
        if mid is not None and result is not None:
            print(json.dumps({"jsonrpc": "2.0", "id": mid, "result": result}), flush=True)


if __name__ == "__main__":
    main()

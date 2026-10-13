#!/usr/bin/env python3
# OGL Cortex client memory graph. Pattern from Glitch Cat Club's graph memory starter. See harness/README.md (Licences).
"""UserPromptSubmit hook: if the prompt names a client or person in the client graph and asks about them, inject
the graph's dated, quoted facts before the model reads the prompt.

- Scheduled prompts ([CRON FIRED ...]) are skipped: a cron is not a question about a client.
- A wrapped Telegram or agent message repeats recent conversation; only the newest message (the body inside the
  longest code fence) is read as the question.
- A client name alone, with no question word the intent table knows, injects nothing.
- Output is capped at 6,000 characters and labelled: quotes are evidence, summaries are model-written.
- No graph, no match, bad input or any error: prints nothing. Always exits 0.

Graph location: $OGL_CLIENT_GRAPH_DB, else graph.db next to this file.
"""
import json, re, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
FENCE = re.compile(r"^(`{3,})[^\n`]*\n(.*?)\n\1[ \t]*$", re.S | re.M)


def question(prompt):
    if prompt.lstrip().startswith("[CRON FIRED"):
        return ""
    if "=== TELEGRAM" in prompt or "=== AGENT MESSAGE" in prompt:
        fences = FENCE.findall(prompt)
        if not fences:
            return ""
        fence, body = max(enumerate(fences), key=lambda x: (len(x[1][0]), x[0]))[1]
        return body
    return prompt


def main():
    try:
        data = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        return
    prompt = data.get("prompt", "") if isinstance(data, dict) else ""
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 20000:
        return
    q = question(prompt)
    if not q.strip():
        return
    import recall as r
    if not r.DB.is_file():
        return
    rows, want, _ = r.recall(q, limit=12)
    if not rows or not want:
        return
    text = r.as_text(q, limit=12)
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext":
        "[client memory graph: code-walked facts, each quote verified against its source message; "
        "summaries are model-written, quotes are evidence]\n" + text[:6000]}}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)

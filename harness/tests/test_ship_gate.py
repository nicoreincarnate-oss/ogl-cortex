"""Ship gate: deploy and push commands block (exit 2) without a passing report, and pass with one."""
import json, os, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from hookrun import bash, check, report, tool

HOOK = "ship_gate.py"


def project(status=None, accept=False):
    d = tempfile.mkdtemp(prefix="ogl-ship-")
    if status or accept:
        os.makedirs(os.path.join(d, "security"))
    if status:
        with open(os.path.join(d, "security", "pentest-gate-report.json"), "w") as f:
            json.dump({"status": status}, f)
    if accept:
        open(os.path.join(d, "security", "pentest-risk-acceptance.md"), "w").write("# accepted\n")
    return d


def main():
    bare, failing, passing, accepted = project(), project("fail"), project("pass"), project(accept=True)
    nested = os.path.join(passing, "apps", "web")
    os.makedirs(nested)
    block = [
        ("vercel --prod", bash("vercel --prod", bare)),
        ("vercel --prod --yes", bash("vercel --prod --yes", bare)),
        ("npx vercel --prod", bash("npx vercel --prod", bare)),
        ("cd + vercel deploy --prod", bash("cd site && vercel deploy --prod", bare)),
        ("vercel promote", bash("vercel promote dpl_example", bare)),
        ("git push", bash("git push origin main", bare)),
        ("gh pr merge", bash("gh pr merge 12 --squash", bare)),
        ("npm publish", bash("npm publish --access public", bare)),
        ("wrangler deploy", bash("wrangler deploy", bare)),
        ("netlify deploy", bash("netlify deploy --prod", bare)),
        ("rsync to remote", bash("rsync -av dist/ deploy@host:/srv/www/", bare)),
        ("scp", bash("scp build.tgz host:/tmp/", bare)),
        ("report says fail", bash("vercel --prod", failing)),
        ("risk file without override env", bash("vercel --prod", accepted)),
        ("override env without risk file", bash("git push", bare), {"OGL_PENTEST_OVERRIDE": "accepted-risk"}),
        ("extra pattern", bash("./ship.sh production", bare), {"OGL_SHIP_EXTRA_PATTERNS": r"\bship\.sh\b"}),
        ("unparseable input naming a deploy", '{"tool_name": "Bash", "tool_input": {"command": "vercel --prod"'),
    ]
    allow = [
        ("git status", bash("git status", bare)),
        ("vercel ls", bash("vercel ls", bare)),
        ("vercel dev", bash("vercel dev", bare)),
        ("npm test", bash("npm test", bare)),
        ("local rsync", bash("rsync -av a/ b/", bare)),
        ("git commit", bash("git commit -m 'x'", bare)),
        ("passing report", bash("vercel --prod", passing)),
        ("passing report in ancestor", bash("npx vercel --prod --yes", nested)),
        ("override env + risk file", bash("git push", accepted), {"OGL_PENTEST_OVERRIDE": "accepted-risk"}),
        ("non-Bash tool", tool("Write", {"file_path": "/tmp/x", "content": "vercel --prod"}, bare)),
    ]
    return report("ship_gate", check("ship_gate", HOOK, block, allow))


if __name__ == "__main__":
    sys.exit(0 if main() else 1)

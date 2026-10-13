"""Shared-surface guard: writes to shared roots block once (exit 2); reads, temp caches and released commands pass."""
import os, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from hookrun import bash, check, report, tool

HOOK = "shared_surface_guard.py"
EXTRA = {"OGL_SURFACE_EXTRA_ROOTS": "~/.config/example-tool=example_config"}


def released_state():
    d = tempfile.mkdtemp(prefix="ogl-surface-token-")
    open(os.path.join(d, ".surface-pass-once-tester"), "w").close()
    return d


def main():
    block = [
        ("cp into ~/.claude", bash("cp x ~/.claude/settings.json")),
        ("redirect into ~/.claude", bash("echo '{}' > ~/.claude/settings.json")),
        ("redirect via $HOME", bash('echo x >> "$HOME/.claude.json"')),
        ("cd then relative write", bash("cd ~/.claude && echo x > settings.json")),
        ("sed -i on ~/.claude.json", bash("sed -i '' 's/a/b/' ~/.claude.json")),
        ("python write simple", bash("python3 -c \"import os; open(os.path.expanduser('~/.claude/settings.json'), 'w').write('x')\"")),
        ("find -delete over ~/.claude", bash("find ~/.claude -name '*.bak' -delete")),
        ("npm global install", bash("npm i -g some-cli")),
        ("pnpm global remove", bash("pnpm remove --global some-cli")),
        ("brew upgrade", bash("brew upgrade")),
        ("uv cache prune", bash("uv cache prune --force")),
        ("rm uv cache", bash("rm -rf ~/.cache/uv")),
        ("rm ancestor of uv cache", bash("rm -rf ~/.cache")),
        ("extra root write", bash("cp token.json ~/.config/example-tool/creds.json"), EXTRA),
        ("sudo prefix hides nothing", bash("sudo -n cp x ~/.claude/settings.json")),
        ("delete a session transcript", bash("rm ~/.claude/projects/some-seat/0123abcd-0123-4567-89ab-0123456789ab.jsonl")),
        ("crash on an in-scope command fails closed", bash("cp x ~/.claude/settings.json"), {"SURFACE_GUARD_SELFTEST_CRASH": "1"}),
    ]
    allow = [
        ("read settings", bash("cat ~/.claude/settings.json")),
        ("stat settings", bash("stat ~/.claude/settings.json")),
        ("list globals", bash("npm ls -g")),
        ("brew list", bash("brew list")),
        ("quoted text is data", bash("echo 'uv cache prune'")),
        ("uv cache dir", bash("uv cache dir")),
        ("prune a temp cache", bash("UV_CACHE_DIR=/private/tmp/ogl-x uv cache prune")),
        ("du the cache", bash("du -sh ~/.cache/uv")),
        ("write in the project", bash("echo x > notes.txt")),
        ("append to a memory topic", bash("echo x >> ~/.claude/projects/some-seat/memory/topic.md")),
        ("extra root read", bash("cat ~/.config/example-tool/creds.json"), EXTRA),
        ("extra root unset: no rule", bash("cp token.json ~/.config/example-tool/creds.json")),
        ("heredoc body is data", bash("cat > /tmp/ogl-note.md <<'EOF'\ncp x ~/.claude/settings.json\nEOF")),
        ("released once by pass token", bash("cp x ~/.claude/settings.json"), {"OGL_STATE_DIR": released_state()}),
        ("crash out of scope fails open", bash("ls -la"), {"SURFACE_GUARD_SELFTEST_CRASH": "1"}),
        ("non-Bash tool", tool("Read", {"file_path": "~/.claude/settings.json"})),
    ]
    return report("shared_surface_guard", check("shared_surface_guard", HOOK, block, allow))


if __name__ == "__main__":
    sys.exit(0 if main() else 1)

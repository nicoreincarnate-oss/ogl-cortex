#!/usr/bin/env python3
"""Check that every relative link in the repo's Markdown files points at a file that exists.

Reads Markdown links and images ([text](target), ![alt](target)) and HTML href/src attributes.
Skips absolute URLs (http, https, mailto), in-page anchors (#...), and links inside fenced code blocks
and inline code. A target's #anchor and ?query are ignored; only the file part is checked.

Usage: python3 scripts/check-links.py [repo-root]
Exit codes: 0 every link resolves; 1 at least one broken link (each printed as file:line: target).
"""
import os
import re
import sys

ROOT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), ".."))
SKIP_DIRS = {".git", ".build-brief", "node_modules", "__pycache__"}
MD_LINK = re.compile(r"!?\[(?:[^\]\[]|\[[^\]]*\])*\]\(\s*<?([^)\s>]+)>?(?:\s+\"[^\"]*\")?\s*\)")
HTML_ATTR = re.compile(r"""\b(?:href|src)\s*=\s*["']([^"']+)["']""", re.I)
INLINE_CODE = re.compile(r"`[^`]*`")


def md_files():
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            if name.endswith(".md"):
                yield os.path.join(dirpath, name)


def is_external(target):
    return re.match(r"^[a-z][a-z0-9+.-]*:", target, re.I) is not None or target.startswith("//")


def main():
    broken = checked = 0
    for path in sorted(md_files()):
        in_fence = False
        with open(path, encoding="utf-8") as fh:
            for lineno, line in enumerate(fh, 1):
                if line.lstrip().startswith(("```", "~~~")):
                    in_fence = not in_fence
                    continue
                if in_fence:
                    continue
                text = INLINE_CODE.sub("", line)
                for target in MD_LINK.findall(text) + HTML_ATTR.findall(text):
                    if not target or target.startswith("#") or is_external(target):
                        continue
                    file_part = target.split("#", 1)[0].split("?", 1)[0]
                    if not file_part:
                        continue
                    checked += 1
                    resolved = os.path.normpath(os.path.join(os.path.dirname(path), file_part))
                    if not os.path.exists(resolved):
                        broken += 1
                        print(f"{os.path.relpath(path, ROOT)}:{lineno}: {target}")
    print(f"checked {checked} relative links, {broken} broken")
    return 1 if broken else 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Build the HTML edition of docs/*.md into docs/site/.

Needs: pandoc. Optional: mmdc (mermaid-cli) to render ```mermaid blocks to SVG;
without it, diagrams stay as code blocks.

Usage: python3 scripts/build-docs-site.py [--chrome PATH]
  --chrome  Chrome binary for mmdc (needed when mmdc has no bundled browser)
"""
import argparse, hashlib, html, json, pathlib, re, shutil, subprocess, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
SITE = DOCS / "site"
FONTS = DOCS / "assets" / "readme" / "src" / "fonts"

GROUPS = [
    (0, 9, "Core system"),
    (10, 19, "Strategy and governance"),
    (20, 29, "Design, data and AI quality"),
    (30, 39, "Operations and security"),
    (40, 49, "Business and assurance"),
]
REPO = "https://github.com/nicoreincarnate-oss/ogl-cortex"
MERMAID = re.compile(r"```mermaid\n(.*?)```", re.S)


def group_of(num):
    for lo, hi, name in GROUPS:
        if lo <= num <= hi:
            return name
    return "Other"


def render_mermaid(code, chrome):
    if not shutil.which("mmdc"):
        return None
    h = hashlib.sha1(code.encode()).hexdigest()[:12]
    out = SITE / "img" / f"{h}.svg"
    if out.exists():
        return out.name
    tmp = SITE / "img" / f"{h}.mmd"
    tmp.write_text(code)
    cfg = SITE / "img" / "_mermaid.json"
    cfg.write_text(json.dumps({"theme": "base", "themeVariables": {
        "fontFamily": "Archivo, Helvetica, Arial, sans-serif", "fontSize": "14px",
        "primaryColor": "#F2EFE9", "primaryBorderColor": "#0A0A0A", "primaryTextColor": "#0A0A0A",
        "lineColor": "#0A0A0A", "secondaryColor": "#FFFFFF", "tertiaryColor": "#F2EFE9",
        "actorBkg": "#F2EFE9", "actorBorder": "#0A0A0A", "noteBkgColor": "#FFE3D6"}}))
    cmd = ["mmdc", "-i", str(tmp), "-o", str(out), "-c", str(cfg), "-b", "transparent"]
    if chrome:
        pp = SITE / "img" / "_pptr.json"
        pp.write_text(json.dumps({"executablePath": chrome, "args": ["--no-sandbox"]}))
        cmd += ["-p", str(pp)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    tmp.unlink(missing_ok=True)
    if r.returncode != 0 or not out.exists():
        print(f"  mermaid render failed ({h}); kept as code", file=sys.stderr)
        return None
    return out.name


def md_to_html(md):
    return subprocess.run(["pandoc", "-f", "gfm", "-t", "html5", "--wrap=none"],
                          input=md, capture_output=True, text=True, check=True).stdout


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--chrome", default=None)
    a = ap.parse_args()
    if not shutil.which("pandoc"):
        sys.exit("pandoc is required: brew install pandoc (or apt install pandoc)")
    (SITE / "img").mkdir(parents=True, exist_ok=True)
    (SITE / "fonts").mkdir(exist_ok=True)
    for f in FONTS.glob("*.woff2"):
        shutil.copy2(f, SITE / "fonts" / f.name)

    docs = []
    for f in sorted(DOCS.glob("[0-9][0-9]-*.md")):
        num = int(f.name[:2])
        text = f.read_text()
        first, _, rest = text.partition("\n")
        title = re.sub(r"^#\s*(\d\d\.?\s*)?", "", first).strip()

        def rep(m):
            svg = render_mermaid(m.group(1), a.chrome)
            return f'\n<figure class="diagram"><img src="img/{svg}" alt="Diagram"></figure>\n' if svg else m.group(0)

        body = md_to_html(MERMAID.sub(rep, rest))
        body = re.sub(r'href="(\d\d-[a-z0-9-]+)\.md(#[^"]*)?"', lambda m: f'href="{m.group(1)}.html{m.group(2) or ""}"', body)
        body = re.sub(r'href="\.\./\.\./([A-Z-]+\.md)"', rf'href="{REPO}/blob/main/\1"', body)
        toc = re.findall(r'<h2 id="([^"]+)">(.*?)</h2>', body)
        docs.append({"num": num, "slug": f.stem, "title": title, "body": body, "toc": toc,
                     "words": len(text.split())})

    def nav(active):
        out, last = [], None
        for d in docs:
            g = group_of(d["num"])
            if g != last:
                out.append(f'<li class="g">{g}</li>')
                last = g
            cls = ' class="on"' if d["slug"] == active else ""
            out.append(f'<li{cls}><a href="{d["slug"]}.html"><span>{d["num"]:02d}</span>{html.escape(d["title"])}</a></li>')
        return "\n".join(out)

    def page(title, active, main):
        return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{html.escape(title)} · OGL Cortex</title><link rel="stylesheet" href="style.css"></head>
<body><a class="skip" href="#main">Skip to content</a>
<header class="top"><a class="brand" href="index.html">OGL CORTEX<i>.</i></a><span class="tag">technical documentation</span></header>
<div class="wrap"><nav class="side" aria-label="Documents"><ol>{nav(active)}</ol></nav>
<main id="main">{main}</main></div></body></html>"""

    for i, d in enumerate(docs):
        prev_d = docs[i - 1] if i else None
        next_d = docs[i + 1] if i + 1 < len(docs) else None
        toc = "".join(f'<li><a href="#{a}">{t}</a></li>' for a, t in d["toc"])
        pager = '<nav class="pager">'
        if prev_d:
            pager += f'<a class="prev" href="{prev_d["slug"]}.html"><small>Previous</small>{prev_d["num"]:02d} {html.escape(prev_d["title"])}</a>'
        if next_d:
            pager += f'<a class="next" href="{next_d["slug"]}.html"><small>Next</small>{next_d["num"]:02d} {html.escape(next_d["title"])}</a>'
        pager += "</nav>"
        main = f"""<header class="dh"><div class="dn">{d["num"]:02d}</div><div><p class="dg">{group_of(d["num"])}</p>
<h1>{html.escape(d["title"])}</h1><p class="meta">{d["words"]:,} words · <a href="{REPO}/blob/main/docs/{d["slug"]}.md">Markdown source</a></p></div></header>
{f'<details class="toc" open><summary>On this page</summary><ol>{toc}</ol></details>' if toc else ''}
<article>{d["body"]}</article>{pager}"""
        (SITE / f'{d["slug"]}.html').write_text(page(d["title"], d["slug"], main))

    cards, last = [], None
    for d in docs:
        g = group_of(d["num"])
        if g != last:
            cards.append(f'<h2>{g}</h2>')
            last = g
        cards.append(f'<a class="row" href="{d["slug"]}.html"><span class="n">{d["num"]:02d}</span><span class="t">{html.escape(d["title"])}</span><span class="w">{d["words"]:,} words</span></a>')
    total = sum(d["words"] for d in docs)
    index = f"""<header class="hero"><p class="dg">OGL Cortex · reference</p><h1>How the fleet is built, run and kept safe.</h1>
<p class="lede">{len(docs)} documents, {total:,} words. Start with <a href="01-core-architecture.html">01 Core architecture</a>, then <a href="04-failsafe-boundary-log.html">04 Guardrails</a>. New here? Read <a href="{REPO}/blob/main/GETTING-STARTED.md">Getting started</a>.</p></header>
<section class="list">{''.join(cards)}</section>"""
    (SITE / "index.html").write_text(page("Documentation", "", index))
    print(f"built {len(docs)} pages + index into {SITE.relative_to(ROOT)}")


if __name__ == "__main__":
    main()

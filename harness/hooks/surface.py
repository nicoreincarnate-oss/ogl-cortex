"""Shared-surface detection for the OGL Cortex shared-surface guard.

Parses each simple command in a Bash tool call. Quoted text and heredoc bodies are data, not commands.
classify(cmd, cwd) -> [(rule, detail)]

Guarded roots (writes and deletes there block):
  built in:  ~/.claude, ~/.claude.json (rule claude_config), ~/.cache/uv (rule uv_cache)
  extra:     OGL_SURFACE_EXTRA_ROOTS="~/.config/mytool=mytool_config:~/.some_mcp=mcp_creds"
             (colon-separated path=rule pairs; paths may start with ~)
~/.claude/projects is exempt for writes (each session appends its transcript there); deletes there are checked.
"""
import fnmatch, os, re, shlex, sys
sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import codewrites
HEREDOC = re.compile(r"<<(-?)\s*['\"]?(\w+)['\"]?([^\n]*)\n.*?\n(?(1)\t*)\2[ \t]*(?=\n|$)", re.S)
HDMARK = "__ctx_heredoc_%d__"
HDMARK_RE = re.compile(r"^__ctx_heredoc_(\d+)__$")

def _heredocs(cmd):
    """-> (cmd with each heredoc replaced by its placeholder + rest-of-line, [full heredoc match text by index])"""
    bodies = []
    def sub(m):
        bodies.append(m.group(0))
        return " " + HDMARK % (len(bodies) - 1) + " " + m.group(3)
    return HEREDOC.sub(sub, cmd), bodies

def _restore(s, bodies):
    """Put the original heredoc text back into a nested string (bash -c '... <<EOF ...') before recursing: the outer pass
    left placeholders there that the inner pass cannot resolve."""
    for k, full in enumerate(bodies):
        mark = HDMARK % k
        if mark not in s: continue
        m = HEREDOC.match(full)
        s = s.replace(mark + " " + m.group(3), full, 1) if m and mark + " " + m.group(3) in s else s.replace(mark, full, 1)
    return s
HOME = os.path.expanduser("~")
ROOTS = [(os.path.join(HOME, ".claude"), "claude_config"), (os.path.join(HOME, ".claude.json"), "claude_config"),
         (os.path.join(HOME, ".cache", "uv"), "uv_cache")]

def _extra_roots(spec):
    """OGL_SURFACE_EXTRA_ROOTS -> [(abs path, rule)]. Malformed pairs are skipped."""
    out = []
    for pair in (spec or "").split(":"):
        if "=" not in pair: continue
        path, rule = (x.strip() for x in pair.split("=", 1))
        rule = re.sub(r"[^\w]", "_", rule)
        if not path or not rule: continue
        path = os.path.normpath(os.path.expanduser(path.replace("$HOME", HOME).replace("${HOME}", HOME)))
        if os.path.isabs(path) and path != os.sep: out.append((path, rule))
    return out

ROOTS += _extra_roots(os.environ.get("OGL_SURFACE_EXTRA_ROOTS", ""))
EXEMPT = [os.path.join(HOME, ".claude", "projects") + os.sep]
SEAT = re.sub(r"[^\w-]", "", os.environ.get("CTX_AGENT_NAME", "") or "") or "shared"
STATE_DIR = os.path.normpath(os.path.expanduser(os.environ.get("OGL_STATE_DIR") or os.path.join(HOME, ".ogl-cortex", "state")))
TOKEN_RE = re.compile("^" + re.escape(STATE_DIR) + r"/\.(?:surface|orwell)-pass-once-" + re.escape(SEAT) + "$")
PREFIX = {"sudo", "env", "timeout", "nohup", "nice", "time", "command", "exec", "caffeinate", "xargs"}
PREFIX_VAL = {"sudo": {"-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U", "-T", "--user", "--group", "--chdir", "--prompt"},
              "timeout": {"-s", "-k", "--signal", "--kill-after"}, "env": {"-u", "-C", "-S", "--unset", "--chdir", "--split-string"},
              "nice": {"-n", "--adjustment"}, "xargs": {"-I", "-i", "-J", "-R", "-S", "-n", "-P", "-L", "-l", "-s", "-d", "-E", "-e", "-a", "--max-args",
              "--max-procs", "--max-lines", "--delimiter", "--arg-file", "--replace"}, "exec": {"-a"},
              "uv run": {"--with", "--with-requirements", "--with-editable", "--directory", "--project", "--package", "--python", "-p",
              "--env-file", "--extra", "--group", "--index", "--index-url", "--from", "-w"}}
UV_GLOBAL_VAL = {"--directory", "--project", "--cache-dir", "--config-file", "--python", "-p", "--color", "--python-preference", "--allow-insecure-host"}
def _uv_run_at(args):
    i = 1
    while i < len(args) and args[i].startswith("-"):
        i += 2 if (args[i] in UV_GLOBAL_VAL and "=" not in args[i]) else 1
    return i + 1 if i < len(args) and args[i] == "run" else None
INTERP_FLAG_ONLY = {"-u", "-B", "-O", "-OO", "-s", "-S", "-E", "-I", "-q", "-v", "-b", "-bb", "-d", "-i", "-x", "-P", "-h", "-V",
                    "--version", "--help", "--check-syntax", "--no-warnings", "--trace-warnings", "--inspect", "--inspect-brk"}
DURATION_RE = re.compile(r"^\d+(?:\.\d+)?[smhd]?$")
RESERVED = {"do", "then", "else", "elif", "if", "while", "until", "!", "{", "}", "done", "fi", "esac"}
SEP = {";", "&&", "||", "|", "&", "(", ")", "\n", "|&"}

def _surface(path, cwd):
    if not path or path.startswith("-"): return None
    if "__ctx_unresolved_" in path:
        if re.match(r"[\"']?__ctx_unresolved_\w+__(?:/|[\"']?$)", path): NOTES.append(f"unresolved: command-substitution write target {path[:120]}")
        return None
    p = path.replace("${HOME}", HOME).replace("$HOME", HOME)
    p = re.sub(r"\$(?:\{CTX_AGENT_NAME\}|CTX_AGENT_NAME\b)", SEAT, p)
    if p.startswith("~"): p = HOME + p[1:]
    if "$" in p or "`" in p:
        pre = re.split(r"[$`]", p, 1)[0]
        if not pre: return None
        d = os.path.normpath(os.path.join(cwd or HOME, pre[:pre.rfind("/") + 1] or "."))
        if any((d + os.sep).startswith(e) for e in EXEMPT): return None
        for root, rule in ROOTS:
            if d == root or d.startswith(root + os.sep): return rule, os.path.join(d, p[pre.rfind("/") + 1:])
        return None
    p = os.path.normpath(os.path.join(cwd or HOME, p))
    if any(p.startswith(e) for e in EXEMPT) or TOKEN_RE.match(p): return None
    for root, rule in ROOTS:
        if p == root or p.startswith(root + os.sep) or (root.endswith(".claude") and p.startswith(root + ".")):
            return rule, p
    return None

ASSIGN = re.compile(r"(?:^|[;&|\s])([A-Za-z_]\w*)=(['\"]?)([^\s;&|'\"]+)\2")

CSUB = re.compile(r"(?:^|[;&|\s])([A-Za-z_]\w*)=[\"']?(\$\(|`)")
UNRES = "__ctx_unresolved_%s__"
_RB = r"(?=[/\s'\")`]|$)"
CSUB_ROOTS = [(re.compile(r"(?:~|\$HOME|\$\{HOME\}|" + re.escape(HOME) + r")/" + re.escape(rel) + _RB), os.path.join(HOME, rel))
              for rel in [".claude.json.backup"] + sorted({os.path.relpath(r, HOME) for r, _ in ROOTS if r.startswith(HOME + os.sep)}, key=len, reverse=True)]

UV_ROOT = os.path.join(HOME, ".cache", "uv")
UV_MKTEMP = "/private/tmp/ctx-mktemp-uv"
TMP_ROOTS = sorted({"/private/tmp", os.path.realpath("/tmp"), os.path.realpath(os.environ.get("TMPDIR") or "/tmp").rstrip(os.sep)})
UV_MKTEMP_RE = re.compile(r"(?<![\w$])UV_CACHE_DIR=([\"']?)(?:\$\(\s*mktemp((?:\s+[-\w.]+)*)\s*\)|`\s*mktemp((?:\s+[-\w.]+)*)\s*`)\1(?=[\s;&|)]|$)")

def _uv_mktemp(body):
    """UV_CACHE_DIR=$(mktemp -d [-t name]) -> a temp literal BEFORE parsing (the $( splits the command). -p/--tmpdir, a path or
    a file (no -d) stays unresolved and blocks."""
    def sub(m):
        a = (m.group(2) or m.group(3) or "").split()
        ok = "-d" in a or any(re.match(r"^-[a-z]*d[a-z]*$", x) for x in a)
        ok = ok and not any(x in ("-p", "--tmpdir") or x.startswith("--tmpdir=") or re.match(r"^-[a-z]*p", x) for x in a)
        return "UV_CACHE_DIR=" + UV_MKTEMP if ok else m.group(0)
    return UV_MKTEMP_RE.sub(sub, body)

def _uv_tmp(v):
    """True only for a literal absolute dir strictly below a temp root (physical path), or the mktemp marker."""
    if v == UV_MKTEMP: return True
    if not v.startswith("/") or "$" in v or "`" in v or "__ctx_" in v: return False
    r = os.path.realpath(v)
    return any(r.startswith(t + os.sep) for t in TMP_ROOTS)

def _uv_cache_cmd(args, envs):
    """args = [uv, ...] -> detail if this is a cache prune/clean on a non-temp cache, else None. The subcommand is found at
    ANY position (uv -q cache prune, uv --cache-dir X cache clean): fails toward hitting."""
    a = args[1:]
    if not any(a[i] == "cache" and a[i + 1] in ("prune", "clean") for i in range(len(a) - 1)): return None
    dirs = [x.split("=", 1)[1] for x in a if x.startswith("--cache-dir=")]
    dirs += [a[i + 1] for i in range(len(a) - 1) if a[i] == "--cache-dir"]
    dirs = dirs or envs
    if dirs and all(_uv_tmp(d) for d in dirs): return None
    return " ".join(args[:6])

BRACE_GLOB = "\x01"
BRACE_CAP, BRACE_DEPTH, BRACE_WORDS = 64, 8, 256
RANGE_RE = re.compile(r"^(-?\d+|[A-Za-z])\.\.(-?\d+|[A-Za-z])(?:\.\.(-?\d+))?$")

def _range(inner):
    """-> list of items, BRACE_GLOB-marker, or None (not a range)."""
    m = RANGE_RE.match(inner)
    if not m: return None
    x, y, st = m.group(1), m.group(2), abs(int(m.group(3) or 1)) or 1
    num = x.lstrip("-").isdigit() and y.lstrip("-").isdigit()
    if not num and not (x.isalpha() and y.isalpha()): return None
    a, b = (int(x), int(y)) if num else (ord(x), ord(y))
    if abs(b - a) // st + 1 > BRACE_CAP: return BRACE_GLOB
    k = st if b >= a else -st
    return [str(v) if num else chr(v) for v in range(a, b + (1 if b >= a else -1), k)]

def _braces(w, n=0):
    """bash brace expansion, done BEFORE tilde/path matching (as bash does): ~/.cache/{uv,pip},
    {~/.cache/uv,/tmp/x}, nested, ranges. Only a {..} with a top-level comma or a range expands ({uv} stays literal); ${..} is a
    variable. over the item cap, the word cap, or the DEPTH cap (later groups used to stay literal)
    a group becomes BRACE_GLOB, which fails toward hitting. A quoted '{a,b}' (literal in bash) expands too: also toward hitting."""
    i = 0
    while True:
        i = w.find("{", i)
        if i < 0: return [w]
        if i > 0 and w[i - 1] == "$": i += 1; continue
        depth, j, commas = 0, i, []
        while j < len(w):
            if w[j] == "{": depth += 1
            elif w[j] == "}":
                depth -= 1
                if depth == 0: break
            elif w[j] == "," and depth == 1: commas.append(j)
            j += 1
        if j >= len(w): return [w]
        items = [w[a + 1:b] for a, b in zip([i] + commas, commas + [j])] if commas else _range(w[i + 1:j])
        if items is None: i += 1; continue
        glob = lambda: _braces(w[:i] + BRACE_GLOB + w[j + 1:], n)
        if items == BRACE_GLOB or len(items) > BRACE_CAP or n >= BRACE_DEPTH: return glob()
        out = []
        for it in items:
            out += _braces(w[:i] + it + w[j + 1:], n + 1)
            if len(out) > BRACE_WORDS: return glob()
        return out

def _comp_match(p, root):
    """True if path/pattern p is root, an ancestor of it, or a glob that can reach it or into it (component-wise, as the shell
    globs: * does not cross /, a leading dot needs a literal dot). BRACE_GLOB matches anything, dot-names included."""
    pc, rc = p.rstrip(os.sep).split(os.sep), root.split(os.sep)
    if len(pc) > len(rc) and not any(ch in p for ch in "*?[" + BRACE_GLOB): return False
    for c, r in zip(pc, rc):
        if c == "**": break
        if c == r: continue
        if BRACE_GLOB in c:
            if not fnmatch.fnmatchcase(r, c.replace(BRACE_GLOB, "*")): return False
        elif (r.startswith(".") and not c.startswith(".")) or not fnmatch.fnmatchcase(r, c): return False
    return True

def _uv_del(path, cwd):
    """A DELETE target that contains the uv cache or reaches into it: an ancestor (rm -rf ~/.cache, rm -rf ~) or a glob
    (~/.cache/*, ~/.c*/uv). A word holding a capped brace group (BRACE_GLOB) is checked against EVERY root."""
    if not path or path.startswith("-"): return None
    p = path.replace("${HOME}", HOME).replace("$HOME", HOME)
    if p.startswith("~/") or p == "~": p = HOME + p[1:]
    if "$" in p or "`" in p: return None
    p = os.path.normpath(os.path.join(cwd or HOME, p))
    for root, rule in (sorted(ROOTS, key=lambda x: x[1] != "uv_cache") if BRACE_GLOB in p else [(UV_ROOT, "uv_cache")]):
        if _comp_match(p, root): return rule, p
    return None

def _subst_text(body, i, opener):
    """Text of the $( ... ) or `...` that starts at body[i] (the opener), balanced for $( ; '' when unterminated."""
    if opener == "`":
        j = body.find("`", i + 1); return body[i + 1:j] if j > 0 else ""
    depth, j = 1, i + 2
    while j < len(body) and depth:
        depth += {"(": 1, ")": -1}.get(body[j], 0); j += 1
    return body[i + 2:j - 1] if depth == 0 else ""

def _resolve_vars(body):
    """A variable assigned in the same command (D=~/.claude; echo x > $D/f) is substituted before matching.
    a COMMAND-SUBSTITUTION value has no value at parse time.
    If its text names a surface root (X=$(echo ~/.claude), D=$(dirname ~/.claude/settings.json)) the var becomes that root,
    so the write rules BLOCK; otherwise it becomes an inert marker and a write to it WARNs (never a silent pass). Plain
    assignments are no longer read from "$(" or "`" values."""
    asg = []
    for m in CSUB.finditer(body):
        name, opener = m.group(1), m.group(2)
        txt = _subst_text(body, m.end() - len(opener), opener)
        root = next((r for rx, r in CSUB_ROOTS if rx.search(txt)), None)
        cmd0 = (txt.split() or [""])[0]
        val = root or ("/tmp/ctx-mktemp" if cmd0 == "mktemp" else "ctx-date" if cmd0 == "date" else "." if cmd0 == "pwd" else UNRES % name)
        asg.append((m.start(1), name, val))
    for m in ASSIGN.finditer(body):
        name, val = m.group(1), m.group(3)
        if name == "HOME" and re.match(r"[ \t]+[^\s;&|)]", body[m.end():]): continue
        if not val.startswith(("$(", "`")): asg.append((m.start(1), name, val))
    if not asg: return body
    by = {}
    for pos, name, val in sorted(asg): by.setdefault(name, []).append((pos, val))
    def sub(m):
        name = m.group(1) or m.group(2); lst = by.get(name)
        if not lst: return m.group(0)
        before = [v for pos, v in lst if pos < m.start()]
        return before[-1] if before else lst[0][1]
    body = re.sub(r"\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)\b", sub, body)
    return body

ANSI_C = re.compile(r"\$'((?:[^'\\]|\\.)*)'")

def _ansi_c(body):
    """$'...' (ANSI-C quoting): decode \\n, \\t, \\', \\\\ ... the way bash does, re-quote as '...'."""
    def dec(m):
        try: s = m.group(1).encode("latin-1", "backslashreplace").decode("unicode_escape")
        except (UnicodeDecodeError, ValueError): return m.group(0)
        return "'" + s.replace("'", "'\\''") + "'"
    return ANSI_C.sub(dec, body)

def _seps(body):
    """Newline -> ' ; ' ONLY outside quotes. A newline inside a quoted argument (python3 -c "<nl>code", node -e,
    bash -c) is part of that argument; converting it mangled multi-line -c code into unparseable text, so the code
    rule would fail open."""
    out, q, i = [], None, 0
    while i < len(body):
        c = body[i]
        if q == "'":
            if c == "'": q = None
        elif q == '"':
            if c == "\\" and i + 1 < len(body): out.append(c); i += 1; c = body[i]
            elif c == '"': q = None
        elif c in "'\"": q = c
        elif c == "\\" and i + 1 < len(body): out.append(c); i += 1; c = body[i]
        elif c == "#" and (i == 0 or body[i - 1] in " \t\n;&|()"):
            while i < len(body) and body[i] != "\n": i += 1
            continue
        elif c == "\n": out.append(" ; "); i += 1; continue
        out.append(c); i += 1
    return "".join(out)

PYC = re.compile(r"(?:^|(?<=[\s;&|(`]))(?:[\w./-]*/)?python[\d.]*(?:\s+-[A-Za-z]+)*\s+-c\s*\"")

def _pyc_params(body):
    """inside a DOUBLE-quoted python -c, bash expands $1 $@ $# $? $* before python sees the code. Replace each with 0
    so the code parses (c(){ x=$(python3 -c "print(round($1*1.05))"); }).
    Named $VARS are untouched ($HOME still resolves to the surface); single-quoted code is literal and untouched."""
    out, i = [], 0
    for m in PYC.finditer(body):
        if m.start() < i: continue
        j = m.end()
        while j < len(body) and body[j] != '"': j += 2 if body[j] == "\\" else 1
        out += [body[i:m.end()], re.sub(r"\$[0-9@#?*]", "0", body[m.end():j])]; i = j
    return "".join(out) + body[i:]

def simple_commands(cmd):
    body = _pyc_params(_resolve_vars(_uv_mktemp(_heredocs(cmd)[0])))
    body = re.sub(r"(?m)^\s*#.*$", "", body)
    lex = shlex.shlex(_seps(_ansi_c(body)), posix=True, punctuation_chars=";&|()<>")
    lex.whitespace_split = True
    lex.commenters = ""
    try: toks = list(lex)
    except ValueError: return []
    cur, out = [], []
    for t in toks:
        if t in SEP or set(t) <= set(";&|()") and t:
            if cur: out.append(cur); cur = []
        else: cur.append(t)
    if cur: out.append(cur)
    return out

def classify(cmd, cwd=None, depth=0):
    global _K8_RAW
    if depth == 0: _K8_RAW = cmd
    hits = []
    all_bodies = _heredocs(cmd)[1]
    fctx, froot = None, None
    for argv in simple_commands(cmd):
        redir, args, bodies, i = [], [], [], 0
        while i < len(argv):
            t = argv[i]
            hm = HDMARK_RE.match(t)
            if hm:
                k = int(hm.group(1))
                if k < len(all_bodies): bodies.append(all_bodies[k])
                else: NOTES.append("heredoc: unresolved placeholder, not parseable")
                i += 1; continue
            if t in (">", ">>", ">|") and i + 1 < len(argv): redir.append(argv[i + 1]); i += 2; continue
            if t == "<" and i + 1 < len(argv): i += 2; continue
            args.append(t); i += 1
        hov = None
        envs = []
        via_xargs = False
        extra = []
        while args:
            uvr = _uv_run_at(args) if args[0] == "uv" else None
            w = "uv run" if uvr else args[0]
            if w in PREFIX or w == "uv run":
                via_xargs = via_xargs or w == "xargs"
                args = args[uvr:] if w == "uv run" else args[1:]
                vals = PREFIX_VAL.get(w, set())
                while args and args[0].startswith("-") and args[0] != "--":
                    f = args.pop(0)
                    if w == "env" and (f in ("-S", "--split-string") or f.startswith("--split-string=")):
                        v_ = f.split("=", 1)[1] if "=" in f else (args.pop(0) if args else "")
                        if v_: extra.append(v_)
                        continue
                    if f in vals or (re.match(r"^-[A-Za-z]{2,}$", f) and "-" + f[-1] in vals):
                        if args and "=" not in f: args.pop(0)
                    elif f.startswith("--") and "=" not in f and args and not args[0].startswith("-"):
                        extra.append(shlex.join(args[1:]))
                if args and args[0] == "--": args = args[1:]
            elif w in RESERVED or re.match(r"^\w+=", w) or DURATION_RE.match(w):
                if w.startswith("HOME="): hov = _home_prefix(w[5:])
                if w.startswith("UV_CACHE_DIR="): envs.append(w[13:])
                args = args[1:]
            else: break
        if depth < 2:
            for e in extra:
                if e: hits += [(r, f"[wrapped] {d}") for r, d in classify(e, cwd, depth + 1)]
        for r in redir:
            s = _surface(r, cwd)
            if s: hits.append((s[0], f"redirect > {s[1]}"))
        if not args: continue
        v, rest = os.path.basename(args[0]), args[1:]
        if v == "find" or (fctx and (args[0].startswith("-") or args[0] == "!")):
            if v == "find": paths, expr = _find_split(rest); fctx = (paths, cwd)
            else: paths, expr = fctx[0], args
            for pth in paths:
                r = _find_root(pth, fctx[1])
                if r and not froot: froot = r
                d = r and _find_deletes(expr)
                if d: hits.append((r[0], f"find {d} over {r[1]}")); break
            if depth < 2:
                for k, t in enumerate(expr):
                    if t in FIND_EXEC and k + 1 < len(expr): hits += [(r, f"[find {t}] {d}") for r, d in classify(shlex.join(expr[k + 1:]), fctx[1], depth + 1)]
            if v != "find": continue
        if via_xargs and froot and v in FIND_DELV:
            hits.append((froot[0], f"xargs {v} fed by find over {froot[1]}"))
        if "--" in rest and depth < 2 and v not in ("cp", "mv", "install", "rsync", "ln", "rm", "truncate", "chmod", "chown", "tee", "touch", "unlink", "rmdir", "trash"):
            tail = rest[rest.index("--") + 1:]
            if tail: hits += [(r, f"[wrapped] {d}") for r, d in classify(shlex.join(tail), cwd, depth + 1)]
        if v in ("cd", "pushd"):
            d = rest[0] if rest and not rest[0].startswith("-") else "~"
            d = d.replace("${HOME}", HOME).replace("$HOME", HOME)
            if d.startswith("~"): d = HOME + d[1:]
            if "$" not in d and "`" not in d: cwd = os.path.normpath(os.path.join(cwd or HOME, d))
            continue
        if v == "uv" and _uv_cache_cmd(args, envs):
            hits.append(("uv_cache", _uv_cache_cmd(args, envs)))
        elif v in ("npm", "pnpm") and any(a in ("-g", "--global") for a in rest) and any(a in ("i", "install", "add", "uninstall", "remove", "rm", "un", "update", "up", "upgrade", "link") for a in rest):
            hits.append(("npm_global", " ".join(args[:6])))
        elif v == "brew" and rest[:1] == ["upgrade"]:
            hits.append(("brew_upgrade", " ".join(args[:4])))
        elif v in ("cp", "mv", "install", "rsync", "ln") and rest:
            s = _surface([a for a in rest if not a.startswith("-")][-1] if [a for a in rest if not a.startswith("-")] else "", cwd)
            if s: hits.append((s[0], f"{v} -> {s[1]}"))
            if v == "mv" or (v == "rsync" and "--remove-source-files" in rest):
                for a in [a for a in rest if not a.startswith("-")][:-1]:
                    s = next((x for e in _braces(a) for x in [_surface(e, cwd) or (_uv_del(e, cwd) if v == "mv" else None)] if x), None) or _proj_del(a, cwd, not (_proj_seat(a, cwd) and _proj_seat(a, cwd) == _proj_seat([x for x in rest if not x.startswith("-")][-1], cwd)))
                    if s: hits.append((s[0], f"{v} source {s[1]}")); break
        elif v in ("rm", "truncate", "chmod", "chown", "tee", "touch", "unlink", "rmdir", "trash") or (v in ("sed", "perl") and any(re.match(r"^-\w*i", a) for a in rest)):
            for a in rest:
                s = next((x for e in _braces(a) for x in [_surface(e, cwd) or (_uv_del(e, cwd) if v in ("rm", "rmdir", "unlink", "trash") else None)] if x), None)
                if not s and v in ("rm", "rmdir", "unlink", "trash") and not a.startswith("-"):
                    s = _proj_del(a, cwd, v == "trash" or (v == "rm" and any(re.match(r"^-\w*[rR]", x) or x == "--recursive" for x in rest)))
                if s: hits.append((s[0], f"{v} {s[1]}")); break
        elif v == "osascript":
            src = "\n".join(rest[k + 1] for k in range(len(rest) - 1) if rest[k] == "-e") if "-e" in rest[:-1] else _K8_RAW
            if re.search(r"\bdelete\b", src, re.I) or re.search(r"\bmove\b.*\bto\s+(?:the\s+)?trash\b", src, re.I | re.S):
                for pth in re.findall(r'"([^"]*)"', src):
                    s = _surface(pth, cwd) or _uv_del(pth, cwd)
                    if s: hits.append((s[0], f"osascript Finder delete {s[1]}")); break
        elif re.match(r"^(python[\d.]*|node)$", v):
            if (not rest or rest[0] == "-") and bodies:
                for b in bodies:
                    n0 = len(NOTES); hits += _lang_hits(_heredoc_body(b), v, cwd, "heredoc")
                    if _k8_note(n0): hits += _k8_hits(_heredoc_body(b), cwd, hov, "unparseable heredoc code") or _k8_hits(_K8_RAW, cwd, hov, "command with unparseable heredoc code")
                continue
            def _own(valued_unknown):
                own, j = [], 0
                while j < len(rest) and rest[j].startswith("-") and rest[j] != "--":
                    own.append(rest[j])
                    if rest[j] in ("-c", "-e", "-m"): break
                    nxt = j + 1 < len(rest) and not rest[j + 1].startswith("-")
                    j += 2 if rest[j] in ("-W", "-X", "-Q") or (valued_unknown and nxt and rest[j] not in INTERP_FLAG_ONLY and "=" not in rest[j]) else 1
                return own
            own = _own(False) + _own(True)
            if "-c" in own or "-e" in own:
                i = rest.index("-c") if "-c" in own else rest.index("-e")
                if i + 1 < len(rest):
                    n0 = len(NOTES); hits += _lang_hits(rest[i + 1], v, cwd, "inline")
                    if _k8_note(n0): hits += _k8_hits(rest[i + 1], cwd, hov, "unparseable inline code") or _k8_hits(_K8_RAW, cwd, hov, "command with unparseable inline code")
                continue
            script = next((a for a in rest if not a.startswith("-")), None)
            if script:
                n0 = len(NOTES); hits += _script_hits(script, v, cwd, depth, hov)
                if _k8_note(n0): hits += _k8_hits(shlex.join(rest[rest.index(script) + 1:]), cwd, hov, "args of an uninspected script")
        elif v in ("bash", "sh", "zsh"):
            noexec, inline, si, stdin = _sh_invocation(rest)
            if noexec: continue
            if inline is not None:
                if depth < 2: hits += classify(_restore(inline, all_bodies), cwd, depth + 1)
                continue
            if (si is None or stdin) and bodies and depth < 2:
                for b in bodies: hits += classify(_heredoc_body(b), cwd, depth + 1)
                continue
            if si is not None:
                script = rest[si]
                n0 = len(NOTES); hits += _script_hits(script, "bash", cwd, depth, hov)
                if _k8_note(n0): hits += _k8_hits(shlex.join(rest[si + 1:]), cwd, hov, "args of an uninspected script")
        elif args[0].endswith((".py", ".sh", ".js", ".mjs")) and ("/" in args[0]):
            n0 = len(NOTES); hits += _script_hits(args[0], {".py": "python3", ".sh": "bash"}.get(os.path.splitext(args[0])[1], "node"), cwd, depth, hov)
            if _k8_note(n0): hits += _k8_hits(shlex.join(rest), cwd, hov, "args of an uninspected script")
    return hits

PROJ = os.path.join(HOME, ".claude", "projects")
PROJ_WALK = 5000
PROJ_SAMPLE = ("memory", "MEMORY.md", "0123abcd-0123-4567-89ab-0123456789ab.jsonl", "x.jsonl")

def _proj_seat(path, cwd):
    """The seat dir a path is under (~/.claude/projects/<seat>), or None."""
    p = path.replace("${HOME}", HOME).replace("$HOME", HOME)
    if p.startswith("~/") or p == "~": p = HOME + p[1:]
    p = os.path.normpath(os.path.join(cwd or HOME, p))
    return os.path.join(PROJ, p[len(PROJ) + 1:].split(os.sep)[0]) if p.startswith(PROJ + os.sep) else None

def _proj_has_jsonl(d):
    n = 0
    for _, dirs, files in os.walk(d):
        n += len(dirs) + len(files)
        if n > PROJ_WALK or any(f.endswith(".jsonl") for f in files): return True
    return False

def _proj_del(path, cwd, rec):
    """A delete target under ~/.claude/projects that the projects rule protects -> ("claude_config", detail), else None."""
    for e in _braces(path):
        p = e.replace("${HOME}", HOME).replace("$HOME", HOME)
        if p.startswith("~/") or p == "~": p = HOME + p[1:]
        if "$" in p or "`" in p: continue
        p = os.path.normpath(os.path.join(cwd or HOME, p))
        if not p.startswith(PROJ + os.sep): continue
        rel = p[len(PROJ) + 1:].split(os.sep)
        glob = lambda c: any(ch in c for ch in "*?[" + BRACE_GLOB)
        if len(rel) == 1 or glob(rel[0]): return "claude_config", f"projects seat {p}"
        c1 = rel[1]
        if glob(c1):
            if any(fnmatch.fnmatchcase(n, c1.replace(BRACE_GLOB, "*")) for n in PROJ_SAMPLE) or len(rel) > 2:
                return "claude_config", f"projects glob {p}"
            continue
        if c1 == "memory":
            if len(rel) == 2: return "claude_config", f"projects memory dir {p}"
            if any(glob(c) for c in rel[2:]) or rel[2] == "MEMORY.md" or rec: return "claude_config", f"projects memory {p}"
            continue
        if p.endswith(".jsonl") or any(glob(c) for c in rel[2:]): return "claude_config", f"projects transcript {p}"
        if rec and os.path.isdir(p) and _proj_has_jsonl(p): return "claude_config", f"projects dir with transcripts {p}"
    return None

FIND_DELV = {"rm", "rmdir", "unlink", "trash", "mv", "shred"}
FIND_WRV = {"truncate", "chmod", "chown", "chgrp", "tee", "touch", "dd", "xattr", "chflags"}
FIND_EXEC = {"-exec", "-execdir", "-ok", "-okdir"}
FIND_OPT = {"-H", "-L", "-P", "-E", "-X", "-d", "-s", "-x"}

def _find_split(rest):
    """find argv (after "find") -> (start paths, expression tokens). BSD: [-H|-L|-P] [-EXdsx] [-f path] path ... [expression]."""
    paths, i = [], 0
    while i < len(rest) and rest[i] in FIND_OPT | {"-f"}:
        if rest[i] == "-f" and i + 1 < len(rest): paths.append(rest[i + 1]); i += 1
        i += 1
    while i < len(rest) and not rest[i].startswith("-") and rest[i] not in ("!", "(", ")"):
        paths.append(rest[i]); i += 1
    return paths or ["."], rest[i:]

def _find_deletes(expr):
    """-> a short description if the expression deletes, else None."""
    if "-delete" in expr: return "-delete"
    for k, t in enumerate(expr):
        if t not in FIND_EXEC: continue
        cmd = expr[k + 1:]
        while cmd and (os.path.basename(cmd[0]) in PREFIX or re.match(r"^\w+=", cmd[0])): cmd = cmd[1:]
        while cmd and cmd[0].startswith("-") and os.path.basename(cmd[0]) not in FIND_DELV: cmd = cmd[1:]
        if not cmd: continue
        c0 = os.path.basename(cmd[0])
        if c0 in FIND_DELV: return f"{t} {c0}"
        a = cmd[1:cmd.index("+")] if "+" in cmd else cmd[1:]
        nf = [x for x in a if not x.startswith("-")]
        if c0 in FIND_WRV and any("{}" in x for x in a): return f"{t} {c0} (write)"
        if c0 in ("sed", "perl") and any("{}" in x for x in a) and any(re.match(r"^-\w*i", x) for x in a): return f"{t} {c0} -i (write)"
        if c0 in ("cp", "install", "rsync", "ln") and nf and nf[-1] == "{}": return f"{t} {c0} onto {{}} (write)"
        if c0 in ("sh", "bash", "zsh", "dash"):
            code = _sh_invocation(cmd[1:])[1] or ""
            if re.search(r"(?:^|[\s;&|(`])(?:\S*/)?(?:rm|rmdir|unlink|trash|mv|shred)\b", code): return f"{t} {c0} -c deleting"
            if re.search(r"""(?<![0-9&])>{1,2}\|?\s*["']?\$""", code) or \
               re.search(r"(?:^|[\s;&|(`])(?:\S*/)?(?:truncate|chmod|chown|tee|touch|dd)\b|\b(?:sed|perl)\s+(?:\S+\s+)*?-\w*i", code):
                return f"{t} {c0} -c writing"
    return None

def _find_root(path, cwd):
    """A find start path IN a root, or an ancestor of / glob reaching ANY root -> (rule, path)."""
    for e in _braces(path):
        s = _surface(e, cwd)
        if s: return s
        p = e.replace("${HOME}", HOME).replace("$HOME", HOME)
        if p.startswith("~/") or p == "~": p = HOME + p[1:]
        if "$" in p or "`" in p: continue
        p = os.path.normpath(os.path.join(cwd or HOME, p))
        for root, rule in ROOTS:
            if any((p + os.sep).startswith(x) for x in EXEMPT): return _proj_del(p, cwd, True)
            if _comp_match(p, root): return rule, p
    return None

SH_VALUE_LONG = ("--rcfile", "--init-file")

def _sh_invocation(rest):
    """-> (noexec, inline_code|None, script_index|None, stdin). Options end at the first non-option word, a lone "-", or "--".
    -/+ clusters are read letter by letter: c (in a - cluster) = the first non-option word is inline code; o/O consume the
    next word (so do -o/+o/-O/+O and --rcfile/--init-file); n and "o noexec" set noexec by sign, LAST FLAG WINS (bash 3.2,
    sh and zsh all run "-n +n w.sh"). Unknown long options are flag-only (--norc, --login, --posix ...)."""
    noexec, want_c, stdin, i = False, False, False, 0
    while i < len(rest):
        a = rest[i]
        if a == "--": i += 1; break
        if a == "-": stdin = True; i += 1; break
        if a in SH_VALUE_LONG: i += 2; continue
        if a.startswith("--"): i += 1; continue
        if len(a) > 1 and a[0] in "-+" and a[1:].isalnum():
            sign, take = a[0], 0
            for ch in a[1:]:
                if ch == "n": noexec = sign == "-"
                elif ch == "c" and sign == "-": want_c = True
                elif ch == "s" and sign == "-": stdin = True
                elif ch in "oO":
                    take += 1
                    val = rest[i + take] if i + take < len(rest) else ""
                    if ch == "o" and val == "noexec": noexec = sign == "-"
            i += 1 + take; continue
        break
    if want_c: return noexec, (rest[i] if i < len(rest) else None), None, stdin
    return noexec, None, (i if i < len(rest) and not stdin else None), stdin

SCRIPT_MAX = 256 * 1024
NOTES = []

_K8_RAW = ""
K8_RE = re.compile(r"(?:~" + re.escape(os.path.basename(HOME)) + r"|~|\$\{?HOME\}?|" + re.escape(HOME) + r")/\.claude[^\s'\"`;|&<>()]*", re.I)

def _k8_norm(text):
    """The fail-closed SCOPE normalisation, real-home root kept: quotes stripped ("$HOME"/.claude), // and /./
    collapsed (/Users/me//.claude, ~/./.claude); K8_RE is case-insensitive (~/.CLAUDE)."""
    t = re.sub(r"[\"']", "", text or "")
    t = re.sub(r"/(?:\./)+", "/", t)
    return re.sub(r"/{2,}", "/", t)

def _k8_note(n0):
    """True if the analysis that just ran recorded unparseable code or an over-cap script (NOTES grew from n0)."""
    return any("not parseable" in n or n.endswith("B: not inspected") for n in NOTES[n0:])

def _k8_hits(text, cwd, hov, why):
    for m in K8_RE.finditer(_k8_norm(text)):
        tok = m.group(0)
        if tok.startswith("~" + os.path.basename(HOME)): tok = HOME + tok[len(os.path.basename(HOME)) + 1:]
        if hov and not tok.lower().startswith(HOME.lower()): continue
        tok = re.sub(r"/\.claude", "/.claude", tok, count=1, flags=re.I)
        if tok.lower().startswith(HOME.lower()): tok = HOME + tok[len(HOME):]
        s = _surface(tok, cwd)
        if s: return [(s[0], f"[k8] {why} names {s[1]}")]
    return []

def _heredoc_body(b):
    lines = b.split("\n")
    body = lines[1:-1] if len(lines) >= 2 else []
    if b.startswith("<<-"): body = [l.lstrip("\t") for l in body]
    return "\n".join(body)

def _lang_hits(code, v, cwd, how):
    if v.startswith("python"):
        targets, note, shells = codewrites.py_targets(code)
        if note: NOTES.append(f"{how}: {note}")
        for sh in shells:
            h = classify(sh, cwd, 2)
            if h: return [(h[0][0], f"[code] {v} {how} runs: {h[0][1]}")]
    else:
        targets = codewrites.js_targets(code)
    for t in targets:
        if t.endswith((".log", ".jsonl")): continue
        s = _surface(t, cwd)
        if s: return [(s[0], f"[code] {v} {how} writes {s[1]}")]
    return []

HOME_SET = re.compile(r"\bHOME\s*\+?=|environ\s*\[\s*['\"]HOME['\"]\s*\]\s*=|env\.HOME\s*=|putenv\s*\(\s*['\"]HOME|"
                      r"setdefault\s*\(\s*['\"]HOME|environ\.update\b")

def _home_prefix(val):
    """value of a HOME=<val> command prefix -> the child's HOME, or None (= keep the real HOME, fail toward hitting).
    Only a literal absolute path that is not the real home counts; ~ / $ / ` / relative values keep the real HOME."""
    if val.startswith("~"): val = HOME + val[1:]
    if not val.startswith("/") or "$" in val or "`" in val: return None
    val, rh = os.path.realpath(val), os.path.realpath(HOME)
    if val == rh: return None
    if val.startswith(rh + os.sep): return HOME + val[len(rh):]
    if rh.startswith(val + os.sep):
        h = HOME
        for _ in os.path.relpath(rh, val).split(os.sep): h = os.path.dirname(h)
        return h
    return val

def _script_hits(path, v, cwd, depth, hov=None):
    global HOME
    p = os.path.normpath(os.path.join(cwd or HOME, os.path.expanduser(path.replace("$HOME", HOME).replace("${HOME}", HOME))))
    try:
        if not os.path.isfile(p): return []
        if os.path.getsize(p) > SCRIPT_MAX: NOTES.append(f"script {p} > {SCRIPT_MAX} B: not inspected"); return []
        code = open(p, encoding="utf-8", errors="replace").read()
        if hov and HOME_SET.search(code): hov = None
    except OSError as e:
        NOTES.append(f"script {p} unreadable ({type(e).__name__}): not inspected"); return []
    if v == "bash" and depth >= 2: NOTES.append(f"script {p}: nesting > 2, not inspected"); return []
    real, HOME, codewrites.HOME = HOME, hov or HOME, hov or codewrites.HOME
    try:
        if v == "bash": return [(r, f"[code] script {os.path.basename(p)}: {d}") for r, d in classify(code, cwd, depth + 1)]
        return [(r, d.replace(" script ", " ").replace("[code] ", f"[code] script {os.path.basename(p)}: ", 1)) for r, d in _lang_hits(code, v, cwd, "file")]
    finally:
        HOME = codewrites.HOME = real

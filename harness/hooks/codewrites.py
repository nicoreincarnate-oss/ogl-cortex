"""Code write-target analysis for the shared-surface guard v2.
A hit needs a WRITE CALL whose TARGET resolves to a path; string literals that are only data are never targets.
python: ast (variables, Path.home(), expanduser, os.path.join, '/', f-strings, os.environ HOME). A SyntaxError means
the code cannot run, so it cannot write: no hit (noted). node: write calls on resolvable string/path.join/homedir args.
Unresolvable targets are not hits (known limit: computed in loops, read from files, passed through functions)."""
import ast, os, re, shlex
HOME = os.path.expanduser("~")

def _dotted(n):
    parts = []
    while isinstance(n, ast.Attribute): parts.append(n.attr); n = n.value
    if isinstance(n, ast.Name): parts.append(n.id)
    elif isinstance(n, ast.Call): parts.append(_dotted(n.func) + "()")
    d = ".".join(reversed(parts))
    head, _, tail = d.partition(".")
    if head in _ALIAS: d = _ALIAS[head] + ("." + tail if tail else "")
    return d

_ALIAS = {}

PASSTHRU = {"str", "Path", "pathlib.Path", "PurePath", "os.fspath", "os.path.abspath", "os.path.realpath", "os.path.normpath"}

def _val(n, env):
    """Resolve a path-ish expression to a string, else None."""
    if isinstance(n, ast.Constant) and isinstance(n.value, str): return n.value
    if isinstance(n, ast.Name): return env.get(n.id)
    if isinstance(n, ast.JoinedStr):
        out = []
        for v in n.values:
            x = str(v.value) if isinstance(v, ast.Constant) else _val(v.value, env) if isinstance(v, ast.FormattedValue) else None
            if x is None: return None
            out.append(x)
        return "".join(out)
    if isinstance(n, ast.BinOp) and isinstance(n.op, (ast.Div, ast.Add)):
        a, b = _val(n.left, env), _val(n.right, env)
        if a is None or b is None: return None
        return os.path.join(a, b) if isinstance(n.op, ast.Div) else a + b
    if isinstance(n, ast.Subscript) and _dotted(n.value) == "os.environ" and _val(n.slice, env) == "HOME": return HOME
    if isinstance(n, ast.Call):
        f = _dotted(n.func); args = [_val(a, env) for a in n.args]
        if f.endswith("Path.home") or f.endswith("home") and f.startswith("Path"): return HOME
        if f in ("os.environ.get", "os.getenv") and args[:1] == ["HOME"]: return HOME
        if f == "os.path.expanduser" and args and args[0] is not None: return os.path.expanduser(args[0]).replace(os.path.expanduser("~"), HOME, 1)
        if f == "os.path.join" and args and all(a is not None for a in args): return os.path.join(*args)
        if f in PASSTHRU and len(args) == 1: return args[0]
        if isinstance(n.func, ast.Attribute) and n.func.attr in ("expanduser", "resolve", "absolute") and not n.args:
            base = _val(n.func.value, env)
            return None if base is None else base.replace("~", HOME, 1) if base.startswith("~") else base
        if isinstance(n.func, ast.Attribute) and n.func.attr == "joinpath":
            base = _val(n.func.value, env)
            return os.path.join(base, *args) if base is not None and all(a is not None for a in args) else None
    return None

def _mode_writes(m): return m is not None and any(c in m for c in "wax+")
T0 = {"os.remove", "os.unlink", "os.rmdir", "os.removedirs", "shutil.rmtree", "os.chmod", "os.chown", "os.truncate",
      "os.makedirs", "os.mkdir", "os.utime", "os.lchmod"}
T1 = {"os.replace": True, "os.rename": True, "shutil.move": True, "shutil.copy": False, "shutil.copy2": False,
      "shutil.copyfile": False, "shutil.copytree": False, "os.link": False, "os.symlink": False}
SHELL_CALLS = {"subprocess.run", "subprocess.call", "subprocess.check_call", "subprocess.check_output", "subprocess.Popen",
               "os.system", "os.popen"}
PATH_METHODS = {"write_text", "write_bytes", "touch", "unlink", "mkdir", "rmdir", "chmod", "symlink_to", "hardlink_to"}

def py_targets(code):
    """-> (targets, note). targets = resolved paths that a write call in `code` writes, renames or deletes."""
    import warnings
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            tree = ast.parse(code)
    except (SyntaxError, ValueError) as e: return [], f"python not parseable ({type(e).__name__}): cannot run, so no write", []
    _ALIAS.clear()
    for n in ast.walk(tree):
        if isinstance(n, ast.Import):
            for a in n.names:
                if a.asname: _ALIAS[a.asname] = a.name
        elif isinstance(n, ast.ImportFrom) and n.module:
            for a in n.names: _ALIAS[a.asname or a.name] = n.module + "." + a.name
    env = {}; shells = []
    nodes = sorted((n for n in ast.walk(tree) if isinstance(n, (ast.Assign, ast.AnnAssign, ast.Call))),
                   key=lambda n: (n.lineno, n.col_offset))
    out = []
    for n in nodes:
        if isinstance(n, ast.Assign):
            v = _val(n.value, env)
            for t in n.targets:
                if isinstance(t, ast.Name):
                    if v is None: env.pop(t.id, None)
                    else: env[t.id] = v
            continue
        if isinstance(n, ast.AnnAssign):
            if isinstance(n.target, ast.Name) and n.value is not None:
                v = _val(n.value, env)
                if v is None: env.pop(n.target.id, None)
                else: env[n.target.id] = v
            continue
        f = _dotted(n.func)
        kw = {k.arg: k.value for k in n.keywords if k.arg}
        if f in SHELL_CALLS and n.args:
            a0 = n.args[0]
            if isinstance(a0, (ast.List, ast.Tuple)):
                parts = [_val(e, env) for e in a0.elts]
                if parts and all(x is not None for x in parts): shells.append(" ".join(shlex.quote(x) for x in parts))
            else:
                x = _val(a0, env)
                if x is not None: shells.append(x)
            continue
        tgt = []
        if f in ("open", "io.open", "builtins.open"):
            mode = n.args[1] if len(n.args) > 1 else kw.get("mode")
            if mode is not None and _mode_writes(_val(mode, env)) and n.args: tgt.append(n.args[0])
        elif isinstance(n.func, ast.Attribute) and n.func.attr == "open":
            mode = n.args[0] if n.args else kw.get("mode")
            if mode is not None and _mode_writes(_val(mode, env)): tgt.append(n.func.value)
        elif f in T0 and n.args: tgt.append(n.args[0])
        elif f in T1 and len(n.args) > 1:
            tgt.append(n.args[1])
            if T1[f]: tgt.append(n.args[0])
        elif isinstance(n.func, ast.Attribute) and n.func.attr in PATH_METHODS: tgt.append(n.func.value)
        elif (isinstance(n.func, ast.Attribute) and n.func.attr in ("rename", "replace") and not f.startswith("os.")
              and (len(n.args) == 1 or (not n.args and "target" in kw))):
            tgt += [n.func.value, n.args[0] if n.args else kw["target"]]
        for t in tgt:
            p = _val(t, env)
            if p is not None: out.append(p)
    return out, None, shells

JS_CALL = re.compile(r"(?:\bfs|\brequire\(\s*['\"](?:node:)?fs(?:/promises)?['\"]\s*\))(?:\.promises)?\.(writeFileSync|appendFileSync|writeFile|appendFile|rmSync|unlinkSync|unlink|rmdirSync|"
                     r"mkdirSync|copyFileSync|copyFile|renameSync|rename|cpSync|symlinkSync|chmodSync|truncateSync)\s*\(")
JS_T1 = {"copyFileSync", "copyFile", "renameSync", "rename", "cpSync", "symlinkSync"}

def _js_args(code, i):
    depth, cur, args, q = 0, "", [], None
    while i < len(code):
        c = code[i]
        if q:
            cur += c
            if c == q and code[i - 1] != "\\": q = None
        elif c in "'\"`": q = c; cur += c
        elif c in "([{": depth += 1; cur += c
        elif c in ")]}":
            if depth == 0: args.append(cur.strip()); return args
            depth -= 1; cur += c
        elif c == "," and depth == 0: args.append(cur.strip()); cur = ""
        else: cur += c
        i += 1
    return args

def _js_split_plus(e):
    depth, q, cur, out = 0, None, "", []
    for i, c in enumerate(e):
        if q:
            cur += c
            if c == q and e[i - 1] != "\\": q = None
        elif c in "'\"`": q = c; cur += c
        elif c in "([{": depth += 1; cur += c
        elif c in ")]}": depth -= 1; cur += c
        elif c == "+" and depth == 0: out.append(cur); cur = ""
        else: cur += c
    return out + [cur]

def _js_val(e, env):
    e = e.strip()
    parts = _js_split_plus(e)
    if len(parts) > 1:
        vals = [_js_val(p, env) for p in parts]
        return "".join(vals) if all(v is not None for v in vals) else None
    if re.fullmatch(r"(['\"])[^'\"]*\1", e): return e[1:-1]
    if re.fullmatch(r"`[^`]*`", e):
        s = e[1:-1]
        s = re.sub(r"\$\{\s*(?:os\.homedir\(\)|process\.env\.HOME)\s*\}", HOME, s)
        s = re.sub(r"\$\{\s*(\w+)\s*\}", lambda m: env.get(m.group(1), "\x00"), s)
        return None if "\x00" in s or "${" in s else s
    if e in ("os.homedir()", "process.env.HOME", "require('os').homedir()", 'require("os").homedir()'): return HOME
    if re.fullmatch(r"\w+", e): return env.get(e)
    m = re.fullmatch(r"path\.(join|resolve)\((.*)\)", e, re.S)
    if m:
        parts = [_js_val(a, env) for a in _js_args(m.group(2) + ")", 0)]
        return os.path.join(*parts) if parts and all(p is not None for p in parts) else None
    return None

def js_targets(code):
    env = {}
    for m in re.finditer(r"\b(?:const|let|var)\s+(\w+)\s*=\s*([^;\n]+)", code):
        v = _js_val(m.group(2), env)
        if v is not None: env[m.group(1)] = v
    out = []
    for m in JS_CALL.finditer(code):
        args = _js_args(code, m.end())
        idx = [1] if m.group(1) in JS_T1 else [0]
        if m.group(1) in ("renameSync", "rename"): idx.append(0)
        for i in idx:
            if i < len(args):
                v = _js_val(args[i], env)
                if v is not None: out.append(v)
    return out

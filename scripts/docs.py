#!/usr/bin/env python3
"""Helpers for `scripts/build-docs.sh`.

Subcommands:

  logo <src> <dst> <hex>  Recolour a monochrome logo to <hex> on a transparent
                          background (one mark that suits a light or dark cover).


  expand <spine.md>   Expand `<!--snippet ...-->` directives in the architecture
                      spine into fenced code blocks pulled *fresh* from source,
                      so the call-stack walkthrough never drifts from the code.
                      Backs the default (hand-curated) docs mode.

  callgraph           Emit the architecture part automatically: index every fn
                      under each seed's roots, then DFS the real call graph from
                      the seed functions (android_main + the two build entry
                      points). Backs the `callgraph` docs mode. See CALLGRAPH_SEEDS.

  clean  <doc.md>     Normalise a Docusaurus markdown page for offline PDF use:
                      strip YAML frontmatter (emit its title as an `# H1`), drop
                      MDX import/export, <Tabs>/<TabItem> and `{/* … */}` comments,
                      remove `{/* hide-in-pdf */}`…`{/* /hide-in-pdf */}` regions
                      (content shown only in the in-app installer iframe), flatten
                      admonitions, and either embed images (resolving /img paths
                      against $DOCS_STATIC, converting webp via dwebp/sips into
                      $DOCS_IMGOUT) or, if unset/unavailable, demote them to alt
                      text (xelatex aborts on a missing or webp image).

Snippet directive forms (one per line):

  <!--snippet file=PATH fn=NAME [nth=N] [lang=LANG]-->     a brace-delimited fn
  <!--snippet file=PATH struct=NAME -->                    a struct/enum/impl ...
  <!--snippet file=PATH lines=A-B [lang=LANG]-->           a literal line range
  <!--snippet file=PATH [lang=LANG]-->                     the whole file

The fn/struct/enum/impl matcher counts braces while skipping comments, char
literals, lifetimes, and (raw/byte) strings — the codebase embeds shell here-docs
full of unbalanced `{{ }}` inside `r#"..."#`, which a naive counter mishandles.
"""
import os
import re
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

LANG_BY_EXT = {
    ".rs": "rust", ".sh": "bash", ".toml": "toml", ".yaml": "yaml",
    ".yml": "yaml", ".json": "json", ".xml": "xml", ".java": "java",
    ".js": "javascript", ".css": "css", ".md": "markdown",
}

# Item-kind directive attr -> Rust keyword to search for.
KINDS = {"fn": "fn", "struct": "struct", "enum": "enum", "impl": "impl",
         "trait": "trait", "type": "type", "const": "const", "static": "static"}

# Skip-rules applied while scanning a Rust item body, longest-match first.
_LINE_COMMENT = re.compile(r"//.*")
_BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.S)
_RAW_STR = re.compile(r'b?r(#*)"')          # r"..", r#".."#, br#".."# ...
_STR = re.compile(r'b?"(?:\\.|[^"\\])*"', re.S)
_CHAR = re.compile(r"'(?:\\.|[^'\\])'")     # a char literal (not a lifetime)


def lang_for(path):
    return LANG_BY_EXT.get(os.path.splitext(path)[1], "text")


def _decl_pos(src, keyword, name, nth):
    pat = re.compile(r"\b" + re.escape(keyword) + r"\s+" + re.escape(name) + r"\b")
    for i, m in enumerate(pat.finditer(src), start=1):
        if i == nth:
            return m.start()
    raise SystemExit(f"docs.py: `{keyword} {name}` (#{nth}) not found")


def _expand_back_over_attrs(src, decl_pos):
    """Include the doc-comments / #[attributes] sitting directly above a decl."""
    start = src.rfind("\n", 0, decl_pos) + 1
    while start > 0:
        prev_nl = start - 1
        line_start = src.rfind("\n", 0, prev_nl) + 1
        stripped = src[line_start:prev_nl].strip()
        is_attr = stripped.startswith("#[") or stripped.startswith("#![")
        is_doc = stripped.startswith("///") or stripped.startswith("//!")
        if is_attr or is_doc:
            start = line_start
        else:
            break
    return start


def _match_body(src, decl_pos):
    """Return the index just past the `}` closing the item's first `{`."""
    i, n, depth, opened = decl_pos, len(src), 0, False
    while i < n:
        c = src[i]
        if c == "/" and i + 1 < n and src[i + 1] == "/":
            m = _LINE_COMMENT.match(src, i)
            i = m.end()
            continue
        if c == "/" and i + 1 < n and src[i + 1] == "*":
            m = _BLOCK_COMMENT.match(src, i)
            i = m.end() if m else n
            continue
        if c in "rb":
            m = _RAW_STR.match(src, i)
            if m:
                close = '"' + "#" * len(m.group(1))
                j = src.find(close, m.end())
                i = (j + len(close)) if j >= 0 else n
                continue
        if c == '"' or (c == "b" and i + 1 < n and src[i + 1] == '"'):
            m = _STR.match(src, i)
            if m:
                i = m.end()
                continue
        if c == "'":
            m = _CHAR.match(src, i)
            if m:                       # a real char literal
                i = m.end()
            else:                       # a lifetime like 'a — skip just the tick
                i += 1
            continue
        if c == "{":
            depth += 1
            opened = True
        elif c == "}":
            depth -= 1
            if opened and depth == 0:
                return i + 1
        i += 1
    raise SystemExit(f"docs.py: unbalanced braces from offset {decl_pos}")


def extract(attrs):
    path = attrs["file"]
    abs_path = path if os.path.isabs(path) else os.path.join(ROOT, path)
    with open(abs_path, encoding="utf-8") as fh:
        src = fh.read()
    lang = attrs.get("lang", lang_for(path))

    if "lines" in attrs:
        a, b = (int(x) for x in attrs["lines"].split("-"))
        body = "\n".join(src.splitlines()[a - 1:b])
    elif any(k in attrs for k in KINDS):
        kind = next(k for k in KINDS if k in attrs)
        name, nth = attrs[kind], int(attrs.get("nth", 1))
        pos = _decl_pos(src, KINDS[kind], name, nth)
        body = src[_expand_back_over_attrs(src, pos):_match_body(src, pos)]
    else:
        body = src.rstrip("\n")

    fence = "~" * 5  # tilde fence won't collide with ``` inside the source
    return f"{fence} {{.{lang}}}\n{body.rstrip()}\n{fence}"


_DIRECTIVE = re.compile(r"<!--\s*snippet\s+(.*?)\s*-->\s*$")


def cmd_expand(spine):
    in_comment = False
    with open(spine, encoding="utf-8") as fh:
        for line in fh:
            stripped = line.rstrip("\n")
            # Swallow non-directive HTML comment blocks (maintainer notes): pandoc
            # mishandles a stray `-->` inside one, leaking prose into the PDF.
            if in_comment:
                in_comment = "-->" not in stripped
                continue
            m = _DIRECTIVE.match(stripped)
            if m:
                attrs = dict(tok.split("=", 1) for tok in m.group(1).split() if "=" in tok)
                sys.stdout.write(extract(attrs) + "\n")
                continue
            if stripped.lstrip().startswith("<!--") and "-->" not in stripped:
                in_comment = True
                continue
            sys.stdout.write(line)


# --- Docusaurus markdown cleaning --------------------------------------------
_IMG = re.compile(r"!\[([^\]]*)\]\(([^)]*)\)")
# Emoji / pictographs / variation selectors — Cardo and the mono code font carry
# none of these, so xelatex would emit "missing character" boxes. Strip them from
# prose (code snippets come through `expand`, untouched, to preserve fidelity).
_EMOJI = re.compile(
    "[\U0001F000-\U0001FAFF\U00002600-\U000027BF\U00002300-\U000023FF"
    "\U0001F1E6-\U0001F1FF\U0000FE0F\U0000200D\U00002B00-\U00002BFF]"
)
_ADMONITION = re.compile(r"^\s*:::(\w+)?(.*)$")
_DROP_LINE = re.compile(r"^\s*(import\s|export\s|</?(Tabs|TabItem)\b)")
_FENCE = re.compile(r"^(\s*)(`{3,}|~{3,})(.*)$")
_HEADING = re.compile(r"^(#{1,6})(\s.*)$")
# Content meant only for the in-app installer iframe (setup-progress.html embeds
# the live getting-started page). Authored with MDX comments so it stays visible
# on the website but is dropped from the PDFs. Also strip any stray MDX comment.
_HIDE_REGION = re.compile(r"\{/\*\s*hide-in-pdf\b.*?\*/\}.*?\{/\*\s*/hide-in-pdf\s*\*/\}", re.S)
_MDX_COMMENT = re.compile(r"\{/\*.*?\*/\}", re.S)


def _title_from_frontmatter(text):
    if not text.startswith("---"):
        return None, text
    end = text.find("\n---", 3)
    if end < 0:
        return None, text
    fm, rest = text[3:end], text[end + 4:]
    m = re.search(r"^title:\s*(.+)$", fm, re.M)
    title = m.group(1).strip().strip("\"'") if m else None
    return title, rest.lstrip("\n")


def _prep_image(src, imgout):
    """Return a PDF-embeddable path for `src`: prefer sips (convert→png + cap the
    long edge so the PDF stays light); fall back to dwebp for webp; use png/jpg/pdf
    as-is. Returns None if it can't be embedded. Results are cached in imgout."""
    ext = os.path.splitext(src)[1].lower()
    dst = os.path.join(imgout, os.path.splitext(os.path.basename(src))[0] + ".png") if imgout else None
    if dst and os.path.isfile(dst):
        return dst
    if imgout and shutil.which("sips"):
        os.makedirs(imgout, exist_ok=True)
        subprocess.run(["sips", "-s", "format", "png", "-Z", "1400", src, "--out", dst],
                       capture_output=True)
        if os.path.isfile(dst):
            return dst
    if ext == ".webp":                                     # no sips: dwebp, no resize
        if dst and shutil.which("dwebp"):
            os.makedirs(imgout, exist_ok=True)
            subprocess.run(["dwebp", src, "-o", dst], capture_output=True)
            return dst if os.path.isfile(dst) else None
        return None
    if ext in (".png", ".jpg", ".jpeg", ".pdf"):
        return src
    return None


def _image(alt, url, doc_path):
    """Embed a resolvable local image; else demote to italic alt text. Needs
    $DOCS_STATIC (the gh-pages static/ root) to resolve Docusaurus `/img/...`."""
    alt = _EMOJI.sub("", alt)
    demote = f"*(figure: {alt or 'image'})*"
    static = os.environ.get("DOCS_STATIC")
    if not static or url.startswith(("http://", "https://", "data:")):
        return demote
    rel = url.split("#", 1)[0].split("?", 1)[0]            # drop #boxed / query
    if rel.startswith("/"):
        src = os.path.join(static, rel.lstrip("/"))
    else:
        src = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(doc_path)), rel))
    if not os.path.isfile(src):
        return demote
    prepared = _prep_image(src, os.environ.get("DOCS_IMGOUT"))
    if not prepared:
        return demote
    # Emit a repo-relative path so it resolves under both the local run (cwd=repo
    # root) and the Docker fallback (-w /data, the repo mounted).
    return f"![{alt}]({os.path.relpath(prepared, ROOT)})"


def cmd_clean(path):
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    title, body = _title_from_frontmatter(text)
    body = _MDX_COMMENT.sub("", _HIDE_REGION.sub("", body))
    # Synthesise an `# H1` only when the page doesn't already open with one
    # (the README does; the numbered Docusaurus pages carry theirs in frontmatter).
    if not title and not re.match(r"\s*#\s", body):
        stem = os.path.splitext(os.path.basename(path))[0]
        stem = re.sub(r"^\d+[-_]?", "", stem)          # drop sidebar prefixes
        title = stem.replace("-", " ").replace("_", " ").strip().title()

    # Demote every heading by $DOCS_HSHIFT levels (used to nest e.g. blog posts
    # under an outer "# Blog" section), capped at H6.
    shift = int(os.environ.get("DOCS_HSHIFT", "0"))
    out = ([f"{'#' * min(6, 1 + shift)} {_EMOJI.sub('', title).strip()}", ""] if title else [])
    fence = None                       # active code-fence marker, or None
    for line in body.splitlines():
        fm = _FENCE.match(line)
        if fence is not None:          # inside a code block: copy verbatim
            out.append(line)
            if fm and fm.group(2)[0] == fence[0] and len(fm.group(2)) >= len(fence) \
                    and not fm.group(3).strip():
                fence = None           # matching closing fence
            continue
        if fm:                         # opening fence — tag bare ones so every code
            fence = fm.group(2)        # block gets pandoc's boxed Shaded treatment
            out.append(line if fm.group(3).strip() else f"{fm.group(1)}{fence}text")
            continue
        hm = shift and _HEADING.match(line)
        if hm:
            line = "#" * min(6, len(hm.group(1)) + shift) + hm.group(2)
            out.append(_EMOJI.sub("", line))
            continue
        if _DROP_LINE.match(line):
            continue
        adm = _ADMONITION.match(line)
        if adm:
            kind = (adm.group(1) or "").upper()
            label = adm.group(2).strip(" []")
            out.append(f"**{kind}{(' — ' + label) if label else ''}**" if kind else "")
            continue
        line = _IMG.sub(lambda m: _image(m.group(1), m.group(2), path), line)
        out.append(_EMOJI.sub("", line))
    sys.stdout.write("\n".join(out).rstrip() + "\n")


# --- Call-graph mode ---------------------------------------------------------
# A real (but lexical, intra-crate) call-graph walk: index every fn under a
# seed's `roots`, then DFS from the seed function following calls we can resolve
# to another indexed fn. Honest limits — no semantic types, so trait/`dyn`
# dispatch is invisible and same-name methods are resolved by a `Type::`/`Self::`
# receiver hint, else same-file, else first definition. External/stdlib calls
# fall out of the index and bound the walk; depth and node caps bound it further.
# This is the opt-in counterpart to the curated docs/architecture.md spine.

CALLGRAPH_SEEDS = [
    {"label": "`android_main` — the one entry point",
     "file": "src/android/main.rs", "fn": "android_main",
     "roots": ["src/android", "src/core"], "max_depth": 4},
    {"label": "`command::build` — the cross-compiling (xbuild) path",
     "file": "patches/xbuild/xbuild/src/command/build.rs", "fn": "build",
     "roots": ["patches/xbuild/xbuild/src"], "max_depth": 2},
    {"label": "`apk::build` — the on-device build path",
     "file": "src/bin/build_apk.rs", "fn": "build",
     "roots": ["src/bin/build_apk.rs"], "max_depth": 4},
]
_MAX_NODES = 60                      # per-seed safety cap; truncation is logged
_KEYWORDS = {"if", "while", "for", "match", "return", "fn", "let", "loop",
             "as", "move", "where", "in", "impl", "self"}
_CALL = re.compile(r"(?:(\w+)\s*::\s*)?([A-Za-z_]\w*)\s*(?:::\s*<[^>]*>)?\s*\(")
_IMPL_HDR = re.compile(r"\b(?:impl|trait)\b[^\n{;]*")
_FN_DECL = re.compile(r"\bfn\s+([A-Za-z_]\w*)")


def _blank_noncode(text):
    """Return `text` with strings/chars/comments replaced by spaces (newlines
    kept), so call-site scanning never matches inside a literal or comment."""
    out, i, n = list(text), 0, len(text)

    def blank(a, b):
        for k in range(a, b):
            if out[k] != "\n":
                out[k] = " "

    while i < n:
        c = text[i]
        if c == "/" and i + 1 < n and text[i + 1] == "/":
            m = _LINE_COMMENT.match(text, i); blank(i, m.end()); i = m.end(); continue
        if c == "/" and i + 1 < n and text[i + 1] == "*":
            m = _BLOCK_COMMENT.match(text, i); e = m.end() if m else n
            blank(i, e); i = e; continue
        if c in "rb":
            m = _RAW_STR.match(text, i)
            if m:
                close = '"' + "#" * len(m.group(1))
                j = text.find(close, m.end())
                e = (j + len(close)) if j >= 0 else n
                blank(i, e); i = e; continue
        if c == '"' or (c == "b" and i + 1 < n and text[i + 1] == '"'):
            m = _STR.match(text, i)
            if m:
                blank(i, m.end()); i = m.end(); continue
        if c == "'":
            m = _CHAR.match(text, i)
            if m:
                blank(i, m.end()); i = m.end(); continue
            i += 1; continue
        i += 1
    return "".join(out)


def _owner_from_header(header):
    """`impl<T> Foo for Bar<T>` -> Bar; `impl Baz` -> Baz; `trait Qux` -> Qux."""
    h = re.sub(r"^\s*(?:impl|trait)\b", "", header)
    h = re.sub(r"<[^<>]*>", "", h)            # strip one level of generics
    if " for " in h:
        h = h.split(" for ", 1)[1]
    m = re.search(r"([A-Za-z_]\w*)", h)
    return m.group(1) if m else None


def _rs_files(roots):
    for root in roots:
        abs_root = root if os.path.isabs(root) else os.path.join(ROOT, root)
        if os.path.isfile(abs_root):
            yield root, abs_root
        else:
            for dirpath, _, names in os.walk(abs_root):
                for name in sorted(names):
                    if name.endswith(".rs"):
                        rel = os.path.relpath(os.path.join(dirpath, name), ROOT)
                        yield rel, os.path.join(dirpath, name)


def _build_index(roots):
    """name -> [ {file, owner, text, body} ] for every fn-with-body under roots."""
    index = {}
    for relpath, abspath in _rs_files(roots):
        with open(abspath, encoding="utf-8") as fh:
            src = fh.read()
        blanked = _blank_noncode(src)

        owners = []                            # (start, end, type) of impl/trait blocks
        for m in _IMPL_HDR.finditer(blanked):
            if blanked.find("{", m.end()) < 0:
                continue
            try:
                end = _match_body(src, m.start())
            except SystemExit:
                continue
            owners.append((m.start(), end, _owner_from_header(src[m.start():m.end()])))

        for m in _FN_DECL.finditer(blanked):
            brace = blanked.find("{", m.end())
            semi = blanked.find(";", m.end())
            if brace < 0 or (semi >= 0 and semi < brace):
                continue                        # trait method declaration, no body
            try:
                end = _match_body(src, m.start())
            except SystemExit:
                continue
            start = _expand_back_over_attrs(src, m.start())
            owner = None
            for o_start, o_end, o_type in owners:
                if o_start <= m.start() < o_end:
                    owner = o_type              # innermost wins (owners are source-ordered)
            text = src[start:end]
            index.setdefault(m.group(1), []).append(
                {"file": relpath, "owner": owner, "text": text,
                 "body": src[brace:end], "name": m.group(1)})
    return index


def _calls(body):
    """Ordered, de-duplicated (name, receiver-type) call sites in a fn body."""
    blanked = _blank_noncode(body)
    seen, result = set(), []
    for m in _CALL.finditer(blanked):
        name = m.group(2)
        if name in _KEYWORDS or (name, m.group(1)) in seen:
            continue
        seen.add((name, m.group(1)))
        result.append((name, m.group(1)))
    return result


def _resolve(name, recv, caller, index):
    cands = index.get(name)
    if not cands:
        return None                            # external / stdlib / out of roots
    if recv == "Self":
        recv = caller["owner"]
    if recv:
        for c in cands:
            if c["owner"] == recv:
                return c
    for c in cands:                            # prefer a same-file definition
        if c["file"] == caller["file"]:
            return c
    return cands[0]


def _display(defn):
    return f"{defn['owner']}::{defn['name']}" if defn["owner"] else defn["name"]


def cmd_callgraph(_arg=None):
    for seed in CALLGRAPH_SEEDS:
        index = _build_index(seed["roots"])
        root = next((d for d in index.get(seed["fn"], [])
                     if d["file"] == seed["file"]), None)
        if root is None:
            raise SystemExit(f"docs.py: seed `{seed['fn']}` not found in {seed['file']}")

        order, visited, truncated = [], set(), False

        def dfs(defn, depth, caller):
            nonlocal truncated
            key = (defn["file"], defn["name"], defn["owner"])
            if key in visited:
                return
            if len(order) >= _MAX_NODES:
                truncated = True
                return
            visited.add(key)
            order.append((defn, depth, caller))
            if depth >= seed["max_depth"]:
                return
            for name, recv in _calls(defn["body"]):
                callee = _resolve(name, recv, defn, index)
                if callee:
                    dfs(callee, depth + 1, defn)

        dfs(root, 0, None)

        print(f"\n# {seed['label']}\n")
        print(f"*Auto-generated by walking the call graph from "
              f"`{_display(root)}` to depth {seed['max_depth']} over "
              f"`{'`, `'.join(seed['roots'])}`. Lexical and intra-crate: "
              f"trait/`dyn` dispatch is invisible, same-name methods are "
              f"resolved heuristically, and external calls are omitted. "
              f"{len(order)} functions reached"
              f"{', node cap hit — truncated' if truncated else ''}.*\n")
        for defn, depth, caller in order:
            if caller is None:
                crumb = "*entry point*"
            else:
                crumb = f"*depth {depth}, called by `{_display(caller)}`*"
            # unlisted+unnumbered: dozens of fns would otherwise flood the TOC.
            print(f"## `{_display(defn)}` {{.unnumbered .unlisted}}\n\n{crumb}\n\n"
                  f"`{defn['file']}`\n")
            print(f"~~~~~ {{.rust}}\n{defn['text'].rstrip()}\n~~~~~\n")


def cmd_logo(src, dst, hexcolor):
    """Recolour a monochrome (light-on-dark) logo to `hexcolor` on a transparent
    background, so the same mark sits cleanly on a light or a dark cover. Alpha is
    taken from the source luminance: bright foreground → opaque, dark bg → clear."""
    from PIL import Image
    h = hexcolor.lstrip("#")
    rgb = (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
    im = Image.open(src).convert("RGBA")
    src_px, w, ht = im.load(), *im.size
    out = Image.new("RGBA", im.size, (0, 0, 0, 0))
    out_px = out.load()
    for y in range(ht):
        for x in range(w):
            r, g, b, a = src_px[x, y]
            lum = (r * 299 + g * 587 + b * 114) // 1000
            alpha = lum * a // 255
            if alpha:
                out_px[x, y] = (*rgb, alpha)
    out.save(dst)


def main():
    cmds = {"expand": cmd_expand, "clean": cmd_clean,
            "callgraph": cmd_callgraph, "logo": cmd_logo}
    if len(sys.argv) < 2 or sys.argv[1] not in cmds:
        raise SystemExit(__doc__)
    cmds[sys.argv[1]](*sys.argv[2:])


if __name__ == "__main__":
    main()

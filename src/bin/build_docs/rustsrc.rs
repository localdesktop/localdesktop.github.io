//! Rust-source-aware helpers for build_docs: expand the architecture spine's
//! `<!--snippet-->` directives, and walk a lexical, intra-crate call graph.
//! Brace matching skips comments / char literals / lifetimes / (raw/byte)
//! strings, so embedded shell here-docs with unbalanced `{{ }}` don't fool it.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

use super::{esc_markup, esc_string, repo_root};

// --- brace matcher -----------------------------------------------------------

/// Index (exclusive) just past the `}` closing the first `{` at/after `start`.
fn match_body(src: &[u8], start: usize) -> Option<usize> {
    let n = src.len();
    let mut i = start;
    let mut depth = 0i32;
    let mut opened = false;
    while i < n {
        let c = src[i];
        if c == b'/' && i + 1 < n && src[i + 1] == b'/' {
            while i < n && src[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if c == b'/' && i + 1 < n && src[i + 1] == b'*' {
            i += 2;
            while i + 1 < n && !(src[i] == b'*' && src[i + 1] == b'/') {
                i += 1;
            }
            i += 2;
            continue;
        }
        // raw / byte-raw string: (b?)r#*"
        if c == b'r' || (c == b'b' && i + 1 < n && src[i + 1] == b'r') {
            let mut k = if c == b'b' { i + 1 } else { i };
            k += 1; // past 'r'
            let mut hashes = 0;
            while k < n && src[k] == b'#' {
                hashes += 1;
                k += 1;
            }
            if k < n && src[k] == b'"' {
                k += 1;
                loop {
                    if k >= n {
                        break;
                    }
                    if src[k] == b'"' && src[k + 1..].iter().take(hashes).all(|&x| x == b'#') {
                        k += 1 + hashes;
                        break;
                    }
                    k += 1;
                }
                i = k;
                continue;
            }
        }
        // normal / byte string
        if c == b'"' || (c == b'b' && i + 1 < n && src[i + 1] == b'"') {
            let mut k = if c == b'b' { i + 2 } else { i + 1 };
            while k < n {
                match src[k] {
                    b'\\' => k += 2,
                    b'"' => {
                        k += 1;
                        break;
                    }
                    _ => k += 1,
                }
            }
            i = k;
            continue;
        }
        // char literal vs lifetime
        if c == b'\'' {
            // 'x' or '\n' etc → char; otherwise a lifetime, skip just the tick.
            if i + 2 < n && src[i + 1] == b'\\' {
                // '\?'
                let mut k = i + 2;
                while k < n && src[k] != b'\'' {
                    k += 1;
                }
                i = k + 1;
                continue;
            }
            if i + 2 < n && src[i + 2] == b'\'' {
                i += 3;
                continue;
            }
            i += 1;
            continue;
        }
        if c == b'{' {
            depth += 1;
            opened = true;
        } else if c == b'}' {
            depth -= 1;
            if opened && depth == 0 {
                return Some(i + 1);
            }
        }
        i += 1;
    }
    None
}

fn is_word(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// Find the byte offset of the nth `<keyword> <name>` declaration (word-bounded).
fn decl_pos(src: &str, keyword: &str, name: &str, nth: usize) -> Option<usize> {
    let needle = format!("{keyword} {name}");
    let b = src.as_bytes();
    let mut count = 0;
    let mut from = 0;
    while let Some(rel) = src[from..].find(&needle) {
        let pos = from + rel;
        let before = if pos == 0 { b' ' } else { b[pos - 1] };
        let after_idx = pos + needle.len();
        let after = if after_idx < b.len() { b[after_idx] } else { b' ' };
        if !is_word(before) && !is_word(after) {
            count += 1;
            if count == nth {
                return Some(pos);
            }
        }
        from = pos + needle.len();
    }
    None
}

/// Walk back over contiguous attribute / doc-comment lines above `decl`.
fn expand_back(src: &str, decl: usize) -> usize {
    let b = src.as_bytes();
    let mut start = src[..decl].rfind('\n').map(|i| i + 1).unwrap_or(0);
    while start > 0 {
        let prev_nl = start - 1;
        let line_start = src[..prev_nl].rfind('\n').map(|i| i + 1).unwrap_or(0);
        let line = src[line_start..prev_nl].trim();
        let keep = line.starts_with("#[")
            || line.starts_with("#![")
            || line.starts_with("///")
            || line.starts_with("//!");
        let _ = b;
        if keep {
            start = line_start;
        } else {
            break;
        }
    }
    start
}

const KINDS: &[(&str, &str)] = &[
    ("fn", "fn"),
    ("struct", "struct"),
    ("enum", "enum"),
    ("impl", "impl"),
    ("trait", "trait"),
    ("type", "type"),
    ("const", "const"),
    ("static", "static"),
];

fn lang_for(path: &str) -> &'static str {
    match Path::new(path).extension().and_then(|e| e.to_str()) {
        Some("rs") => "rust",
        Some("sh") => "bash",
        Some("toml") => "toml",
        Some("yaml") | Some("yml") => "yaml",
        Some("json") => "json",
        Some("xml") => "xml",
        Some("java") => "java",
        _ => "text",
    }
}

fn extract(attrs: &HashMap<String, String>) -> Result<(String, String)> {
    let path = attrs.get("file").context("snippet missing file=")?;
    let abs = repo_root().join(path);
    let src = fs::read_to_string(&abs).with_context(|| format!("read {}", abs.display()))?;
    let lang = attrs
        .get("lang")
        .cloned()
        .unwrap_or_else(|| lang_for(path).to_string());

    if let Some(range) = attrs.get("lines") {
        let mut it = range.split('-');
        let a: usize = it.next().unwrap().parse()?;
        let b: usize = it.next().unwrap().parse()?;
        let body = src.lines().skip(a - 1).take(b - a + 1).collect::<Vec<_>>().join("\n");
        return Ok((lang, body));
    }
    for (attr, kw) in KINDS {
        if let Some(name) = attrs.get(*attr) {
            let nth = attrs.get("nth").and_then(|s| s.parse().ok()).unwrap_or(1);
            let pos = decl_pos(&src, kw, name, nth)
                .with_context(|| format!("`{kw} {name}` #{nth} not found in {path}"))?;
            let end = match_body(src.as_bytes(), pos).context("unbalanced braces")?;
            let body = src[expand_back(&src, pos)..end].to_string();
            return Ok((lang, body));
        }
    }
    Ok((lang, src.trim_end().to_string()))
}

/// Expand the architecture spine into plain markdown (snippets → fenced blocks).
pub fn expand_spine(path: &Path) -> Result<String> {
    let text = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    let mut out = String::new();
    let mut in_comment = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if in_comment {
            if trimmed.contains("-->") {
                in_comment = false;
            }
            continue;
        }
        if let Some(attrs) = parse_directive(trimmed) {
            let (lang, body) = extract(&attrs)?;
            // 5-tilde fence won't collide with ``` inside source.
            out.push_str(&format!("\n~~~~~{}\n{}\n~~~~~\n", lang, body.trim_end()));
            continue;
        }
        if trimmed.starts_with("<!--") && !trimmed.contains("-->") {
            in_comment = true;
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    Ok(out)
}

fn parse_directive(line: &str) -> Option<HashMap<String, String>> {
    let inner = line.strip_prefix("<!--")?.strip_suffix("-->")?.trim();
    let mut it = inner.split_whitespace();
    if it.next()? != "snippet" {
        return None;
    }
    let mut map = HashMap::new();
    for tok in it {
        if let Some((k, v)) = tok.split_once('=') {
            map.insert(k.to_string(), v.to_string());
        }
    }
    Some(map)
}

// --- call graph --------------------------------------------------------------

struct Seed {
    label: &'static str,
    file: &'static str,
    func: &'static str,
    roots: &'static [&'static str],
    max_depth: usize,
}

const SEEDS: &[Seed] = &[
    Seed {
        label: "`android_main` — the one entry point",
        file: "src/android/main.rs",
        func: "android_main",
        roots: &["src/android", "src/core"],
        max_depth: 4,
    },
    Seed {
        label: "`command::build` — the cross-compiling (xbuild) path",
        file: "patches/xbuild/xbuild/src/command/build.rs",
        func: "build",
        roots: &["patches/xbuild/xbuild/src"],
        max_depth: 2,
    },
    Seed {
        label: "`apk::build` — the on-device build path",
        file: "src/bin/build_apk.rs",
        func: "build",
        roots: &["src/bin/build_apk.rs"],
        max_depth: 4,
    },
];

const MAX_NODES: usize = 60;

#[derive(Clone)]
struct Def {
    name: String,
    owner: Option<String>,
    file: String,
    text: String,
    body: String,
}

fn blank_noncode(src: &str) -> Vec<u8> {
    let b = src.as_bytes().to_vec();
    let mut out = b.clone();
    let n = b.len();
    let mut i = 0;
    let blank = |out: &mut Vec<u8>, a: usize, z: usize| {
        for k in a..z.min(n) {
            if out[k] != b'\n' {
                out[k] = b' ';
            }
        }
    };
    while i < n {
        let c = b[i];
        if c == b'/' && i + 1 < n && b[i + 1] == b'/' {
            let mut k = i;
            while k < n && b[k] != b'\n' {
                k += 1;
            }
            blank(&mut out, i, k);
            i = k;
            continue;
        }
        if c == b'/' && i + 1 < n && b[i + 1] == b'*' {
            let mut k = i + 2;
            while k + 1 < n && !(b[k] == b'*' && b[k + 1] == b'/') {
                k += 1;
            }
            k = (k + 2).min(n);
            blank(&mut out, i, k);
            i = k;
            continue;
        }
        if c == b'r' || (c == b'b' && i + 1 < n && b[i + 1] == b'r') {
            let mut k = if c == b'b' { i + 1 } else { i };
            k += 1;
            let mut hashes = 0;
            while k < n && b[k] == b'#' {
                hashes += 1;
                k += 1;
            }
            if k < n && b[k] == b'"' {
                k += 1;
                while k < n {
                    if b[k] == b'"' && b[k + 1..].iter().take(hashes).all(|&x| x == b'#') {
                        k += 1 + hashes;
                        break;
                    }
                    k += 1;
                }
                blank(&mut out, i, k);
                i = k;
                continue;
            }
        }
        if c == b'"' || (c == b'b' && i + 1 < n && b[i + 1] == b'"') {
            let mut k = if c == b'b' { i + 2 } else { i + 1 };
            while k < n {
                match b[k] {
                    b'\\' => k += 2,
                    b'"' => {
                        k += 1;
                        break;
                    }
                    _ => k += 1,
                }
            }
            blank(&mut out, i, k);
            i = k;
            continue;
        }
        if c == b'\'' {
            if i + 2 < n && b[i + 2] == b'\'' {
                blank(&mut out, i, i + 3);
                i += 3;
                continue;
            }
            i += 1;
            continue;
        }
        i += 1;
    }
    out
}

fn owner_from_header(header: &str) -> Option<String> {
    let mut h = header.trim_start();
    h = h.strip_prefix("impl").or_else(|| h.strip_prefix("trait")).unwrap_or(h);
    // strip one level of generics
    let re = regex::Regex::new(r"<[^<>]*>").unwrap();
    let h = re.replace_all(h, "");
    let part = if let Some(idx) = h.find(" for ") {
        &h[idx + 5..]
    } else {
        &h
    };
    regex::Regex::new(r"[A-Za-z_]\w*")
        .unwrap()
        .find(part)
        .map(|m| m.as_str().to_string())
}

fn rs_files(roots: &[&str]) -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    for root in roots {
        let abs = repo_root().join(root);
        if abs.is_file() {
            out.push((root.to_string(), abs));
        } else {
            collect_rs(&abs, &mut out);
        }
    }
    out
}

fn collect_rs(dir: &Path, out: &mut Vec<(String, PathBuf)>) {
    if let Ok(rd) = fs::read_dir(dir) {
        let mut entries: Vec<_> = rd.filter_map(|e| e.ok().map(|e| e.path())).collect();
        entries.sort();
        for p in entries {
            if p.is_dir() {
                collect_rs(&p, out);
            } else if p.extension().and_then(|e| e.to_str()) == Some("rs") {
                let rel = p.strip_prefix(repo_root()).unwrap_or(&p).to_string_lossy().to_string();
                out.push((rel, p));
            }
        }
    }
}

fn build_index(roots: &[&str]) -> HashMap<String, Vec<Def>> {
    let mut index: HashMap<String, Vec<Def>> = HashMap::new();
    let impl_re = regex::Regex::new(r"\b(?:impl|trait)\b[^\n{;]*").unwrap();
    let fn_re = regex::Regex::new(r"\bfn\s+([A-Za-z_]\w*)").unwrap();
    for (relpath, abspath) in rs_files(roots) {
        let Ok(src) = fs::read_to_string(&abspath) else {
            continue;
        };
        let blanked = blank_noncode(&src);
        let blanked_str = String::from_utf8_lossy(&blanked).to_string();

        // owner (impl/trait) ranges
        let mut owners: Vec<(usize, usize, Option<String>)> = Vec::new();
        for m in impl_re.find_iter(&blanked_str) {
            if blanked_str[m.end()..].find('{').is_none() {
                continue;
            }
            if let Some(end) = match_body(src.as_bytes(), m.start()) {
                owners.push((m.start(), end, owner_from_header(&src[m.start()..m.end()])));
            }
        }

        for m in fn_re.find_iter(&blanked_str) {
            let after = m.end();
            let brace = blanked_str[after..].find('{').map(|i| after + i);
            let semi = blanked_str[after..].find(';').map(|i| after + i);
            match (brace, semi) {
                (None, _) => continue,
                (Some(_), Some(s)) if Some(s) < brace => continue,
                _ => {}
            }
            let Some(brace) = brace else { continue };
            let Some(end) = match_body(src.as_bytes(), m.start()) else {
                continue;
            };
            let start = expand_back(&src, m.start());
            let mut owner = None;
            for (a, z, o) in &owners {
                if *a <= m.start() && m.start() < *z {
                    owner = o.clone();
                }
            }
            let name = m.as_str()["fn ".len()..].trim().to_string();
            index.entry(name.clone()).or_default().push(Def {
                name,
                owner,
                file: relpath.clone(),
                text: src[start..end].to_string(),
                body: src[brace..end].to_string(),
            });
        }
    }
    index
}

fn calls(body: &str) -> Vec<(String, Option<String>)> {
    let blanked = String::from_utf8_lossy(&blank_noncode(body)).to_string();
    let re = regex::Regex::new(r"(?:(\w+)\s*::\s*)?([A-Za-z_]\w*)\s*(?:::\s*<[^>]*>)?\s*\(").unwrap();
    let keywords = ["if", "while", "for", "match", "return", "fn", "let", "loop", "as", "move", "where", "in", "impl", "self"];
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for c in re.captures_iter(&blanked) {
        let name = c.get(2).unwrap().as_str().to_string();
        let recv = c.get(1).map(|m| m.as_str().to_string());
        if keywords.contains(&name.as_str()) {
            continue;
        }
        let key = (name.clone(), recv.clone());
        if seen.insert(key) {
            out.push((name, recv));
        }
    }
    out
}

fn resolve<'a>(
    name: &str,
    recv: &Option<String>,
    caller: &Def,
    index: &'a HashMap<String, Vec<Def>>,
) -> Option<&'a Def> {
    let cands = index.get(name)?;
    let recv = recv.as_deref().map(|r| {
        if r == "Self" {
            caller.owner.as_deref().unwrap_or(r)
        } else {
            r
        }
    });
    if let Some(r) = recv {
        if let Some(d) = cands.iter().find(|d| d.owner.as_deref() == Some(r)) {
            return Some(d);
        }
    }
    if let Some(d) = cands.iter().find(|d| d.file == caller.file) {
        return Some(d);
    }
    cands.first()
}

fn display(d: &Def) -> String {
    match &d.owner {
        Some(o) => format!("{o}::{}", d.name),
        None => d.name.clone(),
    }
}

/// Emit the entire call-graph section as Typst markup.
pub fn callgraph_typst() -> String {
    let mut out = String::new();
    for seed in SEEDS {
        let index = build_index(seed.roots);
        let Some(root) = index.get(seed.func).and_then(|v| v.iter().find(|d| d.file == seed.file)) else {
            continue;
        };
        let root = root.clone();

        // DFS
        let mut order: Vec<(Def, usize, Option<String>)> = Vec::new();
        let mut visited = std::collections::HashSet::new();
        let mut truncated = false;
        dfs(&root, 0, None, seed.max_depth, &index, &mut order, &mut visited, &mut truncated);

        out.push_str(&format!("#pagebreak(weak: true)\n= {}\n\n", esc_markup(seed.label)));
        out.push_str(&format!(
            "#emph[Auto-generated by walking the call graph from #raw(\"{}\") to depth {} over {}. Lexical and intra-crate: trait/dyn dispatch is invisible, same-name methods are resolved heuristically, external calls omitted. {} functions reached{}.]\n\n",
            esc_string(&display(&root)),
            seed.max_depth,
            esc_markup(&seed.roots.join(", ")),
            order.len(),
            if truncated { ", node cap hit — truncated" } else { "" }
        ));
        for (def, depth, caller) in &order {
            let crumb = match caller {
                None => "entry point".to_string(),
                Some(c) => format!("depth {depth}, called by {c}"),
            };
            out.push_str(&format!(
                "#heading(level: 2, outlined: false, numbering: none)[#raw(\"{}\")]\n\n",
                esc_string(&display(def))
            ));
            out.push_str(&format!("#emph[{}] · #raw(\"{}\")\n\n", esc_markup(&crumb), esc_string(&def.file)));
            out.push_str(&format!("#raw(\"{}\", block: true, lang: \"rust\")\n\n", esc_string(def.text.trim_end())));
        }
    }
    out
}

#[allow(clippy::too_many_arguments)]
fn dfs(
    def: &Def,
    depth: usize,
    caller: Option<String>,
    max_depth: usize,
    index: &HashMap<String, Vec<Def>>,
    order: &mut Vec<(Def, usize, Option<String>)>,
    visited: &mut std::collections::HashSet<(String, Option<String>, String)>,
    truncated: &mut bool,
) {
    let key = (def.name.clone(), def.owner.clone(), def.file.clone());
    if visited.contains(&key) {
        return;
    }
    if order.len() >= MAX_NODES {
        *truncated = true;
        return;
    }
    visited.insert(key);
    order.push((def.clone(), depth, caller));
    if depth >= max_depth {
        return;
    }
    for (name, recv) in calls(&def.body) {
        if let Some(callee) = resolve(&name, &recv, def, index) {
            let callee = callee.clone();
            dfs(&callee, depth + 1, Some(display(def)), max_depth, index, order, visited, truncated);
        }
    }
}

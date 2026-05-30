//! build_docs — render Local Desktop's offline PDF manuals, fully in Rust.
//!
//! No pandoc, no LaTeX, no Python: markdown is converted to Typst markup and
//! rendered to PDF via the embedded Typst compiler (`typst-as-lib`). Images
//! (incl. webp) are converted with the `image` crate; fonts are fetched with
//! `reqwest`. This is a host-only tool (cfg'd out of the Android build).
//!
//! Usage mirrors the old script:
//!   cargo run --bin build_docs -- [developer|user] [curated|callgraph]
//!                                 [light|dark] [compact] | all
//!
//!   developer (default)  README + full gh-pages docs/blog + an architecture
//!                        walkthrough of the code (book-like serif).
//!   user                 the gh-pages user guide + blog, website-styled
//!                        (sans, teal accents), light or dark.
//! Knobs: callgraph (developer only), compact (either), dark (user only).
//! Outputs land in manuals/ (gitignored).

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use typst_as_lib::TypstEngine;

// ----------------------------------------------------------------------------
// Options
// ----------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq)]
enum Manual {
    Developer,
    User,
}

/// Page size. Desktop = full A4; Fold = near-square foldable inner screen;
/// Phone = narrow/tall, optimized for a normal mobile phone.
#[derive(Clone, Copy, PartialEq)]
enum Size {
    Desktop,
    Fold,
    Phone,
}

impl Size {
    fn label(self) -> Option<&'static str> {
        match self {
            Size::Desktop => None,
            Size::Fold => Some("Fold"),
            Size::Phone => Some("Phone"),
        }
    }
}

#[derive(Clone, Copy, PartialEq)]
struct Opts {
    manual: Manual,
    callgraph: bool,
    size: Size,
    dark: bool,
}

struct Theme {
    accent: &'static str,
    ink: &'static str,
    code_bg: &'static str,
    page_bg: Option<&'static str>,
    /// Body font family name (must match a font we embed).
    font: &'static str,
}

impl Opts {
    fn theme(&self) -> Theme {
        if self.manual == Manual::User {
            if self.dark {
                Theme {
                    accent: "2DD4BF",
                    ink: "E8EDF5",
                    code_bg: "0E2622",
                    page_bg: Some("071018"),
                    font: "Lato",
                }
            } else {
                Theme {
                    accent: "0D9488",
                    ink: "0F172A",
                    code_bg: "E6F4F2",
                    page_bg: None,
                    font: "Lato",
                }
            }
        } else {
            // Developer manual: book-like serif, navy links, no theming knobs.
            Theme {
                accent: "1F3A93",
                ink: "111111",
                code_bg: "F4F4F4",
                page_bg: None,
                font: "Cardo",
            }
        }
    }

    fn out_path(&self) -> PathBuf {
        let mut name = String::from(if self.manual == Manual::User {
            "Local Desktop - User Manual"
        } else {
            "Local Desktop - Developer Manual"
        });
        let mut quals: Vec<&str> = Vec::new();
        if self.manual == Manual::Developer && self.callgraph {
            quals.push("Call Graph");
        }
        if let Some(l) = self.size.label() {
            quals.push(l);
        }
        if self.manual == Manual::User && self.dark {
            quals.push("Dark");
        }
        if !quals.is_empty() {
            name.push_str(&format!(" ({})", quals.join(", ")));
        }
        name.push_str(".pdf");
        PathBuf::from("manuals").join(name)
    }
}

// ----------------------------------------------------------------------------
// Typst escaping
// ----------------------------------------------------------------------------

/// Escape a run of text for Typst *markup* context.
fn esc_markup(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\\' | '*' | '_' | '`' | '$' | '#' | '<' | '>' | '@' | '~' | '[' | ']' => {
                o.push('\\');
                o.push(c);
            }
            _ => o.push(c),
        }
    }
    o
}

/// Escape a string for a Typst *string literal* ("...").
fn esc_string(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    for c in s.chars() {
        match c {
            '\\' => o.push_str("\\\\"),
            '"' => o.push_str("\\\""),
            '\n' => o.push_str("\\n"),
            '\t' => o.push_str("\\t"),
            '\r' => {}
            _ => o.push(c),
        }
    }
    o
}

// ----------------------------------------------------------------------------
// Markdown → Typst
// ----------------------------------------------------------------------------

struct MdToTypst<'a> {
    out: String,
    hshift: usize,
    base_dir: PathBuf,
    images: &'a mut ImageCache,
    // code block capture
    code: Option<(String, String)>, // (lang, buf)
    // image capture
    image: Option<(String, String)>, // (dest, alt)
    // ordered/unordered list markers, with item counters for ordered
    list_stack: Vec<Option<u64>>,
}

fn heading_level(l: HeadingLevel) -> usize {
    match l {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}

impl<'a> MdToTypst<'a> {
    fn new(base_dir: PathBuf, hshift: usize, images: &'a mut ImageCache) -> Self {
        MdToTypst {
            out: String::new(),
            hshift,
            base_dir,
            images,
            code: None,
            image: None,
            list_stack: Vec::new(),
        }
    }

    fn push(&mut self, s: &str) {
        self.out.push_str(s);
    }

    fn convert(mut self, md: &str) -> String {
        let mut opts = Options::empty();
        opts.insert(Options::ENABLE_STRIKETHROUGH);
        opts.insert(Options::ENABLE_TABLES);
        let parser = Parser::new_ext(md, opts);
        for ev in parser {
            self.event(ev);
        }
        self.out
    }

    fn event(&mut self, ev: Event) {
        match ev {
            Event::Start(tag) => self.start(tag),
            Event::End(tag) => self.end(tag),
            Event::Text(t) => {
                if let Some((_, buf)) = self.code.as_mut() {
                    buf.push_str(&t);
                } else if let Some((_, alt)) = self.image.as_mut() {
                    alt.push_str(&t);
                } else {
                    let e = esc_markup(&t);
                    self.push(&e);
                }
            }
            Event::Code(t) => {
                let r = format!("#raw(\"{}\")", esc_string(&t));
                self.push(&r);
            }
            Event::SoftBreak => self.push(" "),
            Event::HardBreak => self.push(" \\ "),
            Event::Rule => self.push("\n#line(length: 100%, stroke: 0.5pt + gray)\n\n"),
            Event::Html(_) | Event::InlineHtml(_) => {} // drop raw HTML
            _ => {}
        }
    }

    fn start(&mut self, tag: Tag) {
        match tag {
            Tag::Heading { level, .. } => {
                let lvl = (heading_level(level) + self.hshift).min(6);
                self.push(&format!("\n{} ", "=".repeat(lvl)));
            }
            Tag::Paragraph => {}
            Tag::Strong => self.push("#strong["),
            Tag::Emphasis => self.push("#emph["),
            Tag::Strikethrough => self.push("#strike["),
            Tag::Link { dest_url, .. } => {
                self.push(&format!("#link(\"{}\")[", esc_string(&dest_url)));
            }
            Tag::Image { dest_url, .. } => {
                self.image = Some((dest_url.to_string(), String::new()));
            }
            Tag::CodeBlock(kind) => {
                let lang = match kind {
                    CodeBlockKind::Fenced(l) => l.to_string(),
                    CodeBlockKind::Indented => String::new(),
                };
                self.code = Some((lang, String::new()));
            }
            Tag::List(start) => self.list_stack.push(start),
            Tag::Item => {
                let depth = self.list_stack.len().saturating_sub(1);
                self.push(&"  ".repeat(depth));
                match self.list_stack.last().copied().flatten() {
                    Some(_) => self.push("+ "),
                    None => self.push("- "),
                }
            }
            Tag::BlockQuote(_) => self.push("#quote(block: true)["),
            _ => {}
        }
    }

    fn end(&mut self, tag: TagEnd) {
        match tag {
            TagEnd::Heading(_) => self.push("\n\n"),
            TagEnd::Paragraph => self.push("\n\n"),
            TagEnd::Strong | TagEnd::Emphasis | TagEnd::Strikethrough | TagEnd::Link => {
                self.push("]")
            }
            TagEnd::Image => {
                if let Some((dest, alt)) = self.image.take() {
                    if let Some(rel) = self.images.embed(&self.base_dir, &dest) {
                        let cap = esc_markup(alt.trim());
                        self.push(&format!(
                            "\n#figure(image(\"/{}\", width: 80%), caption: [{}])\n\n",
                            esc_string(&rel),
                            cap
                        ));
                    } else {
                        self.push(&format!("#emph[(figure: {})]", esc_markup(alt.trim())));
                    }
                }
            }
            TagEnd::CodeBlock => {
                if let Some((lang, buf)) = self.code.take() {
                    let lang_attr = if lang.is_empty() {
                        String::new()
                    } else {
                        format!(", lang: \"{}\"", esc_string(&lang))
                    };
                    self.push(&format!(
                        "\n#raw(\"{}\", block: true{})\n\n",
                        esc_string(buf.trim_end_matches('\n')),
                        lang_attr
                    ));
                }
            }
            TagEnd::List(_) => {
                self.list_stack.pop();
                if self.list_stack.is_empty() {
                    self.push("\n");
                }
            }
            TagEnd::Item => self.push("\n"),
            TagEnd::BlockQuote(_) => self.push("]\n\n"),
            _ => {}
        }
    }
}

// ----------------------------------------------------------------------------
// Image cache (resolve gh-pages /img paths, convert webp → png, size-cap)
// ----------------------------------------------------------------------------

struct ImageCache {
    static_root: PathBuf,
    out_dir: PathBuf,
    done: HashMap<String, Option<String>>,
}

impl ImageCache {
    fn new() -> Self {
        let root = repo_root();
        ImageCache {
            static_root: root.join("gh-pages/static"),
            out_dir: root.join("build/docs/img"),
            done: HashMap::new(),
        }
    }

    /// Resolve `url` (relative to `base_dir`, or `/img/...` against static root),
    /// convert to a capped PNG under out_dir, and return a path relative to the
    /// repo root for `#image(...)`. None if unresolvable/remote.
    fn embed(&mut self, base_dir: &Path, url: &str) -> Option<String> {
        if url.starts_with("http://") || url.starts_with("https://") || url.starts_with("data:") {
            return None;
        }
        let key = format!("{}|{}", base_dir.display(), url);
        if let Some(v) = self.done.get(&key) {
            return v.clone();
        }
        let rel = url.split(['#', '?']).next().unwrap_or(url);
        let src = if let Some(stripped) = rel.strip_prefix('/') {
            self.static_root.join(stripped)
        } else {
            base_dir.join(rel)
        };
        let result = self.prepare(&src);
        self.done.insert(key, result.clone());
        result
    }

    fn prepare(&self, src: &Path) -> Option<String> {
        if !src.is_file() {
            return None;
        }
        fs::create_dir_all(&self.out_dir).ok()?;
        let stem = src.file_stem()?.to_string_lossy();
        let dst = self.out_dir.join(format!("{stem}.png"));
        if !dst.is_file() {
            let img = image::open(src).ok()?;
            // Cap the long edge so the PDF stays light.
            let img = img.resize(1400, 1400, image::imageops::FilterType::Lanczos3);
            img.save_with_format(&dst, image::ImageFormat::Png).ok()?;
        }
        let root = repo_root();
        let rel = dst.strip_prefix(&root).unwrap_or(&dst);
        Some(rel.to_string_lossy().replace('\\', "/"))
    }
}

// ----------------------------------------------------------------------------
// Source cleaning (frontmatter, hide-in-pdf, MDX comments, admonitions, emoji)
// ----------------------------------------------------------------------------

fn strip_emoji(s: &str) -> String {
    s.chars()
        .filter(|&c| {
            let u = c as u32;
            !((0x1F000..=0x1FAFF).contains(&u)
                || (0x2600..=0x27BF).contains(&u)
                || (0x2300..=0x23FF).contains(&u)
                || (0x2B00..=0x2BFF).contains(&u)
                || (0x1F1E6..=0x1F1FF).contains(&u)
                || u == 0xFE0F
                || u == 0x200D)
        })
        .collect()
}

/// Returns cleaned markdown ready for `MdToTypst`. `hshift` is applied by the
/// converter, not here. Synthesises an H1 from frontmatter title when needed.
fn clean_markdown(path: &Path) -> Result<String> {
    let raw = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;

    // Frontmatter → title.
    let (title, mut body) = split_frontmatter(&raw);

    // Drop installer-only regions and any MDX comments.
    let hide = regex::Regex::new(r"(?s)\{/\*\s*hide-in-pdf\b.*?\*/\}.*?\{/\*\s*/hide-in-pdf\s*\*/\}")
        .unwrap();
    body = hide.replace_all(&body, "").into_owned();
    let mdx = regex::Regex::new(r"(?s)\{/\*.*?\*/\}").unwrap();
    body = mdx.replace_all(&body, "").into_owned();

    let mut out = String::new();
    let need_title = title.is_some() || !body.trim_start().starts_with('#');
    if let Some(t) = &title {
        out.push_str(&format!("# {}\n\n", strip_emoji(t).trim()));
    } else if need_title && !body.trim_start().starts_with('#') {
        let stem = path.file_stem().unwrap().to_string_lossy();
        let stem = regex::Regex::new(r"^\d+[-_]?").unwrap().replace(&stem, "");
        let t = stem.replace(['-', '_'], " ");
        out.push_str(&format!("# {}\n\n", title_case(&t)));
    }

    // Line pass: admonitions, MDX line drops, fence passthrough, emoji.
    let mut in_fence: Option<String> = None;
    for line in body.lines() {
        let trimmed = line.trim_start();
        if let Some(fence) = &in_fence {
            out.push_str(line);
            out.push('\n');
            if trimmed.starts_with(fence.as_str()) && trimmed.trim_end() == fence.as_str() {
                in_fence = None;
            }
            continue;
        }
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            let marker: String = trimmed.chars().take_while(|&c| c == '`' || c == '~').collect();
            let info = trimmed[marker.len()..].trim();
            // Tag bare fences so the converter still styles them.
            if info.is_empty() {
                out.push_str(&format!("{}text\n", &line[..line.len() - trimmed.len() + marker.len()]));
            } else {
                out.push_str(line);
                out.push('\n');
            }
            in_fence = Some(marker);
            continue;
        }
        if trimmed.starts_with("import ")
            || trimmed.starts_with("export ")
            || trimmed.starts_with("<Tabs")
            || trimmed.starts_with("</Tabs")
            || trimmed.starts_with("<TabItem")
            || trimmed.starts_with("</TabItem")
        {
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix(":::") {
            let mut parts = rest.splitn(2, char::is_whitespace);
            let kind = parts.next().unwrap_or("").trim();
            let label = parts.next().unwrap_or("").trim().trim_matches(['[', ']']);
            if kind.is_empty() {
                out.push('\n');
            } else if label.is_empty() {
                out.push_str(&format!("**{}**\n\n", kind.to_uppercase()));
            } else {
                out.push_str(&format!("**{} — {}**\n\n", kind.to_uppercase(), label));
            }
            continue;
        }
        out.push_str(&strip_emoji(line));
        out.push('\n');
    }
    Ok(out)
}

fn split_frontmatter(text: &str) -> (Option<String>, String) {
    if let Some(rest) = text.strip_prefix("---") {
        if let Some(end) = rest.find("\n---") {
            let fm = &rest[..end];
            let body = rest[end + 4..].trim_start_matches('\n').to_string();
            let title = fm.lines().find_map(|l| {
                l.strip_prefix("title:")
                    .map(|t| t.trim().trim_matches(['"', '\'']).to_string())
            });
            return (title, body);
        }
    }
    (None, text.to_string())
}

fn title_case(s: &str) -> String {
    s.split_whitespace()
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

// ----------------------------------------------------------------------------
// Repo paths / fonts / logo
// ----------------------------------------------------------------------------

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// Fetch (and cache under build/docs/fonts) the Regular/Bold/Italic TTFs for a
/// Google Fonts OFL family, returning their bytes for the Typst engine.
fn fonts(family: &str, subdir: &str) -> Result<Vec<Vec<u8>>> {
    let dir = repo_root().join("build/docs/fonts");
    fs::create_dir_all(&dir)?;
    let base = format!("https://raw.githubusercontent.com/google/fonts/main/ofl/{subdir}");
    let mut out = Vec::new();
    for style in ["Regular", "Bold", "Italic"] {
        let path = dir.join(format!("{family}-{style}.ttf"));
        if !path.is_file() {
            let url = format!("{base}/{family}-{style}.ttf");
            let bytes = reqwest::blocking::get(&url)
                .with_context(|| format!("fetch {url}"))?
                .error_for_status()?
                .bytes()?;
            fs::write(&path, &bytes)?;
        }
        out.push(fs::read(&path)?);
    }
    Ok(out)
}

/// Recolour the monochrome brand logo to `hex` on transparent, return repo-relative path.
fn cover_logo(hex: &str) -> Result<String> {
    let src = repo_root().join("gh-pages/static/img/logo.png");
    let dir = repo_root().join("build/docs");
    fs::create_dir_all(&dir)?;
    let dst = dir.join(format!("cover-logo-{hex}.png"));
    if !dst.is_file() {
        let (r, g, b) = (
            u8::from_str_radix(&hex[0..2], 16)?,
            u8::from_str_radix(&hex[2..4], 16)?,
            u8::from_str_radix(&hex[4..6], 16)?,
        );
        let img = image::open(&src)?.to_rgba8();
        let mut out = image::RgbaImage::new(img.width(), img.height());
        for (x, y, px) in img.enumerate_pixels() {
            let [pr, pg, pb, pa] = px.0;
            let lum = (pr as u32 * 299 + pg as u32 * 587 + pb as u32 * 114) / 1000;
            let alpha = (lum * pa as u32 / 255) as u8;
            out.put_pixel(x, y, image::Rgba([r, g, b, alpha]));
        }
        out.save(&dst)?;
    }
    Ok(dst
        .strip_prefix(repo_root())
        .unwrap_or(&dst)
        .to_string_lossy()
        .replace('\\', "/"))
}

// ----------------------------------------------------------------------------
// Snippet expansion (architecture spine) and call-graph — Rust source aware
// ----------------------------------------------------------------------------

mod rustsrc;

// ----------------------------------------------------------------------------
// Document assembly
// ----------------------------------------------------------------------------

fn glob_sorted(dir: &str, ext: &str) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = fs::read_dir(repo_root().join(dir))
        .map(|rd| {
            rd.filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| p.extension().map(|x| x == ext).unwrap_or(false))
                .collect()
        })
        .unwrap_or_default();
    v.sort();
    v
}

fn preamble(opts: &Opts) -> String {
    let t = opts.theme();
    let mut s = String::new();
    // Page.
    match opts.size {
        // Near-square foldable inner screen (e.g. OnePlus Open).
        Size::Fold => s.push_str("#set page(width: 130mm, height: 150mm, margin: 6mm)\n"),
        // Narrow/tall, ~19.5:9 — a normal phone held portrait.
        Size::Phone => s.push_str("#set page(width: 90mm, height: 190mm, margin: 5mm)\n"),
        Size::Desktop => {
            let margin = if opts.manual == Manual::User { "2.4cm" } else { "2cm" };
            s.push_str(&format!("#set page(paper: \"a4\", margin: {margin})\n"));
        }
    }
    if let Some(bg) = t.page_bg {
        s.push_str(&format!("#set page(fill: rgb(\"#{bg}\"))\n"));
    }
    let size = if opts.size == Size::Desktop { "11pt" } else { "9pt" };
    s.push_str(&format!(
        "#set text(font: \"{}\", size: {size}, fill: rgb(\"#{}\"))\n",
        t.font, t.ink
    ));
    s.push_str("#set par(justify: true, leading: 0.65em)\n");
    s.push_str("#set heading(numbering: \"1.1\")\n");
    // Teal/navy headings, links.
    s.push_str(&format!(
        "#show heading: it => text(fill: rgb(\"#{}\"), it)\n",
        t.accent
    ));
    s.push_str(&format!(
        "#show link: it => text(fill: rgb(\"#{}\"), it)\n",
        t.accent
    ));
    // Code blocks: tinted, padded panel. Dark theme renders code light (no theme file).
    s.push_str(&format!(
        "#show raw.where(block: true): it => block(fill: rgb(\"#{}\"), inset: 8pt, radius: 3pt, width: 100%, text(size: 0.9em, it))\n",
        t.code_bg
    ));
    // A real monospace for code (else highlighting drops spaces in a proportional font).
    s.push_str("#show raw: set text(font: \"IBM Plex Mono\")\n");
    if opts.dark {
        s.push_str("#show raw: set text(fill: rgb(\"#E8EDF5\"))\n");
    }
    s
}

fn cover_and_toc(opts: &Opts, version: &str) -> Result<String> {
    let t = opts.theme();
    let mut s = String::new();
    if opts.manual == Manual::User {
        let logo = cover_logo(t.ink)?;
        s.push_str("#v(1.2cm)\n");
        s.push_str(&format!(
            "#align(center, image(\"/{}\", width: 40%))\n#v(0.6em)\n",
            esc_string(&logo)
        ));
    }
    let title = if opts.manual == Manual::User {
        "Local Desktop — User Manual"
    } else {
        "Local Desktop — Developer Manual"
    };
    let subtitle = if opts.manual == Manual::User {
        format!("Running Linux on Android · v{version}")
    } else {
        format!("v{version}")
    };
    // Smaller on the narrow fold/phone pages so the title stays on one line.
    let title_size = if opts.size == Size::Desktop { "22pt" } else { "16pt" };
    s.push_str(&format!(
        "#align(center, text(size: {title_size}, weight: \"bold\", fill: rgb(\"#{}\"))[{}])\n\n",
        t.ink,
        esc_markup(title)
    ));
    s.push_str(&format!(
        "#align(center, text(size: 11pt, fill: rgb(\"#{}\"))[{}])\n\n",
        t.ink,
        esc_markup(&subtitle)
    ));
    s.push_str("#v(1.5em)\n");
    s.push_str(&format!(
        "#show outline.entry: set text(fill: rgb(\"#{}\"))\n",
        t.ink
    ));
    s.push_str("#outline(title: [Contents], depth: 2, indent: auto)\n");
    s.push_str("#pagebreak()\n\n");
    Ok(s)
}

/// A heading that starts a "part"/group (developer manual), with a page break.
fn part(title: &str) -> String {
    format!("#pagebreak(weak: true)\n= {}\n\n", esc_markup(title))
}

fn assemble(opts: &Opts) -> Result<String> {
    let version = cargo_version()?;
    let mut images = ImageCache::new();
    let mut doc = preamble(opts);
    doc.push_str(&cover_and_toc(opts, &version)?);

    if opts.manual == Manual::User {
        // gh-pages user guide, then blog (nested under a "Blog" heading).
        let mut first = true;
        let mut user_docs = glob_sorted("gh-pages/docs/user", "md");
        user_docs.extend(glob_sorted("gh-pages/docs/user/app-compatibility", "md"));
        for p in &user_docs {
            if !first {
                doc.push_str("#pagebreak(weak: true)\n");
            }
            first = false;
            let md = clean_markdown(p)?;
            doc.push_str(&MdToTypst::new(p.parent().unwrap().to_path_buf(), 0, &mut images).convert(&md));
        }
        doc.push_str("#pagebreak()\n= Blog\n\n");
        let mut blog = glob_sorted("gh-pages/blog", "md");
        blog.reverse(); // newest first
        for p in &blog {
            doc.push_str("#pagebreak(weak: true)\n");
            let md = clean_markdown(p)?;
            doc.push_str(&MdToTypst::new(p.parent().unwrap().to_path_buf(), 1, &mut images).convert(&md));
        }
    } else {
        // Developer manual: README, gh-pages docs + blog, then architecture.
        doc.push_str(&part("Local Desktop"));
        let readme = repo_root().join("README.md");
        let md = clean_markdown(&readme)?;
        doc.push_str(&MdToTypst::new(repo_root(), 1, &mut images).convert(&md));

        doc.push_str(&part("Documentation"));
        let mut docs = glob_sorted("gh-pages/docs/user", "md");
        docs.extend(glob_sorted("gh-pages/docs/user/app-compatibility", "md"));
        docs.extend(glob_sorted("gh-pages/docs/developer", "md"));
        docs.extend(glob_sorted("gh-pages/docs/developer/bug-cheat-sheet", "md"));
        for p in &docs {
            doc.push_str("#pagebreak(weak: true)\n");
            let md = clean_markdown(p)?;
            doc.push_str(&MdToTypst::new(p.parent().unwrap().to_path_buf(), 1, &mut images).convert(&md));
        }
        doc.push_str(&part("Blog"));
        for p in &glob_sorted("gh-pages/blog", "md") {
            doc.push_str("#pagebreak(weak: true)\n");
            let md = clean_markdown(p)?;
            doc.push_str(&MdToTypst::new(p.parent().unwrap().to_path_buf(), 1, &mut images).convert(&md));
        }

        if opts.callgraph {
            doc.push_str(&part("Architecture — Generated Call Graph"));
            doc.push_str(&rustsrc::callgraph_typst());
        } else {
            doc.push_str(&part("Architecture — A Guided Call Stack"));
            let spine = repo_root().join("docs/architecture.md");
            let expanded = rustsrc::expand_spine(&spine)?;
            doc.push_str(&MdToTypst::new(repo_root(), 1, &mut images).convert(&expanded));
        }
    }
    Ok(doc)
}

fn cargo_version() -> Result<String> {
    let toml = fs::read_to_string(repo_root().join("Cargo.toml"))?;
    for line in toml.lines() {
        if let Some(v) = line.strip_prefix("version") {
            if let Some(q) = v.split('"').nth(1) {
                return Ok(q.to_string());
            }
        }
    }
    Ok("0.0.0".into())
}

// ----------------------------------------------------------------------------
// Render
// ----------------------------------------------------------------------------

fn render(opts: &Opts) -> Result<()> {
    let source = assemble(opts)?;
    // Keep the generated Typst for debugging.
    fs::create_dir_all(repo_root().join("build/docs"))?;
    fs::write(repo_root().join("build/docs/last.typ"), &source)?;

    let t = opts.theme();
    let mut font_bytes = fonts(t.font, &t.font.to_lowercase())?;
    // Embed Lato (fallback) and a real monospace for code — without a mono font,
    // Typst's syntax highlighting renders code in a proportional font and eats
    // inter-token spaces.
    font_bytes.extend(fonts("Lato", "lato").unwrap_or_default());
    font_bytes.extend(fonts("IBMPlexMono", "ibmplexmono").unwrap_or_default());

    let engine = TypstEngine::builder()
        .main_file(source)
        .fonts(font_bytes)
        .with_file_system_resolver(repo_root())
        .build();
    let doc = engine
        .compile()
        .output
        .map_err(|e| anyhow!("typst compile: {e:?}"))?;
    let pdf = typst_pdf::pdf(&doc, &Default::default()).map_err(|e| anyhow!("pdf: {e:?}"))?;

    let out = opts.out_path();
    fs::create_dir_all(out.parent().unwrap())?;
    fs::write(&out, &pdf)?;
    println!("✓ Wrote {} ({} KB)", out.display(), pdf.len() / 1024);
    Ok(())
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "all") {
        let mut variants: Vec<(Manual, bool, Size, bool)> = Vec::new();
        // Developer manual: Desktop + Fold, curated + call-graph (no phone — it's a
        // code reference, not phone reading).
        for &size in &[Size::Desktop, Size::Fold] {
            for &callgraph in &[false, true] {
                variants.push((Manual::Developer, callgraph, size, false));
            }
        }
        // User manual: every size × theme (the 6 release variants).
        for &size in &[Size::Desktop, Size::Fold, Size::Phone] {
            for &dark in &[false, true] {
                variants.push((Manual::User, false, size, dark));
            }
        }
        // purge
        let mdir = repo_root().join("manuals");
        let _ = fs::remove_dir_all(&mdir);
        fs::create_dir_all(&mdir)?;
        for (manual, callgraph, size, dark) in variants {
            render(&Opts {
                manual,
                callgraph,
                size,
                dark,
            })?;
        }
        println!("✓ Rebuilt all manuals into manuals/");
        return Ok(());
    }

    let mut opts = Opts {
        manual: Manual::Developer,
        callgraph: false,
        size: Size::Desktop,
        dark: false,
    };
    for a in &args {
        match a.as_str() {
            "developer" => opts.manual = Manual::Developer,
            "user" => opts.manual = Manual::User,
            "curated" => opts.callgraph = false,
            "callgraph" => opts.callgraph = true,
            "normal" | "desktop" => opts.size = Size::Desktop,
            "compact" | "fold" | "foldable" => opts.size = Size::Fold,
            "phone" | "mobile" => opts.size = Size::Phone,
            "light" => opts.dark = false,
            "dark" => opts.dark = true,
            other => eprintln!("Ignoring unknown argument '{other}'."),
        }
    }
    if opts.dark && opts.manual != Manual::User {
        eprintln!("Note: 'dark' only styles the user manual; ignoring.");
        opts.dark = false;
    }
    render(&opts)
}

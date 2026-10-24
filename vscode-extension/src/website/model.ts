import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";

/** Pure model of the Docusaurus site in gh-pages/ (blog posts, docs trees, tags, authors). */

export const SITE_URL = "https://localdesktop.github.io";

export interface FrontMatter {
  data: Record<string, unknown>;
  body: string;
  /** False when the file has no `---` block. */
  present: boolean;
}

export function parseFrontMatter(text: string): FrontMatter {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { data: {}, body: text, present: false };
  let data: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(m[1]!) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
  } catch {
    // invalid YAML: treat as empty; publish validation reports it
  }
  return { data, body: text.slice(m[0].length), present: true };
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const bool = (v: unknown): boolean => v === true || v === "true";

function stringList(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.map((x) => (typeof x === "string" ? x : x && typeof x === "object" && "label" in x ? String((x as { label: unknown }).label) : "")).filter(Boolean);
  }
  return typeof v === "string" && v ? [v] : [];
}

/** First `# Heading` of a Markdown body. */
export function firstHeading(body: string): string | undefined {
  return /^#\s+(.+?)\s*#*\s*$/m.exec(body)?.[1];
}

export function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

// ---------------------------------------------------------------------------------------------
// Blog

export interface BlogPost {
  file: string;
  fileName: string;
  date: string;
  slug: string;
  title: string;
  description?: string;
  /** Author keys (from authors.yml) or inline author names. */
  authors: string[];
  inlineAuthors: boolean;
  tags: string[];
  image?: string;
  draft: boolean;
  unlisted: boolean;
  hasTruncate: boolean;
  url: string;
}

const BLOG_FILE = /^(\d{4})-(\d{2})-(\d{2})-(.+)\.mdx?$/;

export function blogUrl(date: string, slug: string, frontMatterSlug?: string): string {
  if (frontMatterSlug) return ensureTrailingSlash(`/blog/${frontMatterSlug.replace(/^\/+/, "")}`);
  const [y, m, d] = date.split("-");
  return `/blog/${y}/${m}/${d}/${slug}/`;
}

export function parseBlogPost(file: string, text: string): BlogPost | undefined {
  const fileName = path.basename(file);
  const m = BLOG_FILE.exec(fileName);
  if (!m) return undefined;
  const fm = parseFrontMatter(text);
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  const slug = m[4]!;
  const rawAuthors = fm.data.authors;
  const inlineAuthors = Array.isArray(rawAuthors) && rawAuthors.some((a) => a && typeof a === "object");
  const authors = Array.isArray(rawAuthors)
    ? rawAuthors.map((a) => (typeof a === "string" ? a : a && typeof a === "object" ? String((a as { name?: unknown }).name ?? "") : "")).filter(Boolean)
    : typeof rawAuthors === "string"
      ? [rawAuthors]
      : [];
  return {
    file,
    fileName,
    date,
    slug,
    title: str(fm.data.title) ?? firstHeading(fm.body) ?? slug,
    description: str(fm.data.description),
    authors,
    inlineAuthors,
    tags: stringList(fm.data.tags),
    image: str(fm.data.image),
    draft: bool(fm.data.draft),
    unlisted: bool(fm.data.unlisted),
    hasTruncate: /<!--\s*truncate\s*-->|\{\/\*\s*truncate\s*\*\/\}/.test(fm.body),
    url: blogUrl(date, slug, str(fm.data.slug)),
  };
}

// ---------------------------------------------------------------------------------------------
// Docs

export interface DocPage {
  kind: "page";
  file: string;
  /** Path relative to gh-pages/docs, e.g. "user/1-getting-started.md". */
  rel: string;
  title: string;
  position?: number;
  draft: boolean;
  unlisted: boolean;
  url: string;
}

export interface DocFolder {
  kind: "folder";
  dir: string;
  rel: string;
  label: string;
  position?: number;
  children: (DocPage | DocFolder)[];
}

/** Docusaurus' number-prefix rule: "1-getting-started" → { position: 1, name: "getting-started" }. */
export function stripNumberPrefix(name: string): { position?: number; name: string } {
  const m = /^(\d+)\s*[-_.]+\s*([^-_.\s].*)$/.exec(name);
  return m ? { position: parseInt(m[1]!, 10), name: m[2]! } : { name };
}

/** URL of a doc: number prefixes stripped from every segment, trailing slash (trailingSlash: true). */
export function docUrl(rel: string, frontMatter: Record<string, unknown> = {}): string {
  const segments = rel.replace(/\\/g, "/").split("/");
  const file = segments.pop()!;
  const dirs = segments.map((s) => stripNumberPrefix(s).name);
  const slug = str(frontMatter.slug);
  if (slug) {
    return ensureTrailingSlash(slug.startsWith("/") ? `/docs${slug}` : `/docs/${[...dirs, slug].join("/")}`);
  }
  const base = stripNumberPrefix(file.replace(/\.mdx?$/, "")).name;
  const id = str(frontMatter.id) ?? base;
  const parts = /^(index|readme)$/i.test(id) ? dirs : [...dirs, id];
  return ensureTrailingSlash(`/docs/${parts.join("/")}`);
}

/** Docusaurus order: explicit/prefix position ascending first, then the rest by file name. */
export function sortDocItems<T extends { position?: number; rel: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    if (a.position !== undefined && b.position !== undefined && a.position !== b.position) return a.position - b.position;
    if (a.position !== undefined && b.position === undefined) return -1;
    if (a.position === undefined && b.position !== undefined) return 1;
    return path.basename(a.rel).localeCompare(path.basename(b.rel));
  });
}

function readCategory(dir: string): { label?: string; position?: number } {
  for (const name of ["_category_.yml", "_category_.yaml", "_category_.json"]) {
    try {
      const raw = fs.readFileSync(path.join(dir, name), "utf8");
      const data = (name.endsWith(".json") ? JSON.parse(raw) : parseYaml(raw)) as Record<string, unknown> | null;
      return { label: str(data?.label), position: typeof data?.position === "number" ? data.position : undefined };
    } catch {
      // try next
    }
  }
  return {};
}

function humanize(name: string): string {
  const s = name.replace(/[-_]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function readDocFolder(docsRoot: string, rel: string): DocFolder {
  const dir = path.join(docsRoot, rel);
  const cat = readCategory(dir);
  const children: (DocPage | DocFolder)[] = [];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // missing folder
  }
  for (const e of entries) {
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      children.push(readDocFolder(docsRoot, childRel));
    } else if (/\.mdx?$/.test(e.name) && !e.name.startsWith("_")) {
      const file = path.join(dir, e.name);
      const fm = parseFrontMatter(fs.readFileSync(file, "utf8"));
      const prefix = stripNumberPrefix(e.name.replace(/\.mdx?$/, ""));
      const sidebarPosition = typeof fm.data.sidebar_position === "number" ? fm.data.sidebar_position : undefined;
      children.push({
        kind: "page",
        file,
        rel: childRel,
        title: str(fm.data.sidebar_label) ?? str(fm.data.title) ?? firstHeading(fm.body) ?? humanize(prefix.name),
        position: sidebarPosition ?? prefix.position,
        draft: bool(fm.data.draft),
        unlisted: bool(fm.data.unlisted),
        url: docUrl(childRel, fm.data),
      });
    }
  }
  const prefix = stripNumberPrefix(path.basename(rel));
  return {
    kind: "folder",
    dir,
    rel,
    label: cat.label ?? humanize(prefix.name),
    position: cat.position ?? prefix.position,
    children: sortDocItems(children),
  };
}

// ---------------------------------------------------------------------------------------------
// Whole site

export interface Author {
  name?: string;
  title?: string;
  url?: string;
  image_url?: string;
}

export interface WebsiteModel {
  root: string;
  site: string;
  blog: BlogPost[];
  manuals: { user: DocFolder; developer: DocFolder };
  tags: { tag: string; count: number }[];
  authors: Record<string, Author>;
}

export function readAuthors(site: string): Record<string, Author> {
  try {
    const data = parseYaml(fs.readFileSync(path.join(site, "blog", "authors.yml"), "utf8")) as Record<string, Author> | null;
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

export function collectTags(posts: readonly BlogPost[]): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const p of posts) for (const t of p.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

export function readWebsite(root: string): WebsiteModel {
  const site = path.join(root, "gh-pages");
  const blogDir = path.join(site, "blog");
  const blog: BlogPost[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(blogDir);
  } catch {
    // no blog
  }
  for (const name of names) {
    if (!BLOG_FILE.test(name)) continue;
    const file = path.join(blogDir, name);
    const post = parseBlogPost(file, fs.readFileSync(file, "utf8"));
    if (post) blog.push(post);
  }
  blog.sort((a, b) => b.date.localeCompare(a.date) || b.fileName.localeCompare(a.fileName));
  const docsRoot = path.join(site, "docs");
  return {
    root,
    site,
    blog,
    manuals: { user: readDocFolder(docsRoot, "user"), developer: readDocFolder(docsRoot, "developer") },
    tags: collectTags(blog),
    authors: readAuthors(site),
  };
}

/** Maps a file under gh-pages/blog or gh-pages/docs to its site URL (undefined for other files). */
export function urlForFile(root: string, file: string): string | undefined {
  const site = path.join(root, "gh-pages");
  const rel = path.relative(site, file).replace(/\\/g, "/");
  if (rel.startsWith("blog/")) {
    if (!fs.existsSync(file)) return undefined;
    return parseBlogPost(file, fs.readFileSync(file, "utf8"))?.url;
  }
  if (rel.startsWith("docs/") && /\.mdx?$/.test(rel)) {
    const fm = fs.existsSync(file) ? parseFrontMatter(fs.readFileSync(file, "utf8")).data : {};
    return docUrl(rel.slice("docs/".length), fm);
  }
  return undefined;
}

/** ASCII kebab-case slug, at most 60 characters. */
export function slugify(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

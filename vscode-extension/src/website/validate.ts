import * as fs from "node:fs";
import * as path from "node:path";
import type { WebsiteChange } from "./changes";
import { parseBlogPost, parseFrontMatter, slugify } from "./model";

// Pure checks and naming for publishing website changes (publish.ts).

export interface ValidationIssue {
  path: string;
  severity: "error" | "warning";
  message: string;
}

/** Checks a changed site file the way Docusaurus (and readers) would trip over it. */
export function validateSiteFile(root: string, relPath: string, text: string, authors: Record<string, unknown>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (severity: ValidationIssue["severity"], message: string) => issues.push({ path: relPath, severity, message });
  const name = path.basename(relPath);
  if (relPath.startsWith("gh-pages/blog/") && /\.mdx?$/.test(name)) {
    const post = parseBlogPost(path.join(root, relPath), text);
    if (!post) {
      add("error", "Blog post file names must look like YYYY-MM-DD-slug.md");
      return issues;
    }
    const fm = parseFrontMatter(text);
    if (!fm.present) add("error", "Missing front matter (--- title/authors/tags ---)");
    if (!fm.data.title) add("error", "Missing `title` in front matter");
    if (!post.authors.length) add("warning", "No `authors`");
    if (!post.inlineAuthors) {
      for (const a of post.authors) if (!(a in authors)) add("error", `Author \`${a}\` isn't in gh-pages/blog/authors.yml`);
    }
    if (!post.hasTruncate) add("warning", "No `<!-- truncate -->` marker; the whole post will show on the blog index");
    const images = new Set([post.image, ...[...fm.body.matchAll(/!\[[^\]]*\]\((\/img\/[^)\s]+)\)/g)].map((m) => m[1])].filter(Boolean) as string[]);
    for (const img of images) {
      if (img.startsWith("/") && !fs.existsSync(path.join(root, "gh-pages", "static", img))) add("error", `Image ${img} doesn't exist in gh-pages/static`);
    }
  } else if (relPath.startsWith("gh-pages/docs/") && /\.mdx?$/.test(name)) {
    const fm = parseFrontMatter(text);
    if (!fm.data.title && !/^#\s/m.test(fm.body)) add("warning", "No `title` front matter or `# Heading`");
  }
  return issues;
}

export function isText(p: string): boolean {
  return /\.(mdx?|ya?ml|json|tsx?|jsx?|css|scss|html|txt|svg)$/i.test(p);
}

export function branchNameFor(changes: readonly WebsiteChange[], root: string, today: string): string {
  const post = changes.find((c) => c.status !== "deleted" && c.path.startsWith("gh-pages/blog/") && /\.mdx?$/.test(c.path));
  if (post) {
    const parsed = parseBlogPost(path.join(root, post.path), "");
    if (parsed) return `website/${parsed.slug}`;
  }
  const doc = changes.find((c) => c.status !== "deleted" && c.path.startsWith("gh-pages/docs/"));
  if (doc) return `website/docs-${slugify(path.basename(doc.path).replace(/\.mdx?$/, "").replace(/^\d+-/, ""))}`;
  return `website/update-${today}`;
}

export function defaultTitle(changes: readonly WebsiteChange[], root: string): string {
  const posts = changes.filter((c) => c.status !== "deleted" && c.path.startsWith("gh-pages/blog/") && /\.mdx?$/.test(c.path));
  if (posts.length === 1) {
    const file = path.join(root, posts[0]!.path);
    const post = fs.existsSync(file) ? parseBlogPost(file, fs.readFileSync(file, "utf8")) : undefined;
    if (post) return `Blog: ${post.title}`;
  }
  const docs = changes.filter((c) => c.path.startsWith("gh-pages/docs/"));
  if (docs.length && docs.length === changes.length) return "Docs: update";
  return "Website: update";
}

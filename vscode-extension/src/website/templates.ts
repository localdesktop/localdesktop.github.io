import { stringify as toYaml } from "yaml";
import { stripNumberPrefix } from "./model";

// Pure generators for new blog posts and doc pages (snapshot-tested).

export interface NewPostInput {
  title: string;
  date: string;
  slug: string;
  authors: string[];
  tags: string[];
  description?: string;
  /** Site path, e.g. /img/blog/my-post.webp */
  image?: string;
}

function yamlScalar(v: string): string {
  return toYaml(v).trimEnd();
}

/** The new post's file name and content (pure, snapshot-tested). Matches existing posts' style. */
export function renderBlogPost(input: NewPostInput): { fileName: string; content: string } {
  const lines = ["---", `title: ${yamlScalar(input.title)}`];
  if (input.description) lines.push(`description: ${yamlScalar(input.description)}`);
  lines.push(`authors: ${input.authors.length === 1 ? input.authors[0] : `[${input.authors.join(", ")}]`}`);
  lines.push(`tags: [${input.tags.join(", ")}]`);
  if (input.image) lines.push(`image: ${input.image}`);
  lines.push("---", "");
  if (input.image) lines.push(`![${input.title.replace(/[[\]]/g, "")}](${input.image})`, "");
  lines.push("Write the introduction here: one or two paragraphs that appear on the blog index.", "", "<!-- truncate -->", "", "## Details", "", "");
  return { fileName: `${input.date}-${input.slug}.md`, content: lines.join("\n") };
}

export function todayIso(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Docs PDFs sort file names as strings (build_docs.rs glob_sorted), so "10-x" lands before "2-y". */
export const PDF_ORDER_LIMIT = 10;

/**
 * File name for a new doc in `siblings`: numbered (`<max+1>-slug.md`) only when the existing
 * pages use number prefixes, like the user and developer manuals do.
 */
export function nextDocName(siblings: readonly string[], slug: string, ext = ".md"): { name: string; prefix?: number } {
  const pages = siblings.filter((n) => /\.mdx?$/.test(n) && !n.startsWith("_"));
  const numbered = pages.map((n) => stripNumberPrefix(n.replace(/\.mdx?$/, "")).position).filter((p): p is number => p !== undefined);
  if (!pages.length || numbered.length < pages.length / 2) return { name: `${slug}${ext}` };
  const prefix = Math.max(0, ...numbered) + 1;
  return { name: `${prefix}-${slug}${ext}`, prefix };
}

export function renderDoc(title: string): string {
  return `---\ntitle: ${toYaml(title).trimEnd()}\n---\n\n`;
}

export function renderCategory(label: string): string {
  return `${toYaml({ label, collapsed: false }).trimEnd()}\n`;
}

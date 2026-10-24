import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parseNameStatus } from "../../src/website/changes";
import { blogUrl, docUrl, parseBlogPost, parseFrontMatter, readWebsite, slugify, sortDocItems, stripNumberPrefix, urlForFile } from "../../src/website/model";
import { isInPdf, parsePdfFolders, readPdfFolders } from "../../src/website/pdfCoverage";
import { nextDocName, renderBlogPost, renderCategory, renderDoc, todayIso } from "../../src/website/templates";
import { branchNameFor, defaultTitle, validateSiteFile } from "../../src/website/validate";

const REPO = path.resolve(__dirname, "../../..");

describe("URLs", () => {
  it("maps blog posts to dated permalinks", () => {
    expect(blogUrl("2026-10-16", "elementary-mobile")).toBe("/blog/2026/10/16/elementary-mobile/");
    expect(blogUrl("2026-10-16", "x", "custom/slug")).toBe("/blog/custom/slug/");
  });
  it("strips number prefixes from doc URLs", () => {
    expect(docUrl("user/1-getting-started.md")).toBe("/docs/user/getting-started/");
    expect(docUrl("developer/bug-cheat-sheet/android-debug.md")).toBe("/docs/developer/bug-cheat-sheet/android-debug/");
    expect(docUrl("developer/10-new-thing.mdx")).toBe("/docs/developer/new-thing/");
    expect(docUrl("user/3-guides/index.md")).toBe("/docs/user/guides/");
    expect(docUrl("user/1-x.md", { slug: "/custom" })).toBe("/docs/custom/");
    expect(docUrl("user/1-x.md", { id: "renamed" })).toBe("/docs/user/renamed/");
  });
  it("follows Docusaurus' number prefix rule", () => {
    expect(stripNumberPrefix("1-getting-started")).toEqual({ position: 1, name: "getting-started" });
    expect(stripNumberPrefix("2024-recap")).toEqual({ position: 2024, name: "recap" });
    expect(stripNumberPrefix("bug-cheat-sheet")).toEqual({ name: "bug-cheat-sheet" });
  });
  it("orders positioned items first, numerically", () => {
    const items = [{ rel: "b.md" }, { rel: "10-z.md", position: 10 }, { rel: "2-y.md", position: 2 }, { rel: "a.md" }];
    expect(sortDocItems(items).map((i) => i.rel)).toEqual(["2-y.md", "10-z.md", "a.md", "b.md"]);
  });
});

describe("the real site", () => {
  const site = readWebsite(REPO);
  it("lists blog posts newest first with URLs and tags", () => {
    expect(site.blog.length).toBeGreaterThan(5);
    for (let i = 1; i < site.blog.length; i++) expect(site.blog[i - 1]!.date >= site.blog[i]!.date).toBe(true);
    for (const p of site.blog) expect(p.url).toMatch(/^\/blog\/\d{4}\/\d{2}\/\d{2}\/[a-z0-9-]+\/$/);
    expect(site.tags.find((t) => t.tag === "for-user")?.count).toBeGreaterThan(1);
    expect(site.authors.teddy?.name).toBeTruthy();
  });
  it("handles inline author objects", () => {
    const post = site.blog.find((p) => p.fileName.startsWith("2025-07-29-built-in-gui"));
    expect(post?.inlineAuthors).toBe(true);
    expect(post?.authors).toEqual(["Mister Teddy"]);
  });
  it("builds the docs trees in sidebar order", () => {
    const user = site.manuals.user;
    expect(user.children[0]).toMatchObject({ kind: "page", url: "/docs/user/getting-started/", title: "Getting Started" });
    const compat = user.children.find((c) => c.kind === "folder");
    expect(compat).toMatchObject({ kind: "folder", label: "App Compatibility", rel: "user/app-compatibility" });
    const dev = site.manuals.developer;
    const positions = dev.children.filter((c) => c.kind === "page").map((c) => c.position);
    expect(positions.slice(0, 9)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const pipewire = dev.children.find((c) => c.kind === "page" && c.rel.includes("pipewire"));
    expect(pipewire?.kind === "page" && pipewire.title).toBeTruthy();
  });
  it("maps files to URLs", () => {
    expect(urlForFile(REPO, path.join(REPO, "gh-pages", "docs", "developer", "3-how-to-logcat.md"))).toBe("/docs/developer/how-to-logcat/");
    expect(urlForFile(REPO, path.join(REPO, "gh-pages", "blog", "2026-10-16-elementary-mobile.md"))).toBe("/blog/2026/10/16/elementary-mobile/");
    expect(urlForFile(REPO, path.join(REPO, "README.md"))).toBeUndefined();
  });
});

describe("PDF coverage", () => {
  it("reads the folders build_docs.rs includes", () => {
    const folders = readPdfFolders(REPO)!;
    expect([...folders].sort()).toEqual(
      ["gh-pages/blog", "gh-pages/docs/developer", "gh-pages/docs/developer/bug-cheat-sheet", "gh-pages/docs/user", "gh-pages/docs/user/app-compatibility"].sort(),
    );
    expect(isInPdf(folders, "developer/bug-cheat-sheet")).toBe(true);
    expect(isInPdf(folders, "developer/new-category")).toBe(false);
    expect(isInPdf(undefined, "anything")).toBe(true);
  });
  it("parses glob_sorted calls", () => {
    expect([...parsePdfFolders('glob_sorted("gh-pages/docs/x", "md"); glob_sorted( "a/b/" , "md" ); glob_sorted("c", "png")')]).toEqual(["gh-pages/docs/x", "a/b"]);
  });
});

describe("templates", () => {
  it("renders a new blog post", () => {
    const { fileName, content } = renderBlogPost({
      title: "Local Desktop: now with chat!",
      date: "2026-10-20",
      slug: "local-desktop-now-with-chat",
      authors: ["teddy"],
      tags: ["for-dev", "community"],
      image: "/img/blog/local-desktop-now-with-chat.webp",
    });
    expect(fileName).toBe("2026-10-20-local-desktop-now-with-chat.md");
    expect(content).toMatchInlineSnapshot(`
      "---
      title: "Local Desktop: now with chat!"
      authors: teddy
      tags: [for-dev, community]
      image: /img/blog/local-desktop-now-with-chat.webp
      ---

      ![Local Desktop: now with chat!](/img/blog/local-desktop-now-with-chat.webp)

      Write the introduction here: one or two paragraphs that appear on the blog index.

      <!-- truncate -->

      ## Details

      "
    `);
    const post = parseBlogPost(`/x/${fileName}`, content)!;
    expect(post).toMatchObject({ title: "Local Desktop: now with chat!", authors: ["teddy"], tags: ["for-dev", "community"], hasTruncate: true });
    expect(validateSiteFile(REPO, `gh-pages/blog/${fileName}`, content, { teddy: {} }).filter((i) => i.severity === "error").map((i) => i.message)).toEqual([
      "Image /img/blog/local-desktop-now-with-chat.webp doesn't exist in gh-pages/static",
    ]);
  });
  it("numbers new docs only where siblings are numbered", () => {
    expect(nextDocName(["1-a.md", "2-b.md", "_category_.yml"], "c")).toEqual({ name: "3-c.md", prefix: 3 });
    expect(nextDocName(["firefox.md", "gimp.md", "_category_.yml"], "kdenlive")).toEqual({ name: "kdenlive.md" });
    expect(nextDocName([], "first")).toEqual({ name: "first.md" });
    expect(nextDocName(["1-a.md", "9-b.md", "bug.md"], "z").prefix).toBe(10);
  });
  it("renders doc and category files", () => {
    expect(renderDoc("How to: debug")).toBe('---\ntitle: "How to: debug"\n---\n\n');
    expect(parseFrontMatter(renderDoc("Plain title")).data).toEqual({ title: "Plain title" });
    expect(renderCategory("Maintainer Tools")).toBe("label: Maintainer Tools\ncollapsed: false\n");
  });
  it("slugifies titles", () => {
    expect(slugify("Élementary OS & Pantheon — on Android!")).toBe("elementary-os-and-pantheon-on-android");
    expect(slugify("x".repeat(80)).length).toBe(60);
    expect(todayIso(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});

describe("publishing helpers", () => {
  it("validates posts", () => {
    const bad = "---\nauthors: nobody\n---\nNo title, no truncate.\n";
    const issues = validateSiteFile(REPO, "gh-pages/blog/2026-10-20-x.md", bad, { teddy: {} }).map((i) => `${i.severity}: ${i.message}`);
    expect(issues).toEqual([
      "error: Missing `title` in front matter",
      "error: Author `nobody` isn't in gh-pages/blog/authors.yml",
      "warning: No `<!-- truncate -->` marker; the whole post will show on the blog index",
    ]);
    expect(validateSiteFile(REPO, "gh-pages/blog/bad-name.md", "", {})[0]?.message).toMatch(/YYYY-MM-DD/);
  });
  it("names branches and PRs", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ld-site-"));
    fs.mkdirSync(path.join(tmp, "gh-pages", "blog"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "gh-pages", "blog", "2026-10-20-hello-world.md"), "---\ntitle: Hello World\n---\n");
    const post = [{ path: "gh-pages/blog/2026-10-20-hello-world.md", status: "untracked" as const }];
    expect(branchNameFor(post, tmp, "2026-10-20")).toBe("website/hello-world");
    expect(defaultTitle(post, tmp)).toBe("Blog: Hello World");
    const docs = [{ path: "gh-pages/docs/developer/10-maintainer-tools.md", status: "added" as const }];
    expect(branchNameFor(docs, tmp, "2026-10-20")).toBe("website/docs-maintainer-tools");
    expect(defaultTitle(docs, tmp)).toBe("Docs: update");
    expect(branchNameFor([{ path: "gh-pages/src/pages/index.tsx", status: "modified" }], tmp, "2026-10-20")).toBe("website/update-2026-10-20");
  });
  it("parses git name-status output", () => {
    expect(parseNameStatus("M\0gh-pages/a.md\0A\0gh-pages/b.md\0D\0gh-pages/c.md\0R100\0gh-pages/d.md\0gh-pages/e.md\0")).toEqual([
      { path: "gh-pages/a.md", status: "modified" },
      { path: "gh-pages/b.md", status: "added" },
      { path: "gh-pages/c.md", status: "deleted" },
      { path: "gh-pages/d.md", status: "deleted" },
      { path: "gh-pages/e.md", status: "added" },
    ]);
  });
});

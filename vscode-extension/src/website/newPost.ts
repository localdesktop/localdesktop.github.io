import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { stringify as toYaml } from "yaml";
import { LdError } from "../core/errors";
import type { GitHub } from "../github/client";
import { readWebsite, slugify, type Author } from "./model";
import { renderBlogPost, todayIso } from "./templates";

/** Copies an image into gh-pages/static/img/blog/ under a free name; returns its site path. */
export function copyBlogImage(root: string, source: string, baseName: string): string {
  const dir = path.join(root, "gh-pages", "static", "img", "blog");
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(source).toLowerCase() || ".png";
  let name = `${baseName}${ext}`;
  for (let n = 2; fs.existsSync(path.join(dir, name)); n++) name = `${baseName}-${n}${ext}`;
  fs.copyFileSync(source, path.join(dir, name));
  return `/img/blog/${name}`;
}

function appendAuthor(root: string, key: string, author: Author): void {
  const file = path.join(root, "gh-pages", "blog", "authors.yml");
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const block = toYaml({ [key]: author }).trimEnd();
  fs.writeFileSync(file, `${existing.replace(/\s*$/, "")}${existing.trim() ? "\n\n" : ""}${block}\n`);
}

/** New blog post wizard: title → slug, date, tags, author, optional cover image. */
export async function newBlogPost(root: string, github: GitHub): Promise<vscode.Uri | undefined> {
  const site = readWebsite(root);
  const title = await vscode.window.showInputBox({ title: "New blog post (1/5)", prompt: "Title", ignoreFocusOut: true, validateInput: (v) => (v.trim() ? undefined : "Required") });
  if (!title) return undefined;
  const slugInput = await vscode.window.showInputBox({
    title: "New blog post (2/5)",
    prompt: "URL slug",
    value: slugify(title),
    ignoreFocusOut: true,
    validateInput: (v) => (/^[a-z0-9]+(-[a-z0-9]+)*$/.test(v) ? undefined : "Lowercase letters, digits and dashes"),
  });
  if (!slugInput) return undefined;
  const date = await vscode.window.showInputBox({
    title: "New blog post (3/5)",
    prompt: "Publish date",
    value: todayIso(),
    ignoreFocusOut: true,
    validateInput: (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? undefined : "YYYY-MM-DD"),
  });
  if (!date) return undefined;

  const tagItems: vscode.QuickPickItem[] = site.tags.map((t) => ({ label: t.tag, description: `${t.count} post${t.count === 1 ? "" : "s"}` }));
  const tagPick = vscode.window.createQuickPick();
  tagPick.title = "New blog post (4/5): tags";
  tagPick.placeholder = "Pick tags, or type a new one and press Enter";
  tagPick.canSelectMany = true;
  tagPick.items = tagItems;
  tagPick.ignoreFocusOut = true;
  const tags = await new Promise<string[] | undefined>((resolve) => {
    tagPick.onDidChangeValue((value) => {
      const v = slugify(value);
      const extra = v && !tagItems.some((i) => i.label === v) ? [{ label: v, description: "new tag" }] : [];
      const selected = tagPick.selectedItems;
      tagPick.items = [...extra, ...tagItems];
      tagPick.selectedItems = tagPick.items.filter((i) => selected.some((s) => s.label === i.label));
    });
    tagPick.onDidAccept(() => {
      resolve(tagPick.selectedItems.map((i) => i.label));
      tagPick.hide();
    });
    tagPick.onDidHide(() => resolve(undefined));
    tagPick.show();
  });
  tagPick.dispose();
  if (!tags) return undefined;

  const authorItems: (vscode.QuickPickItem & { key?: string })[] = Object.entries(site.authors).map(([key, a]) => ({
    label: a.name ?? key,
    description: key,
    detail: a.title,
    key,
  }));
  authorItems.push({ label: "$(add) Add me to authors.yml", description: "from your GitHub profile" });
  const authorPick = await vscode.window.showQuickPick(authorItems, { title: "New blog post (5/5): author", ignoreFocusOut: true });
  if (!authorPick) return undefined;
  let authorKey = authorPick.key;
  if (!authorKey) {
    const c = await github.client();
    const { data: me } = await c.rest.users.getAuthenticated();
    authorKey = me.login.toLowerCase().replace(/[^a-z0-9_-]/g, "");
    if (!site.authors[authorKey]) {
      appendAuthor(root, authorKey, {
        name: me.name ?? me.login,
        title: "Local Desktop maintainer",
        url: me.blog || me.html_url,
        image_url: me.avatar_url,
      });
    }
  }

  let image: string | undefined;
  const wantImage = await vscode.window.showQuickPick(["No cover image", "Choose a cover image…"], { title: "Cover image (optional)", ignoreFocusOut: true });
  if (wantImage === "Choose a cover image…") {
    const files = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { Images: ["webp", "png", "jpg", "jpeg", "gif", "svg"] } });
    if (files?.[0]) image = copyBlogImage(root, files[0].fsPath, slugInput);
  }

  const { fileName, content } = renderBlogPost({ title: title.trim(), date, slug: slugInput, authors: [authorKey], tags, image });
  const file = path.join(root, "gh-pages", "blog", fileName);
  if (fs.existsSync(file)) throw new LdError("INVALID_ARGUMENT", `${fileName} already exists.`);
  fs.writeFileSync(file, content);
  const doc = await vscode.workspace.openTextDocument(file);
  const editor = await vscode.window.showTextDocument(doc);
  const introLine = content.split("\n").findIndex((l) => l.startsWith("Write the introduction"));
  if (introLine >= 0) {
    const range = doc.lineAt(introLine).range;
    editor.selection = new vscode.Selection(range.start, range.end);
  }
  return doc.uri;
}

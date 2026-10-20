import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { LdError } from "../core/errors";
import { slugify } from "./model";
import { isInPdf, readPdfFolders } from "./pdfCoverage";
import { nextDocName, PDF_ORDER_LIMIT, renderCategory, renderDoc } from "./templates";

async function pickFolder(root: string, initial?: string): Promise<string | undefined> {
  if (initial) return initial;
  const docs = path.join(root, "gh-pages", "docs");
  const folders: string[] = [];
  const walk = (rel: string) => {
    folders.push(rel);
    for (const e of fs.readdirSync(path.join(docs, rel), { withFileTypes: true })) if (e.isDirectory()) walk(`${rel}/${e.name}`);
  };
  for (const top of ["user", "developer"]) if (fs.existsSync(path.join(docs, top))) walk(top);
  const pick = await vscode.window.showQuickPick(
    folders.map((f) => ({ label: f, description: f === "user" ? "User Manual" : f === "developer" ? "Developer Manual" : undefined })),
    { title: "Where?" },
  );
  return pick?.label;
}

/** Creates a doc page; `folderRel` is relative to gh-pages/docs (from the tree), else asked. */
export async function newDocPage(root: string, folderRel?: string): Promise<vscode.Uri | undefined> {
  const rel = await pickFolder(root, folderRel);
  if (!rel) return undefined;
  const dir = path.join(root, "gh-pages", "docs", rel);
  const title = await vscode.window.showInputBox({ title: `New page in ${rel}`, prompt: "Title", validateInput: (v) => (v.trim() ? undefined : "Required") });
  if (!title) return undefined;
  const { name, prefix } = nextDocName(fs.readdirSync(dir), slugify(title));
  const file = path.join(dir, name);
  if (fs.existsSync(file)) throw new LdError("INVALID_ARGUMENT", `${name} already exists.`);
  if (prefix !== undefined && prefix >= PDF_ORDER_LIMIT) {
    const go = await vscode.window.showWarningMessage(
      `This will be page ${prefix}. The website orders it correctly, but the offline PDF manuals sort file names as text, so “${name}” comes before “2-…” there.`,
      "Create Anyway",
    );
    if (!go) return undefined;
  }
  fs.writeFileSync(file, renderDoc(title.trim()));
  const doc = await vscode.workspace.openTextDocument(file);
  const editor = await vscode.window.showTextDocument(doc);
  const end = doc.lineAt(doc.lineCount - 1).range.end;
  editor.selection = new vscode.Selection(end, end);
  return doc.uri;
}

/** Creates a docs category folder with _category_.yml. */
export async function newDocCategory(root: string, parentRel?: string): Promise<string | undefined> {
  const rel = await pickFolder(root, parentRel);
  if (!rel) return undefined;
  const label = await vscode.window.showInputBox({ title: `New category in ${rel}`, prompt: "Sidebar label", validateInput: (v) => (v.trim() ? undefined : "Required") });
  if (!label) return undefined;
  const dirName = slugify(label);
  const childRel = `${rel}/${dirName}`;
  const dir = path.join(root, "gh-pages", "docs", childRel);
  if (fs.existsSync(dir)) throw new LdError("INVALID_ARGUMENT", `${childRel} already exists.`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "_category_.yml"), renderCategory(label.trim()));
  const inPdf = isInPdf(readPdfFolders(root), childRel);
  const actions = ["New Page in It"];
  const message = inPdf
    ? `Created ${childRel}.`
    : `Created ${childRel}. Note: the offline PDF manuals only include folders listed in src/bin/build_docs.rs; add it there to include it.`;
  const choice = await (inPdf ? vscode.window.showInformationMessage : vscode.window.showWarningMessage)(message, ...actions, ...(inPdf ? [] : ["Open build_docs.rs"]));
  if (choice === "New Page in It") await newDocPage(root, childRel);
  else if (choice === "Open build_docs.rs") {
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(root, "src", "bin", "build_docs.rs")));
  }
  return childRel;
}

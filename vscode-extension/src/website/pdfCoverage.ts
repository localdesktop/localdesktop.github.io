import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Folders the offline PDF manuals include. src/bin/build_docs.rs globs a hard-coded list of
 * directories (`glob_sorted("gh-pages/docs/user", "md")` …); docs in any other folder are on the
 * website only.
 */
export function parsePdfFolders(buildDocsRs: string): Set<string> {
  const folders = new Set<string>();
  const re = /glob_sorted\(\s*"([^"]+)"\s*,\s*"md"\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(buildDocsRs))) folders.add(m[1]!.replace(/\/+$/, ""));
  return folders;
}

export function readPdfFolders(root: string): Set<string> | undefined {
  try {
    return parsePdfFolders(fs.readFileSync(path.join(root, "src", "bin", "build_docs.rs"), "utf8"));
  } catch {
    return undefined;
  }
}

/** True when a docs folder (relative to gh-pages/docs, e.g. "developer/bug-cheat-sheet") is in the PDFs. */
export function isInPdf(folders: Set<string> | undefined, docsRel: string): boolean {
  if (!folders) return true;
  return folders.has(`gh-pages/docs/${docsRel}`.replace(/\/+$/, ""));
}

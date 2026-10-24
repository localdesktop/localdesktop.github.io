/**
 * Paths that don't affect the Android app. PRs touching only these need no release label and build
 * no APK. Keep in sync with build.yml and auto-bump-version.yml (a unit test checks it).
 */
export const NON_APP_PREFIXES: readonly string[] = ["gh-pages/", "vscode-extension/", ".vscode/"];

export const NON_APP_FILES: ReadonlySet<string> = new Set([
  ".mcp.json",
  ".cursor/mcp.json",
  "AGENTS.md",
  "CLAUDE.md",
  ".github/localdesktop-dev.json",
  ".github/workflows/vscode-extension.yml",
]);

export function isNonApp(path: string): boolean {
  return NON_APP_PREFIXES.some((prefix) => path.startsWith(prefix)) || NON_APP_FILES.has(path);
}

export interface ChangedFile {
  filename: string;
  previous_filename?: string;
}

export function isNonAppOnly(files: readonly ChangedFile[]): boolean {
  return files.length > 0 && files.every((f) => isNonApp(f.filename) && (!f.previous_filename || isNonApp(f.previous_filename)));
}

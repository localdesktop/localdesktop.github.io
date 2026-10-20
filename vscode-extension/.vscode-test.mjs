import { defineConfig } from "@vscode/test-cli";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default defineConfig({
  files: "dist-test/integration/**/*.test.js",
  workspaceFolder: "..",
  // macOS caps IPC socket paths at 103 chars; keep the user data dir short.
  launchArgs: ["--user-data-dir", mkdtempSync(join(tmpdir(), "ldvt-")), "--disable-extensions"],
  mocha: { timeout: 60000 },
});

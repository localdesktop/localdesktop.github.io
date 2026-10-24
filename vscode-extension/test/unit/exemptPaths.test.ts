import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { isNonAppOnly, NON_APP_FILES, NON_APP_PREFIXES } from "../../src/release/exemptPaths";

const REPO = path.resolve(__dirname, "../../..");

function listsFrom(file: string): { prefixes: string[]; files: string[] } {
  const text = fs.readFileSync(path.join(REPO, ".github", "workflows", file), "utf8");
  const prefixes = /NON_APP_PREFIXES = \[([^\]]*)\]/.exec(text)![1]!;
  const files = /NON_APP_FILES = new Set\(\[([\s\S]*?)\]\)/.exec(text)![1]!;
  const strings = (s: string) => [...s.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  return { prefixes: strings(prefixes), files: strings(files) };
}

describe("exempt paths", () => {
  for (const wf of ["build.yml", "auto-bump-version.yml"]) {
    it(`matches ${wf}`, () => {
      const lists = listsFrom(wf);
      expect(lists.prefixes).toEqual([...NON_APP_PREFIXES]);
      expect(lists.files.sort()).toEqual([...NON_APP_FILES].sort());
    });
  }

  it("classifies PR file lists", () => {
    expect(isNonAppOnly([{ filename: "gh-pages/blog/x.md" }, { filename: "vscode-extension/src/a.ts" }, { filename: ".mcp.json" }])).toBe(true);
    expect(isNonAppOnly([{ filename: "gh-pages/blog/x.md" }, { filename: "src/lib.rs" }])).toBe(false);
    expect(isNonAppOnly([{ filename: "gh-pages/x.md", previous_filename: "src/x.md" }])).toBe(false);
    expect(isNonAppOnly([])).toBe(false);
  });
});

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

function sources(dir: string): string {
  let out = "";
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out += sources(p);
    else if (p.endsWith(".ts")) out += fs.readFileSync(p, "utf8") + "\n";
  }
  return out;
}

const src = sources(path.join(root, "src"));

/** Headless stand-in for the editor smoke test: every contribution has an implementation. */
describe("package.json contributions", () => {
  it("registers every contributed command", () => {
    const registered = new Set<string>();
    // registerCommand(context, "id", …), reg("id", …), vscode.commands.registerCommand("id", …)
    for (const m of src.matchAll(/(?:registerCommand|\breg)\(\s*(?:context\s*,\s*|s\.context\s*,\s*|ctx\s*,\s*)?["'`](localdesktop\.[\w.]+)["'`]/g)) registered.add(m[1]!);
    const missing = (pkg.contributes.commands as { command: string }[]).map((c) => c.command).filter((c) => !registered.has(c));
    expect(missing).toEqual([]);
  });

  it("provides every contributed view", () => {
    const views = Object.values(pkg.contributes.views as Record<string, { id: string }[]>).flat();
    const missing = views.map((v) => v.id).filter((id) => !new RegExp(`(registerTreeDataProvider|createTreeView|registerWebviewViewProvider)\\(\\s*["'\`]${id.replace(/\./g, "\\.")}["'\`]`).test(src));
    expect(missing).toEqual([]);
  });

  it("only references declared commands in menus", () => {
    const declared = new Set((pkg.contributes.commands as { command: string }[]).map((c) => c.command));
    const menus = Object.values(pkg.contributes.menus as Record<string, { command: string }[]>).flat();
    expect(menus.map((m) => m.command).filter((c) => !declared.has(c))).toEqual([]);
  });

  it("registers the debug type and MCP provider ids it contributes", () => {
    expect(src).toMatch(/registerDebugConfigurationProvider\(\s*DEBUG_TYPE|registerDebugConfigurationProvider\(\s*["']localdesktop["']/);
    expect(src).toContain('"localdesktop.mcp"');
  });
});

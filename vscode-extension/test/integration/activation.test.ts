import * as assert from "node:assert";
import * as vscode from "vscode";

const EXTENSION_ID = "mister-teddy.localdesktop-dev";

suite("Local Desktop Dev", () => {
  suiteSetup(async function () {
    this.timeout(60_000);
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, "extension is installed in the test host");
    await ext.activate();
  });

  test("registers every contributed command", async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID)!;
    const contributed: { command: string }[] = ext.packageJSON.contributes.commands;
    const registered = new Set(await vscode.commands.getCommands(true));
    const missing = contributed.map((c) => c.command).filter((c) => !registered.has(c));
    assert.deepStrictEqual(missing, []);
  });

  test("provides a dynamic Local Desktop debug configuration", async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID)!;
    const debuggers: { type: string; initialConfigurations: { request: string }[] }[] = ext.packageJSON.contributes.debuggers;
    assert.strictEqual(debuggers[0]!.type, "localdesktop");
    assert.deepStrictEqual(
      debuggers[0]!.initialConfigurations.map((c) => c.request),
      ["launch", "attach"],
    );
  });

  test("finds the repository and its package name", async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID)!;
    const services = ext.exports as { root?: string; app(): { packageName: string } };
    assert.ok(services.root, "workspace root detected");
    assert.match(services.app().packageName, /^(app\.polarbear|io\.github\.localdesktop)$/);
  });
});

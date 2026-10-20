// Shared by the committed launchers: finds dist/<entry>.js in this checkout or in an installed copy
// of the extension, so `.mcp.json` works right after `git clone` once the extension is installed.
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const EXTENSION_ID = "mister-teddy.localdesktop-dev";
const EDITOR_DIRS = [".vscode", ".vscode-insiders", ".cursor", ".windsurf", ".vscode-oss", ".vscode-server", ".cursor-server", ".vscode-server-insiders"];

function versionKey(dirName) {
  const m = /-(\d+)\.(\d+)\.(\d+)/.exec(dirName);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

function newest(a, b) {
  const ka = versionKey(a);
  const kb = versionKey(b);
  for (let i = 0; i < 3; i++) if (ka[i] !== kb[i]) return ka[i] > kb[i] ? a : b;
  return a;
}

function resolveEntry(entry, envVar) {
  const fromEnv = process.env[envVar];
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const local = path.join(__dirname, "..", "dist", `${entry}.js`);
  if (fs.existsSync(local)) return local;
  let best;
  for (const dir of EDITOR_DIRS) {
    const extensions = path.join(os.homedir(), dir, "extensions");
    let names = [];
    try {
      names = fs.readdirSync(extensions).filter((n) => n.toLowerCase().startsWith(EXTENSION_ID + "-"));
    } catch {
      continue;
    }
    for (const name of names) {
      const candidate = path.join(extensions, name, "dist", `${entry}.js`);
      if (fs.existsSync(candidate) && (!best || newest(name, best.name) === name)) best = { name, candidate };
    }
  }
  return best && best.candidate;
}

function run(entry, envVar) {
  const target = resolveEntry(entry, envVar);
  if (!target) {
    process.stderr.write(
      `Local Desktop ${entry}: no build found.\n` +
        `Install the "Local Desktop Dev" extension (${EXTENSION_ID}), or build it here:\n` +
        `  pnpm -C vscode-extension install && pnpm -C vscode-extension run build\n`,
    );
    process.exit(1);
  }
  // Default the repo root to the checkout this launcher lives in. Run from an installed copy of the
  // extension there is no checkout around it, so the server falls back to its working directory.
  const checkout = path.resolve(__dirname, "..", "..");
  const inCheckout = fs.existsSync(path.join(checkout, "manifest.yaml")) && fs.existsSync(path.join(checkout, "Cargo.toml"));
  if (!process.env.LOCALDESKTOP_ROOT && inCheckout) process.env.LOCALDESKTOP_ROOT = checkout;
  require(target);
}

module.exports = { run, resolveEntry };

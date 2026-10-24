// Bundles the extension host, MCP server, CLI (node/cjs) and the chat webview (browser/iife).
import * as esbuild from "esbuild";
import { readFileSync, rmSync } from "node:fs";

const watch = process.argv.includes("--watch");
const production = process.argv.includes("--production");

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

// Stale source maps from dev builds must not end up in the published VSIX.
if (production) rmSync(new URL("./dist", import.meta.url), { recursive: true, force: true });

const common = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  logLevel: "info",
};

const node = {
  ...common,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode"],
  // libsodium-wrappers' ESM build imports a sibling .mjs that esbuild can't resolve; prefer CJS.
  mainFields: ["main", "module"],
  define: { __VERSION__: JSON.stringify(version) },
};

const builds = [
  { ...node, entryPoints: { extension: "src/extension/extension.ts" }, outdir: "dist" },
  { ...node, entryPoints: { mcp: "src/mcp/main.ts" }, outdir: "dist" },
  { ...node, entryPoints: { cli: "src/cli/main.ts" }, outdir: "dist", banner: { js: "#!/usr/bin/env node" } },
  {
    ...common,
    platform: "browser",
    format: "iife",
    target: "es2022",
    entryPoints: { webview: "src/webview/chat/main.ts" },
    outdir: "dist",
  },
];

if (process.argv.includes("--tests")) {
  const { globSync } = await import("node:fs");
  await esbuild.build({
    ...node,
    entryPoints: globSync("test/integration/**/*.test.ts"),
    outdir: "dist-test/integration",
    outbase: "test/integration",
  });
  process.exit(0);
}

if (watch) {
  const contexts = await Promise.all(builds.map((b) => esbuild.context(b)));
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}

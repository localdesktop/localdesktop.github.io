import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { createCoreContext } from "../core/context";
import { toolPathsFromEnv } from "../core/env";
import { errorMessage } from "../core/errors";
import { TOOLS, findTool } from "../core/tools";
import { timestampName } from "../core/screen";
import { parseArgs } from "./args";

/**
 * `localdesktop <tool> [--arg value …] [--json]` — the MCP tools for agents that prefer a shell.
 * Flags map to tool inputs (camelCase or kebab-case); arrays repeat the flag; `--serial` picks a device.
 */
function usage(): string {
  const lines = ["Usage: localdesktop <command> [--option value …] [--json] [--root <repo>]", "", "Commands:"];
  for (const t of TOOLS) {
    const opts = Object.keys(t.input)
      .map((k) => `--${k}`)
      .join(" ");
    lines.push(`  ${t.name.padEnd(14)} ${t.description.split(". ")[0]}${opts ? `\n  ${"".padEnd(14)} ${opts}` : ""}`);
  }
  lines.push("", "Examples:", "  localdesktop logcat --since launch --level W", "  localdesktop screenshot", "  localdesktop tap --x 640 --y 360", '  localdesktop press_key --key ctrl+alt+t', "  localdesktop audio_record --seconds 5 --json");
  return lines.join("\n");
}

async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  if (!name || name === "help" || name === "--help" || name === "-h") {
    process.stdout.write(usage() + "\n");
    return name ? 0 : 1;
  }
  const t = findTool(name.replace(/-/g, "_"));
  if (!t) {
    process.stderr.write(`Unknown command "${name}".\n\n${usage()}\n`);
    return 2;
  }
  const { args, json, root } = parseArgs(rest, t.input);
  const check = z.object(t.input).safeParse(args);
  if (!check.success) {
    process.stderr.write(`${z.prettifyError(check.error)}\n\nRun \`localdesktop help\` for options.\n`);
    return 2;
  }
  const parsed = check.data;
  const core = createCoreContext({ cwd: process.cwd(), root: root ?? process.env.LOCALDESKTOP_ROOT ?? undefined, paths: toolPathsFromEnv() });
  const result = await t.run(parsed as never, { core, progress: (m) => process.stderr.write(`… ${m}\n`) });

  // Binary results (screenshot image, audio) go to files so a shell agent can open them.
  let imageFile: string | undefined;
  if (result.image) {
    const dir = path.join(core.root, ".localdesktop", "screenshots");
    fs.mkdirSync(dir, { recursive: true });
    imageFile = path.join(dir, timestampName("agent", result.image.mimeType === "image/png" ? "png" : "jpg"));
    fs.writeFileSync(imageFile, result.image.data);
  }
  if (json) {
    process.stdout.write(JSON.stringify({ text: result.text, ...result.structured, ...(imageFile ? { image: imageFile } : {}) }, null, 2) + "\n");
  } else {
    process.stdout.write(result.text + "\n");
    if (imageFile) process.stdout.write(`image: ${imageFile}\n`);
  }
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`${errorMessage(e)}\n`);
    process.exit(1);
  },
);

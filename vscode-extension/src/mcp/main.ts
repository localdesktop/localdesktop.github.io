import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCoreContext, type CoreContext } from "../core/context";
import { toolPathsFromEnv } from "../core/env";
import { errorMessage } from "../core/errors";
import { TOOLS, type ToolResult } from "../core/tools";

declare const __VERSION__: string | undefined;

/** The parts of the SDK's RequestHandlerExtra we use. */
interface ToolExtra {
  signal: AbortSignal;
  _meta?: { progressToken?: string | number };
  sendNotification(notification: { method: "notifications/progress"; params: { progressToken: string | number; progress: number; message?: string } }): Promise<void>;
}

type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "audio"; data: string; mimeType: string };

function toContent(r: ToolResult): Content[] {
  const content: Content[] = [{ type: "text", text: r.text }];
  if (r.image) content.push({ type: "image", data: r.image.data.toString("base64"), mimeType: r.image.mimeType });
  if (r.audio) content.push({ type: "audio", data: r.audio.data.toString("base64"), mimeType: r.audio.mimeType });
  return content;
}

/**
 * Local Desktop device tools for coding agents (Claude Code, Codex, Copilot, Cursor) over stdio.
 * The repo root comes from LOCALDESKTOP_ROOT or the working directory.
 */
async function main(): Promise<void> {
  const server = new McpServer(
    { name: "localdesktop", version: typeof __VERSION__ === "string" ? __VERSION__ : "0.0.0" },
    {
      instructions:
        "Tools for the Local Desktop Android app (a Linux desktop running on Android). Typical loop: `screenshot` → decide → `tap`/`type_text`/`press_key` → `screenshot`. " +
        "Use `logcat` (since=launch) and `crash_report` to debug, `audio_status`/`audio_record` to check sound, and `build_apk` + `install_apk` + `app_start` to deploy. " +
        "Tap coordinates default to the last screenshot's pixel space.",
    },
  );

  let core: CoreContext | undefined;
  const getCore = () =>
    (core ??= createCoreContext({ cwd: process.env.LOCALDESKTOP_ROOT || process.cwd(), root: process.env.LOCALDESKTOP_ROOT || undefined, paths: toolPathsFromEnv() }));

  for (const t of TOOLS) {
    server.registerTool(
      t.name,
      { title: t.title, description: t.description, inputSchema: t.input, annotations: t.annotations },
      async (args: Record<string, unknown>, extra: ToolExtra) => {
        try {
          const token = extra._meta?.progressToken;
          let step = 0;
          const result = await t.run(args as never, {
            core: getCore(),
            signal: extra.signal,
            progress: (message) => {
              if (token === undefined) return;
              void extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: ++step, message } });
            },
          });
          return { content: toContent(result), structuredContent: result.structured };
        } catch (e) {
          return { content: [{ type: "text" as const, text: errorMessage(e) }], isError: true };
        }
      },
    );
  }

  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  process.stderr.write(`localdesktop MCP server failed: ${errorMessage(e)}\n`);
  process.exit(1);
});

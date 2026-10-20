import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Adb } from "../../src/core/adb/adb";
import { deployLldbServer, md5File, PlatformServer } from "../../src/core/debug/lldbServer";

const FAKE_ADB = path.resolve(__dirname, "../fake-adb/adb.mjs");
const PKG = "io.github.localdesktop";

let dir: string;
let logFile: string;
let localServer: string;

function calls(): string[][] {
  return fs
    .readFileSync(logFile, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as string[]);
}

beforeEach(() => {
  fs.chmodSync(FAKE_ADB, 0o755);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ld-fake-adb-"));
  logFile = path.join(dir, "calls.jsonl");
  fs.writeFileSync(logFile, "");
  localServer = path.join(dir, "lldb-server");
  fs.writeFileSync(localServer, "fake lldb-server binary");
  process.env.FAKE_ADB_LOG = logFile;
  delete process.env.FAKE_ADB_MD5;
});

afterEach(() => {
  delete process.env.FAKE_ADB_LOG;
  delete process.env.FAKE_ADB_MD5;
});

describe("lldb-server against a fake adb", () => {
  const adb = new Adb(FAKE_ADB, "R58M12345ABC");

  it("copies lldb-server into the sandbox through /data/local/tmp", async () => {
    expect(await deployLldbServer(adb, PKG, localServer)).toBe("copied");
    const shell = calls().map((c) => c.slice(2));
    expect(shell[0]).toEqual(["shell", `run-as ${PKG} sh -c 'md5sum lldb/bin/lldb-server 2>/dev/null'`]);
    expect(shell[1]).toEqual(["push", localServer, "/data/local/tmp/ld-lldb-server"]);
    expect(shell[2]).toEqual([
      "shell",
      `cat /data/local/tmp/ld-lldb-server | run-as ${PKG} sh -c 'mkdir -p lldb/bin && cat > lldb/bin/lldb-server && chmod 700 lldb/bin/lldb-server'`,
    ]);
    expect(shell[3]).toEqual(["shell", "rm -f /data/local/tmp/ld-lldb-server"]);
    expect(calls().every((c) => c[0] === "-s" && c[1] === "R58M12345ABC")).toBe(true);
  });

  it("skips the copy when the device already has the same binary", async () => {
    process.env.FAKE_ADB_MD5 = md5File(localServer);
    expect(await deployLldbServer(adb, PKG, localServer)).toBe("unchanged");
    expect(calls()).toHaveLength(1);
  });

  it("starts the platform server and waits for its abstract socket", async () => {
    const server = await PlatformServer.start(adb, PKG, { timeoutMs: 5000 });
    expect(server.socket.path).toMatch(new RegExp(`^/${PKG.replace(/\./g, "\\.")}-[0-9a-f]{8}/platform\\.sock$`));
    const platformCall = calls().find((c) => c.join(" ").includes("lldb-server platform"));
    expect(platformCall?.[3]).toBe(
      `run-as ${PKG} sh -c 'cd lldb && LLDB_DEBUGSERVER_DOMAINSOCKET_DIR=${server.socket.dir} exec ./bin/lldb-server platform --listen unix-abstract://${server.socket.path}'`,
    );
    expect(server.hasExited).toBe(false);
    await server.stop();
    expect(calls().at(-1)?.slice(2)).toEqual(["shell", `run-as ${PKG} sh -c 'pkill -f bin/lldb-server; true'`]);
  });
});

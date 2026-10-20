#!/usr/bin/env node
// A scripted stand-in for adb: records argv (one JSON line per call) in $FAKE_ADB_LOG and answers
// the commands the debug flow uses. Long-running `lldb-server platform` calls block until killed.
/* global process, setInterval */
import * as fs from "node:fs";

const log = process.env.FAKE_ADB_LOG;
const args = process.argv.slice(2);
if (log) fs.appendFileSync(log, JSON.stringify(args) + "\n");

const rest = args[0] === "-s" ? args.slice(2) : args;
const [cmd, ...more] = rest;
const line = more.join(" ");

function previousCalls() {
  return log ? fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
}

switch (cmd) {
  case "push":
    process.stdout.write(`${more[0]}: 1 file pushed, 0 skipped.\n`);
    break;
  case "forward":
    process.stdout.write("43561\n");
    break;
  case "shell":
    if (line.includes("md5sum")) {
      process.stdout.write(process.env.FAKE_ADB_MD5 ? `${process.env.FAKE_ADB_MD5}  lldb/bin/lldb-server\n` : "");
    } else if (line.includes("lldb-server platform")) {
      setInterval(() => undefined, 1000); // serve until killed
    } else if (line.includes("/proc/net/unix")) {
      const listen = previousCalls()
        .map((a) => a.join(" "))
        .map((l) => /unix-abstract:\/\/(\S+?)'?$/.exec(l) ?? /unix-abstract:\/\/(\S+)/.exec(l))
        .filter(Boolean)
        .pop();
      process.stdout.write("Num       RefCount Protocol Flags    Type St Inode Path\n");
      if (listen) process.stdout.write(`0000000000000000: 00000002 00000000 00010000 0001 01 1 @${listen[1].replace(/'$/, "")}\n`);
    }
    break;
  default:
    break;
}

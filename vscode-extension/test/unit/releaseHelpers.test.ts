import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { checkDigest, formatBytes, isUnzippedArtifact } from "../../src/release/artifacts";
import { detectConflict, draftFromCommits, hashText } from "../../src/release/notes";
import { playRunFor, relativeTime } from "../../src/release/runs";
import type { WorkflowRun } from "../../src/release/types";
import { extractZipEntry } from "../../src/release/zip";

/** Builds a minimal zip with one deflated entry (what actions/upload-artifact produces). */
function makeZip(name: string, data: Buffer, method: 0 | 8 = 8): Buffer {
  const nameBuf = Buffer.from(name);
  const body = method === 8 ? deflateRawSync(data) : data;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42);
  const cdOffset = local.length + nameBuf.length + body.length;
  const cd = Buffer.concat([central, nameBuf]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, nameBuf, body, cd, eocd]);
}

describe("artifact digests", () => {
  const sha = createHash("sha256").update("apk").digest("hex");
  it("verifies sha256 digests", () => {
    expect(checkDigest(`sha256:${sha}`, sha)).toBe("verified");
    expect(checkDigest(`sha256:${sha.toUpperCase()}`, sha)).toBe("verified");
    expect(checkDigest(`sha256:${"0".repeat(64)}`, sha)).toBe("mismatch");
    expect(checkDigest(null, sha)).toBe("unverified");
    expect(checkDigest("md5:abc", sha)).toBe("unverified");
  });
  it("recognizes unzipped artifacts by name", () => {
    expect(isUnzippedArtifact("localdesktop-2.1.1-main-abc1234-release.apk")).toBe(true);
    expect(isUnzippedArtifact("localdesktop-2.1.1-fix-991e6de-release-apk")).toBe(false);
  });
  it("formats sizes", () => {
    expect(formatBytes(7954741)).toBe("7.6 MB");
    expect(formatBytes(512)).toBe("512 B");
  });
});

describe("zip extraction", () => {
  it("extracts deflated and stored entries", () => {
    const data = Buffer.from("PK fake apk content ".repeat(50));
    expect(extractZipEntry(makeZip("x-release.apk", data), (n) => n.endsWith(".apk"))?.data.equals(data)).toBe(true);
    expect(extractZipEntry(makeZip("x.apk", data, 0), (n) => n.endsWith(".apk"))?.data.equals(data)).toBe(true);
    expect(extractZipEntry(makeZip("notes.txt", data), (n) => n.endsWith(".apk"))).toBeUndefined();
  });
  it("rejects non-zips", () => {
    expect(() => extractZipEntry(Buffer.alloc(100), () => true)).toThrow(/Not a zip/);
  });
});

describe("release notes editing", () => {
  const a = { updatedAt: "2026-10-20T10:00:00Z", bodyHash: hashText("one") };
  it("ignores unrelated updates (labels) and flags body changes", () => {
    expect(detectConflict(a, a)).toBe(false);
    expect(detectConflict(a, { updatedAt: "2026-10-20T11:00:00Z", bodyHash: hashText("one") })).toBe(false);
    expect(detectConflict(a, { updatedAt: "2026-10-20T11:00:00Z", bodyHash: hashText("two") })).toBe(true);
    expect(detectConflict(undefined, a)).toBe(false);
  });
  it("compares bodies for releases (no updated_at)", () => {
    expect(detectConflict({ updatedAt: "", bodyHash: hashText("x") }, { updatedAt: "", bodyHash: hashText("y") })).toBe(true);
    expect(detectConflict({ updatedAt: "", bodyHash: hashText("x") }, { updatedAt: "", bodyHash: hashText("x\r\n".trimEnd()) })).toBe(false);
  });
  it("drafts notes from commit subjects", () => {
    expect(
      draftFromCommits(["fix: touch scaling\n\nbody", "chore: set version to v2.1.2", "Merge branch 'main' into x", "fix: touch scaling", "feat: shortcuts"], "v2.1.1"),
    ).toBe("## What's changed since v2.1.1\n\n- fix: touch scaling\n- feat: shortcuts\n");
  });
});

describe("runs", () => {
  const run = (over: Partial<WorkflowRun>): WorkflowRun => ({
    id: 1,
    display_title: "",
    event: "release",
    status: "completed",
    conclusion: "failure",
    head_branch: null,
    head_sha: "abc",
    path: ".github/workflows/google-play-console.yml",
    run_number: 1,
    html_url: "",
    created_at: "",
    updated_at: "",
    ...over,
  });
  it("matches Play runs to releases", () => {
    const rel = { tag_name: "v2.1.1", name: "Local Desktop v2.1.1" };
    expect(playRunFor(rel, [run({ id: 2, head_branch: "v2.1.0" }), run({ id: 3, head_branch: "v2.1.1" })])?.id).toBe(3);
    expect(playRunFor(rel, [run({ id: 4, event: "workflow_dispatch", display_title: "Upload v2.1.1 to Google Play" })])?.id).toBe(4);
    expect(playRunFor(rel, [run({ id: 5, event: "workflow_dispatch", display_title: "Upload latest release to Google Play" })])).toBeUndefined();
  });
  it("formats relative times", () => {
    const now = Date.parse("2026-10-20T12:00:00Z");
    expect(relativeTime("2026-10-20T11:59:30Z", now)).toBe("just now");
    expect(relativeTime("2026-10-20T11:30:00Z", now)).toBe("30 min ago");
    expect(relativeTime("2026-10-20T10:00:00Z", now)).toBe("2 h ago");
    expect(relativeTime("2026-08-11T21:12:02Z", now)).toBe("2 mo ago");
    expect(relativeTime("2026-10-01T12:00:00Z", now)).toBe("19 days ago");
  });
});

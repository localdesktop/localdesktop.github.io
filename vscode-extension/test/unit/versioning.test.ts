import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  bump,
  cargoVersion,
  formatVersion,
  highestTag,
  nextLabels,
  parseVersion,
  predictVersion,
  RELEASE_LABELS,
  releaseLabelsOf,
} from "../../src/release/versioning";

const REPO = path.resolve(__dirname, "../../..");

function workflowStepScripts(file: string): string[] {
  const doc = parseYaml(fs.readFileSync(path.join(REPO, ".github", "workflows", file), "utf8")) as {
    jobs: Record<string, { steps?: { run?: string; with?: { script?: string } }[] }>;
  };
  return Object.values(doc.jobs).flatMap((job) => (job.steps ?? []).map((s) => s.run ?? s.with?.script ?? ""));
}

describe("versioning", () => {
  it("parses versions like the workflow", () => {
    expect(parseVersion("v2.1.1")).toEqual({ major: 2, minor: 1, patch: 1 });
    expect(parseVersion(" 3.0.0 ")).toEqual({ major: 3, minor: 0, patch: 0 });
    expect(parseVersion("v2.1")).toBeUndefined();
    expect(parseVersion("extension-v0.1.0")).toBeUndefined();
  });

  it("bumps", () => {
    const v = { major: 2, minor: 1, patch: 1 };
    expect(formatVersion(bump(v, "major"))).toBe("3.0.0");
    expect(formatVersion(bump(v, "minor"))).toBe("2.2.0");
    expect(formatVersion(bump(v, "patch"))).toBe("2.1.2");
    expect(formatVersion(bump(v, ""))).toBe("2.1.1");
  });

  it("ignores non-app tags when finding the highest tag", () => {
    expect(formatVersion(highestTag(["v2.0.1", "v2.1.1", "v2.1.0", "extension-v9.9.9", "v10"])!)).toBe("2.1.1");
    expect(highestTag(["extension-v0.1.0"])).toBeUndefined();
  });

  it("predicts bump(max(main, latest tag), level)", () => {
    const main = { major: 2, minor: 1, patch: 1 };
    expect(formatVersion(predictVersion(main, ["v2.1.1"], "release:bugfix")!)).toBe("2.1.2");
    expect(formatVersion(predictVersion(main, ["v2.2.0"], "release:feature")!)).toBe("2.3.0");
    expect(formatVersion(predictVersion({ major: 3, minor: 0, patch: 0 }, ["v2.9.9"], "release:breaking")!)).toBe("4.0.0");
    expect(predictVersion(main, ["v2.1.1"], "release:docs")).toBeUndefined();
    expect(predictVersion(main, [], "bug")).toBeUndefined();
  });

  it("reads the Cargo.toml version (first match)", () => {
    expect(formatVersion(cargoVersion(fs.readFileSync(path.join(REPO, "Cargo.toml"), "utf8"))!)).toMatch(/^\d+\.\d+\.\d+$/);
    expect(cargoVersion('[package]\nname = "x"\nversion = "1.2.3"\n[dependencies]\nfoo = { version = "9.9.9" }\n')).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  it("finds release labels and replaces them while keeping others", () => {
    expect(releaseLabelsOf(["bug", "release:feature"])).toEqual(["release:feature"]);
    expect(nextLabels(["good first issue", "release:bugfix", "release:docs"], "release:feature")).toEqual(["good first issue", "release:feature"]);
  });

  it("matches the label map in auto-bump-version.yml", () => {
    const script = workflowStepScripts("auto-bump-version.yml").find((s) => s.includes("release_labels = {"));
    expect(script).toBeDefined();
    const dict = /release_labels = \{([\s\S]*?)\}/.exec(script!)![1]!;
    const fromYaml = Object.fromEntries([...dict.matchAll(/'([^']+)':\s*'([^']*)'/g)].map((m) => [m[1], m[2]]));
    expect(fromYaml).toEqual(RELEASE_LABELS);
  });

  it("matches the app label set in build.yml", () => {
    const script = workflowStepScripts("build.yml").find((s) => s.includes("appReleaseLabels"))!;
    const app = /appReleaseLabels = new Set\(\[([\s\S]*?)\]\)/.exec(script)![1]!;
    const labels = [...app.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(labels.sort()).toEqual(Object.keys(RELEASE_LABELS).filter((l) => RELEASE_LABELS[l] !== "").sort());
  });
});

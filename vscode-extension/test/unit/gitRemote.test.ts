import { describe, expect, it } from "vitest";
import { parseGitHubRemote } from "../../src/core/gitRemote";

describe("parseGitHubRemote", () => {
  it("reads https, ssh and scp-style GitHub remotes", () => {
    expect(parseGitHubRemote("https://github.com/localdesktop/elementary-mobile.git")).toBe("localdesktop/elementary-mobile");
    expect(parseGitHubRemote("https://github.com/localdesktop/localdesktop.github.io")).toBe("localdesktop/localdesktop.github.io");
    expect(parseGitHubRemote("git@github.com:localdesktop/localdesktop.git\n")).toBe("localdesktop/localdesktop");
    expect(parseGitHubRemote("ssh://git@github.com/FBarrca/localdesktop.github.io.git")).toBe("FBarrca/localdesktop.github.io");
    expect(parseGitHubRemote("https://token@github.com/a/b.git/")).toBe("a/b");
  });
  it("ignores other hosts", () => {
    expect(parseGitHubRemote("https://gitlab.com/a/b.git")).toBeUndefined();
    expect(parseGitHubRemote("/local/path/repo")).toBeUndefined();
  });
});

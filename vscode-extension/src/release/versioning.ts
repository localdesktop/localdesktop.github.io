/**
 * TypeScript port of the version logic in .github/workflows/auto-bump-version.yml, so the sidebar can
 * show what version a PR will release before the bot pushes its bump commit.
 * Keep RELEASE_LABELS in sync with the workflow (a unit test checks it).
 */

export type BumpLevel = "major" | "minor" | "patch" | "";

export const RELEASE_LABELS: Readonly<Record<string, BumpLevel>> = {
  "release:breaking": "major",
  "release:feature": "minor",
  "release:bugfix": "patch",
  "release:patch": "patch",
  "release:improvement": "patch",
  "release:optimisation": "patch",
  "release:docs": "",
};

export const LABEL_DESCRIPTIONS: Readonly<Record<string, string>> = {
  "release:breaking": "Breaking change",
  "release:feature": "New feature",
  "release:bugfix": "Bug fix",
  "release:patch": "Patch",
  "release:improvement": "Improvement",
  "release:optimisation": "Optimisation",
  "release:docs": "Docs only — no app release",
};

export interface Version {
  major: number;
  minor: number;
  patch: number;
}

/** Same as the workflow's `re.fullmatch(r'v?(\d+)\.(\d+)\.(\d+)', raw.strip())`. */
export function parseVersion(raw: string): Version | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(raw.trim());
  if (!m) return undefined;
  return { major: parseInt(m[1]!, 10), minor: parseInt(m[2]!, 10), patch: parseInt(m[3]!, 10) };
}

export function formatVersion(v: Version): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

export function compareVersion(a: Version, b: Version): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export function bump(v: Version, level: BumpLevel): Version {
  switch (level) {
    case "major":
      return { major: v.major + 1, minor: 0, patch: 0 };
    case "minor":
      return { major: v.major, minor: v.minor + 1, patch: 0 };
    case "patch":
      return { major: v.major, minor: v.minor, patch: v.patch + 1 };
    default:
      return v;
  }
}

/** `version = "x.y.z"` from a Cargo.toml (first match, like the workflow's regex). */
export function cargoVersion(cargoToml: string): Version | undefined {
  const m = /^version\s*=\s*"(\d+)\.(\d+)\.(\d+)"/m.exec(cargoToml);
  if (!m) return undefined;
  return { major: parseInt(m[1]!, 10), minor: parseInt(m[2]!, 10), patch: parseInt(m[3]!, 10) };
}

/** Highest app release tag (`v1.2.3`); other tags such as `extension-v0.1.0` are ignored. */
export function highestTag(tags: readonly string[]): Version | undefined {
  let best: Version | undefined;
  for (const tag of tags) {
    if (!/^v\d+\.\d+\.\d+$/.test(tag)) continue;
    const v = parseVersion(tag)!;
    if (!best || compareVersion(v, best) > 0) best = v;
  }
  return best;
}

/** The release labels present on a PR (the workflow requires exactly one). */
export function releaseLabelsOf(labels: readonly string[]): string[] {
  return Object.keys(RELEASE_LABELS).filter((l) => labels.includes(l));
}

/**
 * Version the PR will be released as: bump(max(main Cargo.toml, highest v*.*.* tag), level).
 * `release:docs` (level "") releases nothing, so this returns undefined.
 */
export function predictVersion(mainVersion: Version, tags: readonly string[], label: string): Version | undefined {
  const level = RELEASE_LABELS[label];
  if (level === undefined || level === "") return undefined;
  const latest = highestTag(tags);
  const base = latest && compareVersion(latest, mainVersion) > 0 ? latest : mainVersion;
  return bump(base, level);
}

export function isAppReleaseTag(tag: string): boolean {
  return /^v\d+\.\d+\.\d+$/.test(tag);
}

/** Current labels minus every release:* label, plus the chosen one (order preserved). */
export function nextLabels(current: readonly string[], chosen: string): string[] {
  return [...current.filter((l) => !(l in RELEASE_LABELS)), chosen];
}

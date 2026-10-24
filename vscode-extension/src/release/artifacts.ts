import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { LdError } from "../core/errors";
import type { Artifact, ReleaseAsset } from "./types";
import { extractZipEntry } from "./zip";

/**
 * `digest` fields look like "sha256:<hex>". Returns "verified", "mismatch" or "unverified" (no
 * digest published, e.g. artifacts uploaded before GitHub added digests).
 */
export function checkDigest(expected: string | null | undefined, actualSha256Hex: string): "verified" | "mismatch" | "unverified" {
  if (!expected) return "unverified";
  const m = /^sha256:([0-9a-f]{64})$/i.exec(expected.trim());
  if (!m) return "unverified";
  return m[1]!.toLowerCase() === actualSha256Hex.toLowerCase() ? "verified" : "mismatch";
}

/** Artifacts uploaded with `archive: false` are named after the file itself and download unzipped. */
export function isUnzippedArtifact(name: string): boolean {
  return /\.(apk|aab|vsix)$/i.test(name);
}

export function sha256Of(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

interface DownloadOptions {
  token: string;
  destDir: string;
  fileName: string;
  expectedDigest?: string | null;
  expectedSize?: number;
  onProgress?: (received: number, total?: number) => void;
  signal?: AbortSignal;
}

const API_HEADERS = { "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "localdesktop-vscode" };

/**
 * Follows GitHub's 302 to the storage URL by hand: the signed blob URL must be fetched WITHOUT the
 * Authorization header (it's only valid for a minute and rejects extra credentials).
 */
async function fetchViaRedirect(apiUrl: string, accept: string, token: string, signal?: AbortSignal): Promise<Response> {
  const first = await fetch(apiUrl, {
    headers: { ...API_HEADERS, Accept: accept, Authorization: `Bearer ${token}` },
    redirect: "manual",
    signal,
  });
  if (first.status >= 300 && first.status < 400) {
    const location = first.headers.get("location");
    if (!location) throw new LdError("COMMAND_FAILED", `GitHub redirected without a location (${apiUrl})`);
    const blob = await fetch(location, { headers: { "User-Agent": API_HEADERS["User-Agent"] }, signal });
    if (!blob.ok) throw new LdError("COMMAND_FAILED", `Download failed: HTTP ${blob.status}`);
    return blob;
  }
  if (first.status === 410) throw new LdError("COMMAND_FAILED", "This artifact has expired.", "Rebuild it with “Build APK on CI”.");
  if (!first.ok) throw new LdError("COMMAND_FAILED", `Download failed: HTTP ${first.status} ${await first.text().catch(() => "")}`.trim());
  return first;
}

/** Streams a response to disk while hashing it; returns the file path and sha256. */
async function saveResponse(res: Response, opts: DownloadOptions): Promise<{ file: string; sha256: string }> {
  fs.mkdirSync(opts.destDir, { recursive: true });
  const file = path.join(opts.destDir, opts.fileName);
  const tmp = `${file}.part`;
  const hash = createHash("sha256");
  const out = fs.createWriteStream(tmp);
  const total = Number(res.headers.get("content-length")) || opts.expectedSize;
  let received = 0;
  try {
    const reader = res.body!.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      received += value.length;
      opts.onProgress?.(received, total);
      if (!out.write(value)) await new Promise<void>((r) => out.once("drain", () => r()));
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  } catch (e) {
    out.destroy();
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  const sha256 = hash.digest("hex");
  if (checkDigest(opts.expectedDigest, sha256) === "mismatch") {
    fs.rmSync(tmp, { force: true });
    throw new LdError("COMMAND_FAILED", `Checksum mismatch for ${opts.fileName}; the download was discarded.`);
  }
  fs.renameSync(tmp, file);
  return { file, sha256 };
}

function reuseIfPresent(file: string, digest: string | null | undefined): boolean {
  if (!fs.existsSync(file) || !digest) return false;
  return checkDigest(digest, sha256Of(file)) === "verified";
}

/**
 * Downloads a workflow artifact. Unzipped (`archive: false`) artifacts arrive as the file itself;
 * older zipped ones are unwrapped to their first .apk/.aab entry.
 */
export async function downloadArtifact(
  repo: { owner: string; repo: string },
  artifact: Artifact,
  opts: Omit<DownloadOptions, "fileName" | "expectedDigest" | "expectedSize">,
): Promise<string> {
  if (artifact.expired) throw new LdError("COMMAND_FAILED", `Artifact ${artifact.name} has expired.`, "Rebuild it with “Build APK on CI”.");
  const unzipped = isUnzippedArtifact(artifact.name);
  const target = path.join(opts.destDir, unzipped ? artifact.name : `${artifact.name}.zip`);
  if (unzipped && reuseIfPresent(target, artifact.digest)) return target;
  const url = `https://api.github.com/repos/${repo.owner}/${repo.repo}/actions/artifacts/${artifact.id}/zip`;
  const res = await fetchViaRedirect(url, "application/vnd.github+json", opts.token, opts.signal);
  const { file } = await saveResponse(res, {
    ...opts,
    fileName: path.basename(target),
    expectedDigest: artifact.digest,
    expectedSize: artifact.size_in_bytes,
  });
  if (unzipped) return file;
  const entry = extractZipEntry(fs.readFileSync(file), (name) => /\.(apk|aab)$/i.test(name));
  if (!entry) return file;
  const extracted = path.join(opts.destDir, path.basename(entry.name));
  fs.writeFileSync(extracted, entry.data);
  fs.rmSync(file, { force: true });
  return extracted;
}

/** Downloads a release asset through the API URL (works for private repos too). */
export async function downloadReleaseAsset(
  repo: { owner: string; repo: string },
  asset: ReleaseAsset,
  opts: Omit<DownloadOptions, "fileName" | "expectedDigest" | "expectedSize">,
): Promise<string> {
  const target = path.join(opts.destDir, asset.name);
  if (reuseIfPresent(target, asset.digest)) return target;
  const url = asset.url || `https://api.github.com/repos/${repo.owner}/${repo.repo}/releases/assets/${asset.id}`;
  const res = await fetchViaRedirect(url, "application/octet-stream", opts.token, opts.signal);
  const { file } = await saveResponse(res, { ...opts, fileName: asset.name, expectedDigest: asset.digest, expectedSize: asset.size });
  return file;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

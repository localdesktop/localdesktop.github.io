import { inflateRawSync } from "node:zlib";

export interface ZipEntry {
  name: string;
  data: Buffer;
}

/**
 * Extracts the first entry matching `predicate` from a zip archive held in memory. Older CI
 * artifacts (uploaded before `archive: false`) arrive zipped; this unwraps the APK inside.
 * Supports stored and deflated entries, which is all actions/upload-artifact produces.
 */
export function extractZipEntry(zip: Buffer, predicate: (name: string) => boolean): ZipEntry | undefined {
  // End of central directory: signature 0x06054b50, searched backwards (comment ≤ 64 KiB).
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a zip archive (no end of central directory)");
  const entries = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < entries; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error("Corrupt zip central directory");
    const method = zip.readUInt16LE(p + 10);
    const compressedSize = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const localOffset = zip.readUInt32LE(p + 42);
    const name = zip.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (!predicate(name)) continue;
    if (zip.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("Corrupt zip local header");
    const localNameLen = zip.readUInt16LE(localOffset + 26);
    const localExtraLen = zip.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    const raw = zip.subarray(start, start + compressedSize);
    if (method === 0) return { name, data: Buffer.from(raw) };
    if (method === 8) return { name, data: inflateRawSync(raw) };
    throw new Error(`Unsupported zip compression method ${method}`);
  }
  return undefined;
}

import * as fs from "node:fs";

export interface ElfInfo {
  /** Has a .debug_info (or compressed .zdebug_info) section: breakpoints can bind. */
  hasDebugInfo: boolean;
  /** Hex GNU build-id, when the linker emitted one (lets LLDB match files by UUID). */
  buildId?: string;
}

type Reader = (offset: number, length: number) => Buffer;

const SHT_NOTE = 7;
const NT_GNU_BUILD_ID = 3;

/** Inspects a 64-bit little-endian ELF (aarch64 Android libraries) through a random-access reader. */
export function inspectElfWith(read: Reader, size: number): ElfInfo | undefined {
  if (size < 64) return undefined;
  const header = read(0, 64);
  if (header.readUInt32BE(0) !== 0x7f454c46) return undefined; // "\x7fELF"
  if (header[4] !== 2 || header[5] !== 1) return undefined; // ELFCLASS64, little-endian only
  const shoff = Number(header.readBigUInt64LE(0x28));
  const shentsize = header.readUInt16LE(0x3a);
  const shnum = header.readUInt16LE(0x3c);
  const shstrndx = header.readUInt16LE(0x3e);
  if (!shoff || shentsize < 64 || !shnum || shstrndx >= shnum || shoff + shnum * shentsize > size) return undefined;

  const table = read(shoff, shnum * shentsize);
  const section = (i: number) => {
    const o = i * shentsize;
    return {
      name: table.readUInt32LE(o),
      type: table.readUInt32LE(o + 4),
      offset: Number(table.readBigUInt64LE(o + 0x18)),
      size: Number(table.readBigUInt64LE(o + 0x20)),
    };
  };
  const strtab = section(shstrndx);
  if (strtab.offset + strtab.size > size) return undefined;
  const names = read(strtab.offset, strtab.size);
  const nameOf = (off: number) => {
    const end = names.indexOf(0, off);
    return names.toString("latin1", off, end < 0 ? names.length : end);
  };

  const info: ElfInfo = { hasDebugInfo: false };
  for (let i = 0; i < shnum; i++) {
    const s = section(i);
    const name = nameOf(s.name);
    if (name === ".debug_info" || name === ".zdebug_info") info.hasDebugInfo = s.size > 0;
    if (s.type === SHT_NOTE && name === ".note.gnu.build-id" && s.size >= 16 && s.offset + s.size <= size) {
      const note = read(s.offset, s.size);
      const namesz = note.readUInt32LE(0);
      const descsz = note.readUInt32LE(4);
      const type = note.readUInt32LE(8);
      const descOff = 12 + Math.ceil(namesz / 4) * 4;
      if (type === NT_GNU_BUILD_ID && descOff + descsz <= note.length) info.buildId = note.toString("hex", descOff, descOff + descsz);
    }
  }
  return info;
}

export function inspectElf(buf: Buffer): ElfInfo | undefined {
  return inspectElfWith((offset, length) => buf.subarray(offset, offset + length), buf.length);
}

/** Inspects a file without reading it whole (debug libraries are hundreds of MB). */
export function inspectElfFile(file: string): ElfInfo | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const handle = fd;
    return inspectElfWith((offset, length) => {
      const buf = Buffer.alloc(length);
      fs.readSync(handle, buf, 0, length, offset);
      return buf;
    }, size);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

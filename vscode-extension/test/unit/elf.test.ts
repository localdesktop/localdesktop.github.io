import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { inspectElf, inspectElfFile } from "../../src/core/debug/elf";

interface Section {
  name: string;
  type: number;
  data: Buffer;
}

/** Builds a minimal ELF64 LE file: header, section data, string table, section headers. */
function makeElf(sections: Section[]): Buffer {
  const all: Section[] = [{ name: "", type: 0, data: Buffer.alloc(0) }, ...sections, { name: ".shstrtab", type: 3, data: Buffer.alloc(0) }];
  let strtab = Buffer.from([0]);
  const nameOffsets = all.map((s) => {
    if (!s.name) return 0;
    const off = strtab.length;
    strtab = Buffer.concat([strtab, Buffer.from(s.name + "\0", "latin1")]);
    return off;
  });
  all[all.length - 1]!.data = strtab;

  const chunks: Buffer[] = [];
  let offset = 64;
  const offsets = all.map((s) => {
    const o = offset;
    chunks.push(s.data);
    offset += s.data.length;
    return o;
  });
  const shoff = offset;
  const header = Buffer.alloc(64);
  header.writeUInt32BE(0x7f454c46, 0);
  header[4] = 2; // ELFCLASS64
  header[5] = 1; // little-endian
  header[6] = 1;
  header.writeUInt16LE(3, 16); // ET_DYN
  header.writeUInt16LE(183, 18); // EM_AARCH64
  header.writeBigUInt64LE(BigInt(shoff), 0x28);
  header.writeUInt16LE(64, 0x34);
  header.writeUInt16LE(64, 0x3a);
  header.writeUInt16LE(all.length, 0x3c);
  header.writeUInt16LE(all.length - 1, 0x3e);
  const shdrs = Buffer.alloc(64 * all.length);
  all.forEach((s, i) => {
    const o = i * 64;
    shdrs.writeUInt32LE(nameOffsets[i]!, o);
    shdrs.writeUInt32LE(s.type, o + 4);
    shdrs.writeBigUInt64LE(BigInt(offsets[i]!), o + 0x18);
    shdrs.writeBigUInt64LE(BigInt(s.data.length), o + 0x20);
  });
  return Buffer.concat([header, ...chunks, shdrs]);
}

function buildIdNote(id: Buffer): Buffer {
  const note = Buffer.alloc(16 + id.length);
  note.writeUInt32LE(4, 0);
  note.writeUInt32LE(id.length, 4);
  note.writeUInt32LE(3, 8);
  note.write("GNU\0", 12, "latin1");
  id.copy(note, 16);
  return note;
}

describe("inspectElf", () => {
  it("detects debug info and the GNU build-id", () => {
    const elf = makeElf([
      { name: ".text", type: 1, data: Buffer.alloc(16) },
      { name: ".note.gnu.build-id", type: 7, data: buildIdNote(Buffer.from("0123456789abcdef01234567", "hex")) },
      { name: ".debug_info", type: 1, data: Buffer.alloc(32, 1) },
    ]);
    expect(inspectElf(elf)).toEqual({ hasDebugInfo: true, buildId: "0123456789abcdef01234567" });
  });

  it("reports stripped libraries", () => {
    expect(inspectElf(makeElf([{ name: ".text", type: 1, data: Buffer.alloc(16) }]))).toEqual({ hasDebugInfo: false });
  });

  it("rejects non-ELF and 32-bit files", () => {
    expect(inspectElf(Buffer.from("not an elf file at all, definitely not one, nope nope nope nope nope"))).toBeUndefined();
    const elf32 = makeElf([]);
    elf32[4] = 1;
    expect(inspectElf(elf32)).toBeUndefined();
  });

  it("reads files without loading them whole", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ld-elf-")), "lib.so");
    fs.writeFileSync(file, makeElf([{ name: ".zdebug_info", type: 1, data: Buffer.alloc(8, 1) }]));
    expect(inspectElfFile(file)).toEqual({ hasDebugInfo: true });
    expect(inspectElfFile(path.join(path.dirname(file), "missing.so"))).toBeUndefined();
  });
});

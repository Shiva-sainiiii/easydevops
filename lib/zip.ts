/**
 * Minimal ZIP reader (Python zipfile ke jaisa namelist()/read()) — Node ke built-in zlib se,
 * koi nayi npm dependency nahi (package.json badalna na pade, lock-file sync rahe).
 * Stored (0) aur Deflate (8) entries support; ZIP64 aur encrypted entries nahi.
 */
import { inflateRawSync } from "node:zlib";

export class BadZipFile extends Error {
  constructor(message = "File is not a zip file") {
    super(message);
    this.name = "BadZipFile";
  }
}

interface Entry {
  name: string;
  method: number;
  compSize: number;
  localOffset: number;
  flags: number;
}

function decodeName(buf: Buffer, flags: number): string {
  if (flags & 0x800) return buf.toString("utf-8");
  try {
    return new TextDecoder("ibm437").decode(buf); // Python bhi cp437 maanta hai
  } catch {
    return buf.toString("latin1");
  }
}

export class ZipReader {
  private entries: Entry[] = [];
  private byName = new Map<string, Entry>();

  constructor(private readonly buf: Buffer) {
    // End-of-central-directory record dhoondo (peeche se, comment ke liye 64KB tak)
    let eocd = -1;
    const minPos = Math.max(0, buf.length - 22 - 0xffff);
    for (let i = buf.length - 22; i >= minPos; i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new BadZipFile();

    const total = buf.readUInt16LE(eocd + 10);
    const cdSize = buf.readUInt32LE(eocd + 12);
    let p = buf.readUInt32LE(eocd + 16);
    if (total === 0xffff || cdSize === 0xffffffff || p === 0xffffffff) throw new BadZipFile("ZIP64 not supported");
    if (p + cdSize > buf.length) throw new BadZipFile();

    for (let n = 0; n < total; n++) {
      if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new BadZipFile();
      const flags = buf.readUInt16LE(p + 8);
      const method = buf.readUInt16LE(p + 10);
      const compSize = buf.readUInt32LE(p + 20);
      const nameLen = buf.readUInt16LE(p + 28);
      const extraLen = buf.readUInt16LE(p + 30);
      const commentLen = buf.readUInt16LE(p + 32);
      const localOffset = buf.readUInt32LE(p + 42);
      const name = decodeName(buf.subarray(p + 46, p + 46 + nameLen), flags);
      const entry: Entry = { name, method, compSize, localOffset, flags };
      this.entries.push(entry);
      this.byName.set(name, entry); // duplicate naam: last wins (Python jaisa)
      p += 46 + nameLen + extraLen + commentLen;
    }
  }

  namelist(): string[] {
    return this.entries.map((e) => e.name);
  }

  read(name: string): Buffer {
    const e = this.byName.get(name);
    if (!e) throw new Error(`There is no item named '${name}' in the archive`);
    if (e.flags & 0x1) throw new Error(`File '${name}' is encrypted, password required for extraction`);
    const b = this.buf;
    const o = e.localOffset;
    if (o + 30 > b.length || b.readUInt32LE(o) !== 0x04034b50) throw new BadZipFile("Bad magic number for file header");
    const dataStart = o + 30 + b.readUInt16LE(o + 26) + b.readUInt16LE(o + 28);
    const data = b.subarray(dataStart, dataStart + e.compSize);
    if (e.method === 0) return Buffer.from(data);
    if (e.method === 8) return inflateRawSync(data, { maxOutputLength: 100 * 1024 * 1024 });
    throw new Error(`That compression method is not supported`);
  }
}

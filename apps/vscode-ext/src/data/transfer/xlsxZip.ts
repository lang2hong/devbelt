/**
 * .xlsx 的 ZIP 容器读写（从 `xlsx.ts` 抽出，Phase 2 拆分）。
 *
 * 自己实现而不引依赖：xlsx 是 OOXML（装着 XML 的 ZIP），deflate/inflate 由 Node 内置
 * zlib 提供。本模块只负责 ZIP 层（压缩/解压/中央目录/流式读取），XML 工作表语义见
 * `xlsxSheet.ts`。
 *
 * 有意限制：不支持 ZIP64 与加密文档，遇到时明确报错而非静默产出错数据。
 */
import { deflateRawSync, inflateRawSync, createInflateRaw } from 'zlib';
import { createReadStream, fstatSync, openSync, readSync, closeSync } from 'fs';

/**
 * 从 `position` 起读满 `buf`。
 *
 * `readSync` 允许短读（被信号中断等），直接以「返回值 != 请求长度」判截断会把合法文件误报损坏。
 */
function readExactSync(fd: number, buf: Buffer, position: number): void {
  let off = 0;
  while (off < buf.length) {
    const n = readSync(fd, buf, off, buf.length - off, position + off);
    if (n <= 0) throw new Error('Invalid .xlsx: unexpected end of file.');
    off += n;
  }
}

/** ZIP 条目（名称 + 内容）。 */
export interface ZipEntry {
  name: string;
  data: Buffer;
}

/**
 * 解压上限：防止「zip bomb」——一个几十 KB 的 .xlsx 解压出数 GB，撑爆扩展宿主内存。
 * 数值按正常工作簿留足余量，可按需调整。
 */
export const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
export const MAX_ENTRIES = 4096;

let crcTable: Int32Array | undefined;

function ensureCrcTable(): Int32Array {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c;
    }
  }
  return crcTable;
}

/** 增量 CRC32 运行态（初值 -1，终值 `(state ^ -1) >>> 0`）。 */
export function crc32Update(state: number, buf: Buffer): number {
  const table = ensureCrcTable();
  let crc = state;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return crc;
}

export function crc32(buf: Buffer): number {
  return (crc32Update(-1, buf) ^ -1) >>> 0;
}

/** DOS 时间戳：0 不是合法日期，统一写 1980-01-01 00:00 让产物可复现。 */
export const DOS_DATE = 0x0021;
export const DOS_TIME = 0;

/** ZIP32 字段上限：超出需 ZIP64（本实现不支持）。显式抛错，避免静默产出损坏文件。 */
const ZIP32_MAX = 0xffffffff;
export function assertZip32(value: number, what: string): void {
  if (value > ZIP32_MAX) {
    throw new Error(`.xlsx export exceeds ZIP32 limits (${what} > 4 GiB); ZIP64 is not supported.`);
  }
}

export function zip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const compressed = deflateRawSync(entry.data);
    const crc = crc32(entry.data);
    assertZip32(entry.data.length, `entry ${entry.name} uncompressed size`);
    assertZip32(compressed.length, `entry ${entry.name} compressed size`);
    assertZip32(offset, 'local header offset');

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0, 6); // flags
    header.writeUInt16LE(8, 8); // method: deflate
    header.writeUInt16LE(DOS_TIME, 10);
    header.writeUInt16LE(DOS_DATE, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(entry.data.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28); // extra
    locals.push(header, name, compressed);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4); // version made by
    record.writeUInt16LE(20, 6); // version needed
    record.writeUInt16LE(0, 8);
    record.writeUInt16LE(8, 10);
    record.writeUInt16LE(DOS_TIME, 12);
    record.writeUInt16LE(DOS_DATE, 14);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(compressed.length, 20);
    record.writeUInt32LE(entry.data.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt16LE(0, 30); // extra
    record.writeUInt16LE(0, 32); // comment
    record.writeUInt16LE(0, 34); // disk
    record.writeUInt16LE(0, 36); // internal attrs
    record.writeUInt32LE(0, 38); // external attrs
    record.writeUInt32LE(offset, 42);
    central.push(record, name);

    offset += header.length + name.length + compressed.length;
  }

  const directory = Buffer.concat(central);
  assertZip32(offset, 'central directory offset');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length
  return Buffer.concat([...locals, directory, end]);
}

/** 从尾部回扫 End Of Central Directory 签名（注释最长 64KB）。 */
export function findEndOfCentralDirectory(buf: Buffer): number {
  // EOCD 记录最小 22 字节；过短的 buffer 下面 readUInt32LE 会拿到负偏移抛 RangeError。
  if (buf.length < 22) {
    throw new Error('Not a valid .xlsx file (too small to contain a ZIP end-of-directory record).');
  }
  const min = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error('Not a valid .xlsx file (ZIP end-of-directory record not found).');
}

export function unzip(buf: Buffer): Map<string, Buffer> {
  const eocd = findEndOfCentralDirectory(buf);
  const count = buf.readUInt16LE(eocd + 10);
  if (count === 0xffff) throw new Error('ZIP64 .xlsx files are not supported.');
  if (count > MAX_ENTRIES) {
    throw new Error(`.xlsx has too many entries (${count} > ${MAX_ENTRIES}).`);
  }
  let pointer = buf.readUInt32LE(eocd + 16);
  const files = new Map<string, Buffer>();
  let totalBytes = 0;

  for (let i = 0; i < count; i++) {
    if (pointer + 46 > buf.length || buf.readUInt32LE(pointer) !== 0x02014b50) break;
    const flags = buf.readUInt16LE(pointer + 8);
    // bit 0 = 加密；解密不在能力范围内，静默返回空表会被误当作「空文件」
    if (flags & 0x1) throw new Error('Encrypted .xlsx files are not supported.');
    const method = buf.readUInt16LE(pointer + 10);
    const compressedSize = buf.readUInt32LE(pointer + 20);
    const uncompressedSize = buf.readUInt32LE(pointer + 24);
    const nameLength = buf.readUInt16LE(pointer + 28);
    const extraLength = buf.readUInt16LE(pointer + 30);
    const commentLength = buf.readUInt16LE(pointer + 32);
    const localOffset = buf.readUInt32LE(pointer + 42);
    const name = buf.toString('utf8', pointer + 46, pointer + 46 + nameLength);

    // 声明尺寸超上限就 fail-fast，避免在 inflate 时才耗尽内存。
    if (uncompressedSize > MAX_ENTRY_BYTES || totalBytes + uncompressedSize > MAX_TOTAL_BYTES) {
      throw new Error('.xlsx exceeds the decompression size limit.');
    }

    // 数据偏移必须按**本地头**里的名字/额外字段长度算：两者可与中央目录不同
    const localNameLength = buf.readUInt16LE(localOffset + 26);
    const localExtraLength = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buf.subarray(start, start + compressedSize);
    if (method !== 0 && method !== 8) {
      throw new Error(`Unsupported ZIP compression method ${method} in .xlsx file.`);
    }
    const data = method === 0
      ? Buffer.from(raw)
      : inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
    totalBytes += data.length;
    if (data.length > MAX_ENTRY_BYTES || totalBytes > MAX_TOTAL_BYTES) {
      throw new Error('.xlsx exceeds the decompression size limit.');
    }
    files.set(name, data);
    pointer += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

// ─── 流式读取（大文件不整包解压） ───

export interface ZipDirEntry { name: string; method: number; compSize: number; localOffset: number }

/** 读取 ZIP 中央目录（只读文件尾部与目录区，不整文件读入）。 */
export function readZipDirectory(filePath: string): Map<string, ZipDirEntry> {
  const fd = openSync(filePath, 'r');
  try {
    const size = fstatSync(fd).size;
    const tailLen = Math.min(size, 65_557);
    const tail = Buffer.allocUnsafe(tailLen);
    readExactSync(fd, tail, size - tailLen);
    const eocd = findEndOfCentralDirectory(tail);
    const count = tail.readUInt16LE(eocd + 10);
    if (count === 0xffff) throw new Error('ZIP64 .xlsx files are not supported.');
    if (count > MAX_ENTRIES) throw new Error(`.xlsx has too many entries (${count} > ${MAX_ENTRIES}).`);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error('ZIP64 .xlsx files are not supported.');
    if (cdOffset + cdSize > size) throw new Error('Invalid .xlsx: central directory out of range.');
    const cd = Buffer.allocUnsafe(cdSize);
    readExactSync(fd, cd, cdOffset);
    const map = new Map<string, ZipDirEntry>();
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break;
      const flags = cd.readUInt16LE(p + 8);
      if (flags & 0x1) throw new Error('Encrypted .xlsx files are not supported.');
      const method = cd.readUInt16LE(p + 10);
      const compSize = cd.readUInt32LE(p + 20);
      const uncompressedSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const localOffset = cd.readUInt32LE(p + 42);
      // ZIP64 哨兵值必须显式拒绝：0xffffffff 会被当成真实偏移/长度，导致超大分配或错位读取。
      if (compSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff
        || nameLen === 0xffff || extraLen === 0xffff || commentLen === 0xffff) {
        throw new Error('ZIP64 .xlsx files are not supported.');
      }
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
      if (uncompressedSize > MAX_ENTRY_BYTES) throw new Error('.xlsx exceeds the decompression size limit.');
      map.set(name, { name, method, compSize, localOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return map;
  } finally {
    closeSync(fd);
  }
}

/** 计算条目数据在文件中的偏移（本地头的名字/额外字段长度可与中央目录不同）。 */
function entryDataRange(filePath: string, entry: ZipDirEntry): { start: number; end: number } {
  const fd = openSync(filePath, 'r');
  try {
    const lh = Buffer.allocUnsafe(30);
    readExactSync(fd, lh, entry.localOffset);
    const nameLen = lh.readUInt16LE(26);
    const extraLen = lh.readUInt16LE(28);
    const start = entry.localOffset + 30 + nameLen + extraLen;
    return { start, end: start + entry.compSize - 1 };
  } finally {
    closeSync(fd);
  }
}

/** 完整读取一个小条目（sharedStrings/styles/workbook 等）。 */
export function readEntryFully(filePath: string, entry: ZipDirEntry): Buffer {
  const { start, end } = entryDataRange(filePath, entry);
  const fd = openSync(filePath, 'r');
  try {
    const raw = Buffer.allocUnsafe(end - start + 1);
    readExactSync(fd, raw, start);
    if (entry.method === 0) return raw;
    if (entry.method !== 8) throw new Error(`Unsupported ZIP compression method ${entry.method} in .xlsx file.`);
    return inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
  } finally {
    closeSync(fd);
  }
}

/** 流式读取一个条目：逐块产出解压后的内容。 */
export async function* streamEntryChunks(filePath: string, entry: ZipDirEntry): AsyncGenerator<Buffer> {
  const { start, end } = entryDataRange(filePath, entry);
  const rs = createReadStream(filePath, { start, end, highWaterMark: 64 * 1024 });
  try {
    if (entry.method === 0) {
      for await (const chunk of rs) yield chunk as Buffer;
      return;
    }
    if (entry.method !== 8) throw new Error(`Unsupported ZIP compression method ${entry.method} in .xlsx file.`);
    const inflate = createInflateRaw({ maxOutputLength: MAX_ENTRY_BYTES });
    rs.pipe(inflate);
    rs.on('error', (err) => inflate.destroy(err));
    try {
      for await (const chunk of inflate) yield chunk as Buffer;
    } finally {
      // 预览提前 break 或 inflate 报错时必须释放 sink；否则源文件流会继续读到 EOF，泄漏句柄。
      inflate.destroy();
    }
  } finally {
    rs.destroy();
  }
}
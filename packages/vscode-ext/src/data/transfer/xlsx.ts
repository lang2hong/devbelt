import { deflateRawSync, inflateRawSync, createDeflateRaw } from 'zlib';
import { once } from 'events';

/**
 * Excel (.xlsx) 读写。
 *
 * 自己实现而不是依赖 `xlsx` 包：该包此前是**可选依赖且从未安装**，
 * `isXlsxAvailable()` 恒为 false，于是「导出 Excel」在所有入口都被隐藏掉了。
 * 而 xlsx 是 OOXML —— 一个装着 XML 的 ZIP，写读所需的能力（deflate/inflate）
 * Node 内置 zlib 已经提供，不值得为它引一个已停止维护的依赖。
 *
 * 能力范围（有意保持最小）：
 *  - 单工作表；写入用 inline string（省掉 sharedStrings 表）
 *  - 单元格类型：字符串 / 数字 / 布尔 / 空（空值不写单元格）
 *  - 读取时解析首个工作表，支持 sharedStrings、inlineStr 与数字
 *  - 不处理公式、样式与日期序列号（日期写为文本，读回即文本）
 *  - 不支持 ZIP64 与加密文档，遇到时明确报错而非静默产出错数据
 */

// ─── ZIP ───

interface ZipEntry {
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
function crc32Update(state: number, buf: Buffer): number {
  const table = ensureCrcTable();
  let crc = state;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return crc;
}

function crc32(buf: Buffer): number {
  return (crc32Update(-1, buf) ^ -1) >>> 0;
}

/** DOS 时间戳：0 不是合法日期，统一写 1980-01-01 00:00 让产物可复现。 */
const DOS_DATE = 0x0021;
const DOS_TIME = 0;

/** ZIP32 字段上限：超出需 ZIP64（本实现不支持）。显式抛错，避免静默产出损坏文件。 */
const ZIP32_MAX = 0xffffffff;
function assertZip32(value: number, what: string): void {
  if (value > ZIP32_MAX) {
    throw new Error(`.xlsx export exceeds ZIP32 limits (${what} > 4 GiB); ZIP64 is not supported.`);
  }
}

function zip(entries: ZipEntry[]): Buffer {
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
function findEndOfCentralDirectory(buf: Buffer): number {
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

function unzip(buf: Buffer): Map<string, Buffer> {
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

// ─── XML ───

/**
 * XML 文本转义。
 *
 * 同时剔除 XML 1.0 不允许的控制字符：数据库里存在 `\x00`–`\x08` 这类字节时，
 * 原样写入会让 Excel 直接判定文件损坏。
 */
function escapeXml(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function unescapeXml(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (_all, entity: string) => {
    switch (entity) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      default: {
        const code = entity[1] === 'x' || entity[1] === 'X'
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : '';
      }
    }
  });
}

/** 0 → A，25 → Z，26 → AA。 */
export function columnName(index: number): string {
  let name = '';
  let n = index;
  do {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return name;
}

/** `C12` → 2（列下标）。无法解析时返回 -1，由调用方按出现顺序兜底。 */
function columnIndexOf(ref: string): number {
  const letters = /^([A-Za-z]+)/.exec(ref)?.[1];
  if (!letters) return -1;
  let index = 0;
  for (const ch of letters.toUpperCase()) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
}

// ─── 写 ───

/** 单元格取值：数字/布尔保留原类型，其余转文本（日期与对象走文本，不做样式）。 */
function cellXml(ref: string, value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${ref}"><v>${value}</v></c>`;
  }
  if (typeof value === 'bigint') {
    return `<c r="${ref}" t="inlineStr"><is><t>${value.toString()}</t></is></c>`;
  }
  if (typeof value === 'boolean') {
    return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
  }
  const text = value instanceof Date
    ? value.toISOString()
    : typeof value === 'object'
      ? (Buffer.isBuffer(value) ? `[BLOB ${value.length}B]` : JSON.stringify(value))
      : String(value);
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
}

const SHEET_HEADER_PREFIX = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>';

function sheetHeader(columns: string[]): string {
  return SHEET_HEADER_PREFIX
    + `<row r="1">${columns.map((c, i) => cellXml(`${columnName(i)}1`, c)).join('')}</row>`;
}

function sheetRowXml(columns: string[], row: Record<string, unknown>, rowIndex: number): string {
  const cells = columns
    .map((column, columnIndex) => cellXml(`${columnName(columnIndex)}${rowIndex + 2}`, row[column]))
    .join('');
  return `<row r="${rowIndex + 2}">${cells}</row>`;
}

const SHEET_FOOTER = '</sheetData></worksheet>';

function sheetXml(columns: string[], rows: Record<string, unknown>[]): string {
  const parts: string[] = [sheetHeader(columns)];
  rows.forEach((row, rowIndex) => parts.push(sheetRowXml(columns, row, rowIndex)));
  parts.push(SHEET_FOOTER);
  return parts.join('');
}

/** 除工作表外的 4 个固定小条目（内存版与流式版共用）。 */
function staticEntries(): ZipEntry[] {
  const utf8 = (text: string): Buffer => Buffer.from(text, 'utf8');
  return [
    {
      name: '[Content_Types].xml',
      data: utf8(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + '<Default Extension="xml" ContentType="application/xml"/>'
        + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        + '</Types>',
      ),
    },
    {
      name: '_rels/.rels',
      data: utf8(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
        + '</Relationships>',
      ),
    },
    {
      name: 'xl/workbook.xml',
      data: utf8(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
        + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        + '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>'
        + '</workbook>',
      ),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: utf8(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
        + '</Relationships>',
      ),
    },
  ];
}

/** 序列化为 .xlsx 字节（内存版，供小数据 exportRows）。返回 Buffer —— 二进制格式不能当文本写盘。 */
export function serializeXlsx(columns: string[], rows: Record<string, unknown>[]): Buffer {
  return zip([
    ...staticEntries(),
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheetXml(columns, rows), 'utf8') },
  ]);
}

function zipLocalHeader(name: Buffer, flags: number, crc: number, compressedSize: number, uncompressedSize: number): Buffer {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4); // version needed
  header.writeUInt16LE(flags, 6);
  header.writeUInt16LE(8, 8); // method: deflate
  header.writeUInt16LE(DOS_TIME, 10);
  header.writeUInt16LE(DOS_DATE, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(compressedSize, 18);
  header.writeUInt32LE(uncompressedSize, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28); // extra
  return header;
}

function zipCentralRecord(name: Buffer, flags: number, crc: number, compressedSize: number, uncompressedSize: number, localOffset: number): Buffer {
  const record = Buffer.alloc(46);
  record.writeUInt32LE(0x02014b50, 0);
  record.writeUInt16LE(20, 4); // version made by
  record.writeUInt16LE(20, 6); // version needed
  record.writeUInt16LE(flags, 8);
  record.writeUInt16LE(8, 10);
  record.writeUInt16LE(DOS_TIME, 12);
  record.writeUInt16LE(DOS_DATE, 14);
  record.writeUInt32LE(crc, 16);
  record.writeUInt32LE(compressedSize, 20);
  record.writeUInt32LE(uncompressedSize, 24);
  record.writeUInt16LE(name.length, 28);
  record.writeUInt16LE(0, 30); // extra
  record.writeUInt16LE(0, 32); // comment
  record.writeUInt16LE(0, 34); // disk
  record.writeUInt16LE(0, 36); // internal attrs
  record.writeUInt32LE(0, 38); // external attrs
  record.writeUInt32LE(localOffset, 42);
  return record;
}

/**
 * 流式序列化 .xlsx：工作表 `sheet1.xml` 逐页压缩写出，不再整表驻留内存。
 *
 * 4 个固定小条目先写；工作表条目用 **deflate 流 + 数据描述符**（GP bit3）：
 * 本地头尺寸先置 0，压缩数据后写 `[签名][crc][压缩大小][原始大小]`，中央目录按
 * 最终值回填。CRC 与原始大小在喂入未压缩分块时增量累计。
 */
export async function writeXlsx(
  columns: string[],
  forEachPage: (onRows: (rows: Record<string, unknown>[]) => void | Promise<void>) => Promise<void>,
  write: (chunk: Uint8Array) => void | Promise<void>,
): Promise<void> {
  let offset = 0;
  const central: Buffer[] = [];
  const totalEntries = staticEntries().length + 1;

  const writeBuf = async (buf: Buffer): Promise<void> => {
    await write(buf);
    offset += buf.length;
  };

  for (const entry of staticEntries()) {
    const name = Buffer.from(entry.name, 'utf8');
    const compressed = deflateRawSync(entry.data);
    const crc = crc32(entry.data);
    assertZip32(entry.data.length, `entry ${entry.name} uncompressed size`);
    assertZip32(compressed.length, `entry ${entry.name} compressed size`);
    assertZip32(offset, 'local header offset');
    const localOffset = offset;
    await writeBuf(zipLocalHeader(name, 0, crc, compressed.length, entry.data.length));
    await writeBuf(name);
    await writeBuf(compressed);
    central.push(zipCentralRecord(name, 0, crc, compressed.length, entry.data.length, localOffset), name);
  }

  const name = Buffer.from('xl/worksheets/sheet1.xml', 'utf8');
  const localOffset = offset;
  // flags 0x0808：bit3=数据描述符（尺寸后置）+ bit11=UTF-8 名称。
  await writeBuf(zipLocalHeader(name, 0x0808, 0, 0, 0));
  await writeBuf(name);

  const deflate = createDeflateRaw();
  let compressedSize = 0;
  const consumer = (async (): Promise<void> => {
    for await (const chunk of deflate) {
      compressedSize += (chunk as Buffer).length;
      await writeBuf(Buffer.from(chunk as Buffer));
    }
  })();

  let crcState = -1;
  let uncompressedSize = 0;
  const feed = async (text: string): Promise<void> => {
    const buf = Buffer.from(text, 'utf8');
    crcState = crc32Update(crcState, buf);
    uncompressedSize += buf.length;
    if (!deflate.write(buf)) await once(deflate, 'drain');
  };

  await feed(sheetHeader(columns));
  let rowIndex = 0;
  await forEachPage(async (rows) => {
    for (const row of rows) {
      await feed(sheetRowXml(columns, row, rowIndex));
      rowIndex += 1;
    }
  });
  await feed(SHEET_FOOTER);
  deflate.end();
  await consumer;

  const crc = (crcState ^ -1) >>> 0;
  assertZip32(compressedSize, 'worksheet compressed size');
  assertZip32(uncompressedSize, 'worksheet uncompressed size');
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50, 0); // data descriptor signature
  descriptor.writeUInt32LE(crc, 4);
  descriptor.writeUInt32LE(compressedSize, 8);
  descriptor.writeUInt32LE(uncompressedSize, 12);
  await writeBuf(descriptor);
  central.push(zipCentralRecord(name, 0x0808, crc, compressedSize, uncompressedSize, localOffset), name);

  const directory = Buffer.concat(central);
  const directoryOffset = offset;
  assertZip32(directoryOffset, 'central directory offset');
  await writeBuf(directory);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with directory
  end.writeUInt16LE(totalEntries, 8);
  end.writeUInt16LE(totalEntries, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(directoryOffset, 16);
  end.writeUInt16LE(0, 20); // comment length
  await writeBuf(end);
}

// ─── 读 ───

function parseSharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  const items: string[] = [];
  for (const match of xml.matchAll(/<si\b[^>]*(?:\/>|>([\s\S]*?)<\/si>)/g)) {
    const inner = match[1] ?? '';
    // 富文本由多个 <r><t>…</t></r> 组成，需要按顺序拼起来
    const text = [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join('');
    items.push(unescapeXml(text));
  }
  return items;
}

/** 解析工作表的行；每行是「列下标 → 值」。 */
function parseSheetRows(xml: string, shared: string[]): Map<number, unknown>[] {
  const rows: Map<number, unknown>[] = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const inner = rowMatch[1] ?? '';
    const cells = new Map<number, unknown>();
    let fallbackIndex = 0;
    for (const cellMatch of inner.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cellMatch[1] ?? '';
      const body = cellMatch[2] ?? '';
      const ref = /\br="([^"]+)"/.exec(attrs)?.[1] ?? '';
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? 'n';
      const index = ref ? columnIndexOf(ref) : -1;
      const column = index >= 0 ? index : fallbackIndex;
      fallbackIndex = column + 1;
      cells.set(column, cellValue(type, body, shared));
    }
    rows.push(cells);
  }
  return rows;
}

function cellValue(type: string, body: string, shared: string[]): unknown {
  const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1];
  switch (type) {
    case 's': {
      const index = Number(raw);
      return Number.isInteger(index) ? (shared[index] ?? null) : null;
    }
    case 'inlineStr': {
      const text = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join('');
      return unescapeXml(text);
    }
    case 'b':
      return raw === '1';
    case 'e':
      // 公式错误值（#DIV/0! 之类）没有可用数据，按空处理
      return null;
    case 'str':
      return raw === undefined ? null : unescapeXml(raw);
    default: {
      if (raw === undefined || raw === '') return null;
      const num = Number(raw);
      return Number.isFinite(num) ? num : unescapeXml(raw);
    }
  }
}

/** 找到首个工作表的部件路径（按 workbook 里声明的顺序，而不是文件名字典序）。 */
function firstSheetPath(files: Map<string, Buffer>): string {
  const workbook = files.get('xl/workbook.xml')?.toString('utf8');
  const relsXml = files.get('xl/_rels/workbook.xml.rels')?.toString('utf8');
  const relId = workbook ? /<sheet\b[^>]*r:id="([^"]+)"/.exec(workbook)?.[1] : undefined;
  if (relId && relsXml) {
    const escaped = relId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const target = new RegExp(`<Relationship\\b[^>]*Id="${escaped}"[^>]*Target="([^"]+)"`).exec(relsXml)?.[1]
      ?? new RegExp(`<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${escaped}"`).exec(relsXml)?.[1];
    if (target) {
      const normalized = target.replace(/^\/?xl\//, '').replace(/^\//, '');
      if (files.has(`xl/${normalized}`)) return `xl/${normalized}`;
    }
  }
  const fallback = [...files.keys()].find((name) => /^xl\/worksheets\/.+\.xml$/.test(name));
  if (!fallback) throw new Error('No worksheet found in .xlsx file.');
  return fallback;
}

/**
 * 解析 .xlsx 首个工作表：第一行是表头，其余为数据行。
 * 缺失的单元格填 `null`，让调用方自行决定是空串还是 NULL。
 */
export function parseXlsx(buffer: Buffer): Record<string, unknown>[] {
  const files = unzip(buffer);
  const shared = parseSharedStrings(files.get('xl/sharedStrings.xml')?.toString('utf8'));
  const sheet = files.get(firstSheetPath(files))!.toString('utf8');
  const rows = parseSheetRows(sheet, shared);
  if (!rows.length) return [];

  const header = rows[0];
  const width = Math.max(0, ...rows.map((row) => Math.max(-1, ...row.keys()) + 1));
  const columns: string[] = [];
  for (let i = 0; i < width; i++) {
    const name = header.get(i);
    columns.push(name === null || name === undefined || name === '' ? columnName(i) : String(name));
  }

  return rows.slice(1)
    // 整行为空的行（Excel 常在表格末尾留下空 <row/>）不该变成一条全 NULL 记录
    .filter((row) => [...row.values()].some((v) => v !== null && v !== undefined && v !== ''))
    .map((row) => {
      const out: Record<string, unknown> = {};
      columns.forEach((column, index) => { out[column] = row.get(index) ?? null; });
      return out;
    });
}

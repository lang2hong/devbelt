/**
 * .xlsx 工作表 XML 语义（从 `xlsx.ts` 抽出，Phase 2 拆分）。
 *
 * 负责单元格/工作表 XML 的序列化与解析、sharedStrings/styles（日期样式）、以及流式读取。
 * ZIP 容器层见 `xlsxZip.ts`。
 *
 * 能力范围（有意保持最小）：
 *  - 单工作表；写入用 inline string（省掉 sharedStrings 表）
 *  - 单元格类型：字符串 / 数字 / 布尔 / 空（空值不写单元格）
 *  - 读取时解析首个工作表，支持 sharedStrings、inlineStr 与数字
 *  - 不处理公式；日期序列号按样式识别
 *  - 不支持 ZIP64 与加密文档（由容器层明确报错）
 */
import { deflateRawSync, createDeflateRaw } from 'zlib';
import { once } from 'events';
import {
  DOS_DATE, DOS_TIME, assertZip32, crc32, crc32Update,
  readEntryFully, readZipDirectory, streamEntryChunks, unzip, zip,
} from './xlsxZip';
import type { ZipEntry, ZipDirEntry } from './xlsxZip';

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

/** Excel 最大列数（XFD = 16384 列）。超过即视为非法引用，避免被构造的超宽引用撑爆内存。 */
const MAX_COLUMNS = 16384;

/** `C12` → 2（列下标）。无法解析或越界（如 `ZZZZZZ1`）时返回 -1，由调用方按出现顺序兜底。 */
function columnIndexOf(ref: string): number {
  const letters = /^([A-Za-z]+)/.exec(ref)?.[1];
  // XFD 为 3 个字母；更长的引用不是合法 Excel 列，且逐字符累积会产生巨大下标。
  if (!letters || letters.length > 3) return -1;
  let index = 0;
  for (const ch of letters.toUpperCase()) index = index * 26 + (ch.charCodeAt(0) - 64);
  const column = index - 1;
  return column < MAX_COLUMNS ? column : -1;
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
  const statics = staticEntries();
  const totalEntries = statics.length + 1;

  const writeBuf = async (buf: Buffer): Promise<void> => {
    await write(buf);
    offset += buf.length;
    // 输出偏移（含中央目录偏移）一旦溢出立即失败，不等写完整表。
    assertZip32(offset, 'output offset');
  };

  for (const entry of statics) {
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
  let consumerError: unknown;
  const consumer = (async (): Promise<void> => {
    for await (const chunk of deflate) {
      compressedSize += (chunk as Buffer).length;
      // 压缩后尺寸越界即抛，避免把 >4GiB 的工作表先完整落盘再报错。
      assertZip32(compressedSize, 'worksheet compressed size');
      await writeBuf(Buffer.from(chunk as Buffer));
    }
  })();
  // 失败/取消路径会 destroy(deflate)，consumer 迭代随之结束或拒绝。这里捕获原始
  // 错误（如磁盘写失败），而不是让它在 feed 侧被 zlib 的 "operation aborted" 掩盖。
  consumer.catch((err) => { consumerError = err; });

  let crcState = -1;
  let uncompressedSize = 0;
  const feed = async (text: string): Promise<void> => {
    const buf = Buffer.from(text, 'utf8');
    crcState = crc32Update(crcState, buf);
    uncompressedSize += buf.length;
    // 未压缩尺寸越界即抛（fail-fast）。
    assertZip32(uncompressedSize, 'worksheet uncompressed size');
    if (!deflate.write(buf)) await once(deflate, 'drain');
  };

  let aborted = false;
  try {
    await feed(sheetHeader(columns));
    let rowIndex = 0;
    await forEachPage(async (rows) => {
      for (const row of rows) {
        await feed(sheetRowXml(columns, row, rowIndex));
        rowIndex += 1;
      }
    });
    await feed(SHEET_FOOTER);
  } catch (e) {
    aborted = true;
    // 让 consumer 的 .catch 微任务先落地，尽量暴露原始写盘错误而非 zlib 的 "operation aborted"。
    await Promise.resolve();
    throw consumerError ?? e;
  } finally {
    // 上游抛错（分页取消/写入失败/越界）时释放 zlib 原生句柄，避免反复取消大表导出累积句柄。
    if (aborted) deflate.destroy();
  }
  deflate.end();
  await consumer;
  if (consumerError) throw consumerError;

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
function parseRowCells(inner: string, shared: string[], dateStyles: Set<number>): Map<number, unknown> {
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
    const styleIndex = Number(/\bs="(\d+)"/.exec(attrs)?.[1] ?? NaN);
    cells.set(column, cellValue(type, body, shared, dateStyles, styleIndex));
  }
  return cells;
}

function parseSheetRows(xml: string, shared: string[], dateStyles: Set<number>): Map<number, unknown>[] {
  const rows: Map<number, unknown>[] = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    rows.push(parseRowCells(rowMatch[1] ?? '', shared, dateStyles));
  }
  return rows;
}

/** 内置的日期/时间格式 id（ECMA-376 保留区）。 */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

/**
 * 从 styles.xml 解析「哪些单元格样式是日期格式」。
 *
 * Excel 把日期存成数字序列号，靠单元格的 numFmtId 表达「这是日期」。不处理样式时，
 * 日期读回是一串数字（45292），导入数据库就变成错误数据。这里把日期样式的索引集合
 * 找出来，cellValue 据此把序列号转成日期字符串。
 */
function parseDateStyles(stylesXml: string | undefined): Set<number> {
  const result = new Set<number>();
  if (!stylesXml) return result;
  const customDateIds = new Set<number>();
  for (const m of stylesXml.matchAll(/<numFmt\b[^>]*\bnumFmtId="(\d+)"[^>]*\bformatCode="([^"]*)"/g)) {
    const code = unescapeXml(m[2]).replace(/\[[^\]]*\]/g, '').replace(/"[^"]*"/g, '');
    // 含日期/时间占位符即视为日期格式（排除纯数字/文本格式）。
    if (/[ymdhs]/i.test(code)) customDateIds.add(Number(m[1]));
  }
  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1] ?? '';
  let index = 0;
  for (const xf of cellXfs.matchAll(/<xf\b([^>]*?)(?:\/>|>[\s\S]*?<\/xf>)/g)) {
    const id = Number(/\bnumFmtId="(\d+)"/.exec(xf[1])?.[1] ?? NaN);
    if (BUILTIN_DATE_FORMATS.has(id) || customDateIds.has(id)) result.add(index);
    index++;
  }
  return result;
}

/**
 * Excel 序列号 → 日期字符串。
 *
 * 以 1899-12-30 为原点（对齐 Excel 的 1900 闰年 bug）：1970-01-01 = 序列号 25569。
 * 含小数部分表示时间。用 UTC 计算避免本机时区把日期挪一天。
 */
function excelSerialToDate(serial: number): string {
  const ms = Math.round((serial - 25569) * 86400000);
  const d = new Date(ms);
  const p2 = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
  const hasTime = Math.abs(serial - Math.floor(serial)) > 1e-9;
  if (!hasTime) return date;
  return `${date} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
}

function cellValue(type: string, body: string, shared: string[], dateStyles: Set<number>, styleIndex: number): unknown {
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
      if (Number.isFinite(num)) {
        return dateStyles.has(styleIndex) ? excelSerialToDate(num) : num;
      }
      return unescapeXml(raw);
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
  const dateStyles = parseDateStyles(files.get('xl/styles.xml')?.toString('utf8'));
  const sheet = files.get(firstSheetPath(files))!.toString('utf8');
  const rows = parseSheetRows(sheet, shared, dateStyles);
  if (!rows.length) return [];

  const header = rows[0];
  const width = Math.max(0, ...rows.map((row) => Math.max(-1, ...row.keys()) + 1));
  if (width > MAX_COLUMNS) throw new Error(`.xlsx sheet has too many columns (${width} > ${MAX_COLUMNS}).`);
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

/** 确定首个工作表路径（复用 firstSheetPath 的规则；失败时回退到目录里的第一个 worksheet）。 */
function firstSheetPathFromDir(filePath: string, dir: Map<string, ZipDirEntry>): string {
  const meta = new Map<string, Buffer>();
  for (const name of ['xl/workbook.xml', 'xl/_rels/workbook.xml.rels']) {
    const entry = dir.get(name);
    if (entry) meta.set(name, readEntryFully(filePath, entry));
  }
  try {
    return firstSheetPath(meta);
  } catch {
    const fallback = [...dir.keys()].find((name) => /^xl\/worksheets\/.+\.xml$/.test(name));
    if (!fallback) throw new Error('No worksheet found in .xlsx file.');
    return fallback;
  }
}

/** 从流式 XML 缓冲中切出完整 <row> 元素。 */
function takeNextRow(buffer: string): { inner: string; rest: string } | undefined {
  const start = buffer.indexOf('<row');
  if (start === -1) return undefined;
  const gt = buffer.indexOf('>', start);
  if (gt === -1) return undefined;
  if (buffer[gt - 1] === '/') return { inner: '', rest: buffer.slice(gt + 1) };
  const close = buffer.indexOf('</row>', gt);
  if (close === -1) return undefined;
  return { inner: buffer.slice(gt + 1, close), rest: buffer.slice(close + '</row>'.length) };
}

/** 一条记录转为行对象（表头列名 + 缺失列补 null）。 */
function rowToObject(columns: string[], cells: Map<number, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  columns.forEach((column, index) => { out[column] = cells.get(index) ?? null; });
  return out;
}

function isBlankCells(cells: Map<number, unknown>): boolean {
  for (const v of cells.values()) if (v !== null && v !== undefined && v !== '') return false;
  return true;
}

/**
 * 流式读取 .xlsx 首个工作表：按中央目录定位 sheet 条目，流式 inflate 并逐行解析，
 * 不再整包解压/整表驻留。第一行是表头。
 */
export async function* streamXlsxRows(filePath: string): AsyncGenerator<Record<string, unknown>> {
  const dir = readZipDirectory(filePath);
  const sharedEntry = dir.get('xl/sharedStrings.xml');
  const shared = parseSharedStrings(sharedEntry ? readEntryFully(filePath, sharedEntry).toString('utf8') : undefined);
  const stylesEntry = dir.get('xl/styles.xml');
  const dateStyles = parseDateStyles(stylesEntry ? readEntryFully(filePath, stylesEntry).toString('utf8') : undefined);
  const sheetPath = firstSheetPathFromDir(filePath, dir);
  const sheetEntry = dir.get(sheetPath);
  if (!sheetEntry) throw new Error('No worksheet found in .xlsx file.');

  let buffer = '';
  let columns: string[] | undefined;
  let headerDone = false;

  /** 处理一条 <row>：首行作表头，其余（非空行）产出对象。 */
  const handleRow = (inner: string): Record<string, unknown> | undefined => {
    const cells = parseRowCells(inner, shared, dateStyles);
    if (!headerDone) {
      // 首个非空行才是表头：以空行当表头会把列宽算成 0，之后所有数据行都变成 `{}`。
      if (isBlankCells(cells)) return undefined;
      headerDone = true;
      const width = Math.max(0, ...[...cells.keys()].map((k) => k + 1));
      if (width > MAX_COLUMNS) throw new Error(`.xlsx sheet has too many columns (${width} > ${MAX_COLUMNS}).`);
      columns = [];
      for (let i = 0; i < width; i++) {
        const name = cells.get(i);
        columns.push(name === null || name === undefined || name === '' ? columnName(i) : String(name));
      }
      return undefined;
    }
    if (!columns || isBlankCells(cells)) return undefined;
    return rowToObject(columns, cells);
  };

  const drain = (): Record<string, unknown>[] => {
    const out: Record<string, unknown>[] = [];
    for (;;) {
      const taken = takeNextRow(buffer);
      if (!taken) break;
      buffer = taken.rest;
      const row = handleRow(taken.inner);
      if (row) out.push(row);
    }
    return out;
  };

  for await (const chunk of streamEntryChunks(filePath, sheetEntry)) {
    buffer += chunk.toString('utf8');
    for (const row of drain()) yield row;
  }
  for (const row of drain()) yield row;
}

/** 只读前若干行 + 列名，用于导入向导预览。 */
export async function readXlsxSample(filePath: string, sampleSize = 200): Promise<{ columns: string[]; rows: Record<string, unknown>[] }> {
  const rows: Record<string, unknown>[] = [];
  let columns: string[] = [];
  for await (const row of streamXlsxRows(filePath)) {
    if (!columns.length) columns = Object.keys(row);
    rows.push(row);
    if (rows.length >= sampleSize) break;
  }
  return { columns, rows };
}
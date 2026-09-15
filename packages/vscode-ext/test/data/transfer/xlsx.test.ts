import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'zlib';
import { MAX_ENTRY_BYTES, columnName, parseXlsx, serializeXlsx } from '../../../src/data/transfer/xlsx';

/**
 * xlsx 读写自实现的回归测试。
 *
 * 该能力过去挂在**未安装**的可选依赖 `xlsx` 上：`isXlsxAvailable()` 恒为 false，
 * 所有「导出 Excel」入口都把选项隐藏了，用户看到的就是「所有导出缺 Excel」。
 * 现在改为包内实现（Node 内置 zlib），必须由测试守住 round-trip 正确性。
 */
describe('xlsx 序列化', () => {
  it('产出合法 ZIP 容器（PK 魔数 + 必需部件）', () => {
    const buf = serializeXlsx(['id'], [{ id: 1 }]);
    expect(buf.subarray(0, 4).toString('latin1')).toBe('PK\x03\x04');
    // 中央目录里应能看到 OOXML 必需部件名
    const text = buf.toString('latin1');
    for (const part of ['[Content_Types].xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']) {
      expect(text).toContain(part);
    }
  });

  it('round-trip 保留列顺序与值', () => {
    const rows = [
      { id: 1, name: 'Alice', active: true },
      { id: 2, name: 'Bob', active: false },
    ];
    const parsed = parseXlsx(serializeXlsx(['id', 'name', 'active'], rows));
    expect(parsed).toEqual([
      { id: 1, name: 'Alice', active: true },
      { id: 2, name: 'Bob', active: false },
    ]);
  });

  it('数字保持数字类型，不被转成字符串', () => {
    const parsed = parseXlsx(serializeXlsx(['n', 'f'], [{ n: 42, f: -3.5 }]));
    expect(parsed[0].n).toBe(42);
    expect(parsed[0].f).toBe(-3.5);
  });

  it('XML 元字符与中文原样往返', () => {
    const value = '<a & b> "q" \'s\' 中文';
    const parsed = parseXlsx(serializeXlsx(['t'], [{ t: value }]));
    expect(parsed[0].t).toBe(value);
  });

  it('保留前后空格（xml:space=preserve）', () => {
    const parsed = parseXlsx(serializeXlsx(['t'], [{ t: '  padded  ' }]));
    expect(parsed[0].t).toBe('  padded  ');
  });

  it('NULL 单元格不写入，读回为 null 且不破坏后续列的位置', () => {
    const parsed = parseXlsx(serializeXlsx(['a', 'b', 'c'], [{ a: null, b: undefined, c: 'tail' }]));
    expect(parsed[0]).toEqual({ a: null, b: null, c: 'tail' });
  });

  it('剔除 XML 非法控制字符（否则 Excel 判定文件损坏）', () => {
    const parsed = parseXlsx(serializeXlsx(['t'], [{ t: 'a\u0000b\u0007c' }]));
    expect(parsed[0].t).toBe('abc');
  });

  it('Date 与对象值降级为文本而不是丢失', () => {
    const date = new Date('2024-01-15T10:30:45.000Z');
    const parsed = parseXlsx(serializeXlsx(['d', 'o'], [{ d: date, o: { k: 1 } }]));
    expect(parsed[0].d).toBe(date.toISOString());
    expect(parsed[0].o).toBe('{"k":1}');
  });

  it('空数据集只写表头，读回为空数组', () => {
    expect(parseXlsx(serializeXlsx(['id', 'name'], []))).toEqual([]);
  });

  it('大数据量（跨 deflate 块）仍可完整读回', () => {
    const rows = Array.from({ length: 2000 }, (_, i) => ({ id: i, name: `name-${i}` }));
    const parsed = parseXlsx(serializeXlsx(['id', 'name'], rows));
    expect(parsed).toHaveLength(2000);
    expect(parsed[1999]).toEqual({ id: 1999, name: 'name-1999' });
  });
});

describe('xlsx 解析健壮性', () => {
  it('非 xlsx 输入给出明确错误而不是静默空结果', () => {
    expect(() => parseXlsx(Buffer.from('not a zip file'))).toThrow(/valid \.xlsx/);
  });

  it('列字母换算跨越 Z / AA 边界', () => {
    expect(columnName(0)).toBe('A');
    expect(columnName(25)).toBe('Z');
    expect(columnName(26)).toBe('AA');
    expect(columnName(51)).toBe('AZ');
    expect(columnName(52)).toBe('BA');
  });

  it('宽表（>26 列）表头与数据仍能对齐', () => {
    const columns = Array.from({ length: 30 }, (_, i) => `c${i}`);
    const row: Record<string, unknown> = {};
    columns.forEach((c, i) => { row[c] = i; });
    const parsed = parseXlsx(serializeXlsx(columns, [row]));
    expect(parsed[0].c29).toBe(29);
  });

  it('sharedStrings 与 inlineStr 两种字符串写法都能解析', () => {
    // 手工构造一份用 sharedStrings 的最小工作簿（Excel 的默认写法）
    const sheet = '<worksheet><sheetData>'
      + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>b</t></is></c></row>'
      + '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>7</v></c></row>'
      + '</sheetData></worksheet>';
    const shared = '<sst><si><t>colA</t></si><si><r><t>He</t></r><r><t>llo</t></r></si></sst>';
    const buf = buildWorkbook(sheet, shared);
    expect(parseXlsx(buf)).toEqual([{ colA: 'Hello', b: 7 }]);
  });

  it('公式错误单元格读作 null', () => {
    const sheet = '<worksheet><sheetData>'
      + '<row r="1"><c r="A1" t="inlineStr"><is><t>v</t></is></c></row>'
      + '<row r="2"><c r="A2" t="e"><v>#DIV/0!</v></c></row>'
      + '<row r="3"><c r="A3" t="inlineStr"><is><t>x</t></is></c></row>'
      + '</sheetData></worksheet>';
    expect(parseXlsx(buildWorkbook(sheet))).toEqual([{ v: 'x' }]);
  });
});

/**
 * 用本模块的 ZIP 写入能力包一份自定义 sheet XML，
 * 以便测试「别的工具产出的 xlsx」（sharedStrings / 错误值等写法）。
 */
function buildWorkbook(sheetXml: string, sharedStringsXml?: string): Buffer {
  // 先产出一份标准工作簿，再把其中的 sheet 部件替换掉：
  // 这样不必在测试里重复一遍 ZIP 细节。
  const base = serializeXlsx(['placeholder'], []);
  const files = readZip(base);
  files.set('xl/worksheets/sheet1.xml', Buffer.from(sheetXml, 'utf8'));
  if (sharedStringsXml) files.set('xl/sharedStrings.xml', Buffer.from(sharedStringsXml, 'utf8'));
  return writeStoredZip(files);
}

/** 极简 ZIP 读取（仅供测试重打包用，正式解析走 xlsx.parseXlsx）。 */
function readZip(buf: Buffer): Map<string, Buffer> {
  const zlib = require('zlib');
  const files = new Map<string, Buffer>();
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const lhName = buf.readUInt16LE(localOffset + 26);
    const lhExtra = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lhName + lhExtra;
    const raw = buf.subarray(start, start + compSize);
    files.set(name, method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

/** 用 store（method 0）重打包，顺带验证解析器能吃下未压缩条目。 */
function writeStoredZip(files: Map<string, Buffer>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  let crcTable: number[] | undefined;
  const crc32 = (b: Buffer): number => {
    if (!crcTable) {
      crcTable = [];
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crcTable.push(c >>> 0);
      }
    }
    let crc = 0xffffffff;
    for (const byte of b) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
    return (crc ^ 0xffffffff) >>> 0;
  };

  for (const [name, data] of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(0x0021, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    locals.push(header, nameBuf, data);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0, 10);
    record.writeUInt16LE(0x0021, 14);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(nameBuf.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, nameBuf);
    offset += header.length + nameBuf.length + data.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** 用 deflate（method 8）打包，便于构造高压缩比的条目。 */
function writeDeflatedZip(files: Map<string, Buffer>): Buffer {
  const crcTable: number[] = [];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable.push(c >>> 0);
  }
  const crc32 = (b: Buffer): number => {
    let crc = 0xffffffff;
    for (const byte of b) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
    return (crc ^ 0xffffffff) >>> 0;
  };

  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, raw] of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = deflateRawSync(raw);
    const crc = crc32(raw);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(8, 8); // method = deflate
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    locals.push(header, nameBuf, data);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(8, 10); // method = deflate
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(raw.length, 24);
    record.writeUInt16LE(nameBuf.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, nameBuf);
    offset += header.length + nameBuf.length + data.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

describe('xlsx 解压上限（zip bomb 防护）', () => {
  it('过短的 buffer 明确报错，而不是 RangeError', () => {
    expect(() => parseXlsx(Buffer.from([1, 2, 3]))).toThrow(/too small/);
  });

  it('声明的解压尺寸超过上限时 fail-fast', () => {
    // 65 MiB 零字节：压缩后很小，但声明尺寸超过 MAX_ENTRY_BYTES。
    const bomb = Buffer.alloc(MAX_ENTRY_BYTES + 1024);
    const zip = writeDeflatedZip(new Map([['xl/worksheets/sheet1.xml', bomb]]));
    expect(() => parseXlsx(zip)).toThrow(/decompression size limit/);
  });
});

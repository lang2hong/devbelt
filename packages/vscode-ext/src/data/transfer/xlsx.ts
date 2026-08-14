export function parseXlsx(buffer: Buffer): Record<string, unknown>[] {
  const XLSX = getXLSX();
  if (!XLSX) throw new Error('xlsx library not available. Install it with: npm install xlsx');

  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return [];
  const sheet = workbook.Sheets[sheetName];
  const data = XLSX.utils.sheet_to_json(sheet, { defval: null });
  return data as Record<string, unknown>[];
}

export function serializeXlsx(columns: string[], rows: Record<string, unknown>[]): Buffer {
  const XLSX = getXLSX();
  if (!XLSX) throw new Error('xlsx library not available. Install it with: npm install xlsx');

  const data = rows.map((row) => {
    const obj: Record<string, unknown> = {};
    for (const col of columns) obj[col] = row[col] ?? null;
    return obj;
  });
  const sheet = XLSX.utils.json_to_sheet(data);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');
  return Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
}

function getXLSX(): any {
  try {
    return require('xlsx');
  } catch {
    return undefined;
  }
}

/**
 * xlsx 依赖是否可用。
 *
 * 该依赖是可选的（未在 package.json 声明，打包时不含），因此 Excel 格式
 * 只在运行时能 require 到时才可用。UI 必须先问这里再决定是否提供 Excel
 * 选项 —— 否则用户选了才在导出/导入阶段撞上 'xlsx library not available'。
 */
export function isXlsxAvailable(): boolean {
  return getXLSX() !== undefined;
}
/**
 * Excel (.xlsx) 读写入口（Phase 2 拆分后仅做转发）。
 *
 * 实现分两层：
 *  - `xlsxZip.ts`：ZIP 容器（压缩/解压/中央目录/流式读取）；
 *  - `xlsxSheet.ts`：工作表 XML 语义（单元格序列化/解析、日期样式、流式读取）。
 *
 * 公共导出名保持不变，供 `exportService` / commands 直接 import。
 */
export { MAX_ENTRY_BYTES, MAX_TOTAL_BYTES, MAX_ENTRIES } from './xlsxZip';
export { columnName, serializeXlsx, writeXlsx, parseXlsx, streamXlsxRows, readXlsxSample } from './xlsxSheet';
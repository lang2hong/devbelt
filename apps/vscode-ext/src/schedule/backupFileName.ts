import { sanitizeFileName } from '../data/transfer/exportService';

/**
 * 计划备份文件名：库名经 `sanitizeFileName` 清洗后再与时间戳拼接。
 *
 * 库名可包含 `/`、`..` 等字符；不清洗会拼出逃出 `outputDir` 的相对路径。
 * 独立成纯函数以便直接单测（不依赖 vscode）。
 */
export function backupFileName(database: string, stamp: string, schema?: string): string {
  const base = schema ? `${database}.${schema}` : database;
  return `${sanitizeFileName(base)}_${stamp}.sql`;
}
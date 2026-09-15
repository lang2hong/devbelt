import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { arch, platform } from 'os';

/**
 * SQLite3 命令校验与解析（解耦自原项目，不再依赖 vscode 的 Global.context）。
 *
 * 原项目通过 vscode context 提供 sqlite 二进制目录，此处改为由调用方显式传入，
 * 使本模块无 vscode 依赖（允许 node 内建与子进程探测），可独立测试。
 *
 * 命令解析顺序：
 *  1. 显式提供的 sqliteCommand 可用 → 用之；
 *  2. 否则探测系统 PATH 上的 `sqlite3`（db-core 是 `"type":"module"`，
 *     用 ESM 无法直接 `require` CommonJS 探测库，故自行 spawn 探测）；
 *  3. 否则回退到 fallbackDir 下的内置二进制。
 */

/** 校验命令是否可用，不可用则回退到系统/bin 目录下的 sqlite3 */
export function validateSqliteCommand(
  sqliteCommand: string,
  fallbackDir?: string,
): string {
  if (sqliteCommand && isSqliteCommandValid(sqliteCommand)) {
    return sqliteCommand;
  }
  return getSqliteBinariesPath(fallbackDir);
}

/** 校验命令是否为可用的 sqlite3（版本 >= 3.9）。带 2s 超时，避免探针阻塞扩展宿主。 */
export function isSqliteCommandValid(sqliteCommand: string): boolean {
  const proc = spawnSync(sqliteCommand, ['-version'], { timeout: 2000 });
  if (proc.error) {
    // 含 ENOENT（不存在）与 ETIMEDOUT（挂起）等，一律视为不可用。
    return false;
  }
  let error = proc.stderr.toString();
  const output = proc.stdout.toString();

  // CentOS 等平台会打印无害警告，忽略该类错误
  if (
    error &&
    !error.match(/\: \/lib64\/libtinfo\.so\.[0-9]+: no version information available \(required by /)
  ) {
    return false;
  }

  const match = output.match(/3\.(?:9|[0-9][0-9])\.[0-9]{1,2} [0-9]{4}\-[0-9]{2}\-[0-9]{2} [0-9]{2}\:[0-9]{2}\:[0-9]{2}/);
  return match ? true : false;
}

/** 获取 sqlite3 二进制路径：优先系统命令，否则回退到 fallbackDir 下的内置二进制 */
export function getSqliteBinariesPath(fallbackDir?: string): string {
  if (isSqliteCommandValid('sqlite3')) {
    return 'sqlite3';
  }

  const plat = platform();
  const osArch = arch();
  let sqliteBin = '';

  switch (plat) {
    case 'win32':
      sqliteBin = 'sqlite-v3.26.0-win32-x86.exe';
      break;
    case 'linux':
      sqliteBin = osArch === 'x64' ? 'sqlite-v3.26.0-linux-x64' : 'sqlite-v3.26.0-linux-x86';
      break;
    case 'darwin':
      sqliteBin = 'sqlite-v3.26.0-osx-x86';
      break;
    default:
      sqliteBin = '';
      break;
  }

  if (sqliteBin && fallbackDir) {
    const path = `${fallbackDir}/${sqliteBin}`;
    if (existsSync(path)) {
      return path;
    }
  }
  return '';
}
import * as child_process from 'child_process';
import { EOL } from 'os';
import { StreamParser } from './streamParser';
import { ResultSetParser } from './resultSetParser';
import { validateSqliteCommand, getSqliteBinariesPath } from './sqliteCommandValidation';
import type { Result, ResultNew, ResultSet } from './common';

/**
 * SQLite 驱动封装：通过 sqlite3 CLI 子进程执行查询。
 * 原样复用自原项目查询逻辑，二进制命令路径由外部注入，保持解耦。
 */
class SQLite {
  public readonly dbPath: string;
  private sqliteCommand?: string;
  /** 所有在途 sqlite3 子进程，供连接关闭/取消时统一清理。 */
  private readonly activeProcs = new Set<child_process.ChildProcess>();

  constructor(dbPath: string, sqliteCommand?: string) {
    this.dbPath = dbPath;
    // 未显式配置 sqliteCommand 时自动探测：系统 sqlite3 →（后续）内置二进制回退。
    // 探测不到则置空，query() 会以「not configured」显式失败，绝不静默返回空结果。
    this.sqliteCommand = sqliteCommand ? validateSqliteCommand(sqliteCommand) : getSqliteBinariesPath();
  }

  /** 终止所有在途子进程（连接关闭时调用，避免进程悬空）。 */
  killAll(): void {
    for (const proc of this.activeProcs) {
      if (!proc.killed) proc.kill('SIGKILL');
    }
    this.activeProcs.clear();
  }

  query(query: string): Promise<ResultNew | ResultNew[]> {
    if (!this.sqliteCommand) {
      return Promise.reject(new Error(
        'sqlite3 command is not configured. '
        + 'Install sqlite3 or set the "sqliteCommand" field on this connection.',
      ));
    }
    return new Promise((res, rej) => {
      let settled = false;
      let resultSet: ResultSet | undefined;
      let errorMessage = '';
      const streamParser = new StreamParser(new ResultSetParser());

      const args = [
        '-header',
        '-nullvalue',
        'NULL',
        '-cmd',
        '.mode tcl',
      ];

      const proc = child_process.spawn(this.sqliteCommand as string, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.activeProcs.add(proc);
      const cleanup = (): void => { this.activeProcs.delete(proc); };
      // 写入 stdin 规避 unicode 路径问题（见 issues #32, #37）
      const escapedPath = this.dbPath.replace(/'/g, "''");
      proc.stdin!.write(`.open '${escapedPath}'${EOL}`);
      proc.stdin!.write(`.echo on${EOL}`);
      proc.stdin!.end(query);

      proc.stdout.pipe(streamParser).once('done', (data: ResultSet) => {
        resultSet = data;
      });

      proc.stderr.on('data', (data) => {
        errorMessage += data.toString().trim();
      });

      proc.once('error', (data) => {
        errorMessage += data;
      });

      proc.once('close', () => {
        cleanup();
        if (settled) return;
        settled = true;
        if (proc.killed) {
          rej(new Error('sqlite query cancelled'));
          return;
        }
        if (errorMessage) {
          rej(new Error(errorMessage));
          return;
        }
        if (!resultSet) {
          resultSet = [{ stmt: query, rows: [], header: [] }];
        }
        const newResult: ResultNew[] = resultSet.map((result) => ({
          sql: result.stmt,
          fields: result.header.map((head) => ({ name: head })),
          rows: result.rows.map((row) => {
            const obj: Record<string, string> = {};
            for (let i = 0; i < result.header.length; i++) {
              obj[result.header[i]] = row[i];
            }
            return obj;
          }),
        }));
        if (newResult.length === 1) {
          res(newResult[0]);
        } else {
          res(newResult);
        }
      });
    });
  }
}

export { SQLite, validateSqliteCommand };
export type { Result, ResultNew, ResultSet };
export default SQLite;
import type { ExecutedStatement, QueryObserver } from '@devbelt/db-core';
import type { SqlScanOptions } from '@devbelt/db-core/sql';
import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import { analyzeSqlRisk } from '../utils/sqlRisk';
import { dialectScanOptions } from '../utils/sqlDialectOptions';
import { containsSecretSql } from '../utils/sqlSecret';
import type { HistoryStore } from './historyStore';

/** 从 `USE <db>` / `SET search_path TO <schema>` 中取出切换到的库名。 */
const USE_DB = /^\s*USE\s+[`"[]?([\w$-]+)[`"\]]?\s*;?\s*$/i;
const SET_SEARCH_PATH = /^\s*SET\s+search_path\s+(?:TO|=)\s*[`"]?([\w$-]+)[`"]?/i;

/**
 * 语句级查询历史记录器。
 *
 * 挂在 `QueryService` 的观察者位上，因此**所有**经过该服务的语句都会流过这里，
 * 不必在几十个 DDL/DML 调用点逐个补写 `history.add` —— 那种做法每加一个新命令
 * 就会漏一次。
 *
 * 只记录修改性语句：SELECT、元数据查询、事务控制（BEGIN/COMMIT/ROLLBACK）、
 * `USE`、`SET AUTOCOMMIT` 都被 `analyzeSqlRisk` 判为非写而跳过。
 */
export class QueryHistoryRecorder {
  /**
   * 会话当前所在的库。
   *
   * 一条连接的会话会被 `USE` 切库（结果面板切库、导入前切库），只用
   * `conn.database` 会让历史里的库名与实际执行库不符，从历史恢复上下文时就跑错库。
   */
  private currentDatabase?: string;

  constructor(
    private readonly conn: SavedConnection,
    private readonly history: HistoryStore,
    /**
     * 该连接的扫描选项（含 MySQL NO_BACKSLASH_ESCAPES）。惰性调用，建连后才有缓存值；
     * 缺省回退方言默认选项。用于让"是否写语句"的判定与执行侧一致。
     */
    private readonly scanOptionsFor?: (conn: SavedConnection) => SqlScanOptions,
  ) {
    this.currentDatabase = conn.database;
  }

  /** 生成可交给 `QueryService` 的观察者函数。 */
  observer(): QueryObserver {
    return (info) => this.record(info);
  }

  private record(info: ExecutedStatement): void {
    const switched = this.detectDatabaseSwitch(info.sql);
    if (switched) {
      this.currentDatabase = switched;
      return;
    }
    if (!analyzeSqlRisk(info.sql, this.scanOptionsFor?.(this.conn) ?? dialectScanOptions(this.conn.dbType)).isWrite) return;
    if (containsSecretSql(info.sql)) return;

    // 历史写入是旁路的 best-effort：失败绝不能冒泡到已经成功的语句上，
    // 否则用户会看到「DDL 报错」而库里其实已经改完了。
    void this.history
      .add({
        sql: info.sql,
        connection: this.conn.name || this.conn.host,
        connectionId: this.conn.id,
        database: this.currentDatabase,
        costTime: info.costTime,
        rowCount: info.affectedRows ?? info.rowCount,
      })
      .catch(() => { /* best-effort history */ });
  }

  private detectDatabaseSwitch(sql: string): string | undefined {
    return sql.match(USE_DB)?.[1] || sql.match(SET_SEARCH_PATH)?.[1];
  }
}

/**
 * AI SQL 标记表（P9 S4）：记录"最近由 AI 生成并经用户执行"的 SQL，
 * 供结果面板判断是否展示「问 AI 为什么查不到」（0 行诊断）。
 *
 * - 进程内有界（200 条）+ TTL（30 分钟）：只用于会话内归因，不做持久化；
 * - 归一化（压空白/小写）后比较：用户执行前微调空白/大小写不破坏标记；
 * - `tryMark/tryGet` 静态便捷入口（对齐 AuditLogger.tryLog）：未初始化时静默 no-op，
 *   不逼每个调用点 try/catch。
 */
const MAX_ENTRIES = 200;
const TTL_MS = 30 * 60_000;

export class AiSqlRegistry {
  private static instance: AiSqlRegistry | undefined;

  static init(): AiSqlRegistry {
    this.instance = new AiSqlRegistry();
    return this.instance;
  }

  static tryGet(): AiSqlRegistry | undefined {
    return this.instance;
  }

  static tryMark(sql: string): void {
    this.instance?.mark(sql);
  }

  static reset(): void {
    this.instance = undefined;
  }

  private readonly entries = new Map<string, number>();

  mark(sql: string): void {
    const key = normalizeSql(sql);
    if (!key) return;
    this.prune();
    this.entries.set(key, Date.now());
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  isAiSql(sql: string): boolean {
    const key = normalizeSql(sql);
    if (!key) return false;
    this.prune();
    return this.entries.has(key);
  }

  private prune(): void {
    const cutoff = Date.now() - TTL_MS;
    for (const [key, at] of [...this.entries]) {
      if (at < cutoff) this.entries.delete(key);
    }
  }
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}
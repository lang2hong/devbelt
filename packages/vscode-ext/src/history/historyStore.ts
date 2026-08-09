/**
 * 查询历史记录。
 */
export interface QueryHistoryEntry {
  id: string;
  sql: string;
  /** 连接名 */
  connection: string;
  /** 连接唯一标识（用于恢复执行上下文） */
  connectionId?: string;
  /** 执行时的数据库/schema */
  database?: string;
  /** 执行时间戳 */
  time: number;
  /** 耗时 ms */
  costTime: number;
  /** 返回行数 */
  rowCount?: number;
}

/**
 * 查询历史存储：记录最近执行的 SQL，持久化到全局状态。
 */
export class HistoryStore {
  private static readonly KEY = 'dbclient.history';
  private static readonly MAX_ENTRIES = 100;

  constructor(
    private readonly memento: {
      get<T>(key: string): T | undefined;
      update(key: string, value: any): Thenable<void>;
    },
  ) {}

  /** 读取全部历史（新→旧） */
  list(): QueryHistoryEntry[] {
    return this.memento.get<QueryHistoryEntry[]>(HistoryStore.KEY) || [];
  }

  /** 记录一条历史（超出上限丢弃最旧） */
  async add(entry: Omit<QueryHistoryEntry, 'id' | 'time'>): Promise<void> {
    const list = this.list();
    list.unshift({ ...entry, id: `${Date.now()}`, time: Date.now() });
    if (list.length > HistoryStore.MAX_ENTRIES) {
      list.length = HistoryStore.MAX_ENTRIES;
    }
    await this.memento.update(HistoryStore.KEY, list);
  }

  /** 清空历史 */
  async clear(): Promise<void> {
    await this.memento.update(HistoryStore.KEY, []);
  }
}
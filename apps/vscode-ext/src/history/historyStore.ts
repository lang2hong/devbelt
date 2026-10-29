import { EventEmitter, type Event, eventBus, HistoryChangedEvent } from '@devbelt/db-host/utils/event';

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
  /** 执行失败（旧记录无此字段，视为成功）。 */
  failed?: boolean;
}

export const HISTORY_LIMIT_DEFAULT = 100;
export const HISTORY_LIMIT_MIN = 10;
export const HISTORY_LIMIT_MAX = 1000;

/** 把配置值收敛到允许范围；非法值回退默认。 */
export function clampHistoryLimit(value: unknown): number {
  const n = typeof value === 'number' ? Math.floor(value) : NaN;
  if (!Number.isFinite(n)) return HISTORY_LIMIT_DEFAULT;
  return Math.min(HISTORY_LIMIT_MAX, Math.max(HISTORY_LIMIT_MIN, n));
}

/**
 * 查询历史存储：记录最近执行的 SQL，持久化到全局状态。
 */
export class HistoryStore {
  private static readonly KEY = 'devbelt.history';
  private static idCounter = 0;

  private readonly changedEmitter = new EventEmitter<void>();
  /** 数据变更事件（新增/清空/合并），供自动同步订阅。 */
  readonly onChanged: Event<void> = this.changedEmitter.event;

  constructor(
    private readonly memento: {
      get<T>(key: string): T | undefined;
      update(key: string, value: any): Thenable<void>;
    },
    /** 保留上限（`devbelt.insights.historyLimit`）；每次写入时读取，改配置无需重启。 */
    private readonly limit: () => number = () => HISTORY_LIMIT_DEFAULT,
  ) {}

  /** 读取全部历史（新→旧） */
  list(): QueryHistoryEntry[] {
    return this.memento.get<QueryHistoryEntry[]>(HistoryStore.KEY) || [];
  }

  /** 记录一条历史（超出上限丢弃最旧） */
  async add(entry: Omit<QueryHistoryEntry, 'id' | 'time'>): Promise<void> {
    const list = this.list();
    list.unshift({ ...entry, id: `${Date.now()}_${++HistoryStore.idCounter}`, time: Date.now() });
    this.trimToRetention(list);
    await this.memento.update(HistoryStore.KEY, list);
    this.changedEmitter.fire();
    void eventBus.publish(new HistoryChangedEvent('add'));
  }

  /** 清空历史 */
  async clear(): Promise<void> {
    await this.memento.update(HistoryStore.KEY, []);
    this.changedEmitter.fire();
    void eventBus.publish(new HistoryChangedEvent('clear'));
  }

  /** 按当前保留上限裁剪存量历史（调小 `historyLimit` 后立即生效）；无需裁剪时不写入。 */
  async enforceRetention(): Promise<void> {
    const list = [...this.list()];
    const before = list.length;
    this.trimToRetention(list);
    if (list.length === before) return;
    await this.memento.update(HistoryStore.KEY, list);
    this.changedEmitter.fire();
  }

  /** 截断至保留上限，超出时丢弃最旧记录。 */
  private trimToRetention(list: QueryHistoryEntry[]): void {
    const max = clampHistoryLimit(this.limit());
    if (list.length > max) list.length = max;
  }

  // ─── 同步 ───

  /** 读取同步用原始历史数据 */
  getSyncData(): QueryHistoryEntry[] {
    return this.list();
  }

  /**
   * 合并远端历史到本地：按 id 并集去重，按 time 倒序后截断至上限。
   * 历史为日志型数据，不做软删除墓碑；清空操作不跨端传播。
   */
  async replaceAllMerge(remote: QueryHistoryEntry[]): Promise<void> {
    const local = this.list();
    const map = new Map<string, QueryHistoryEntry>();
    for (const entry of local) map.set(entry.id, entry);
    for (const entry of remote) {
      const prev = map.get(entry.id);
      if (!prev || (entry.time ?? 0) >= (prev.time ?? 0)) map.set(entry.id, entry);
    }
    const merged = [...map.values()].sort((a, b) => (b.time ?? 0) - (a.time ?? 0));
    this.trimToRetention(merged);
    await this.memento.update(HistoryStore.KEY, merged);
    this.changedEmitter.fire();
    void eventBus.publish(new HistoryChangedEvent('merge'));
  }
}

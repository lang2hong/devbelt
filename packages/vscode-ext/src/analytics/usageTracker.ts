/**
 * 用量埋点（本地累计，同步时批量上报）。
 * 模块级单例：extension activate 时注入 memento（globalState），
 * 连接打开/查询执行处调用 record*，同步时 flush 取出未上报计数并清零。
 */

interface UsageMemento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

export interface UsageSnapshot {
  connectionOpens: number;
  queryExecutes: number;
}

const KEY = 'dbclient.usage.pending';

class UsageTracker {
  private memento?: UsageMemento;
  private loaded = false;
  private pending: UsageSnapshot = { connectionOpens: 0, queryExecutes: 0 };

  init(memento: UsageMemento): void {
    this.memento = memento;
    this.load();
  }

  recordConnectionOpen(): void {
    this.load();
    this.pending.connectionOpens++;
    void this.save();
  }

  recordQueryExecute(): void {
    this.load();
    this.pending.queryExecutes++;
    void this.save();
  }

  /** 取并清零待上报计数（同步时调用） */
  async flush(): Promise<UsageSnapshot> {
    this.load();
    const out = { ...this.pending };
    this.pending = { connectionOpens: 0, queryExecutes: 0 };
    await this.save();
    return out;
  }

  private load(): void {
    if (this.loaded || !this.memento) return;
    const p = this.memento.get<UsageSnapshot>(KEY);
    if (p && typeof p.connectionOpens === 'number' && typeof p.queryExecutes === 'number') {
      this.pending = { connectionOpens: p.connectionOpens, queryExecutes: p.queryExecutes };
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    if (this.memento) await this.memento.update(KEY, this.pending);
  }
}

export const usageTracker = new UsageTracker();
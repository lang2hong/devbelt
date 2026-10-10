import type { Memento } from 'vscode';
import { uniqueId } from '@devbelt/db-host/utils/id';

/** 已保存的 ES DSL 查询（Memento 持久化；per 连接）。 */
export interface SavedEsQuery {
  id: string;
  name: string;
  connId: string;
  index: string;
  body: string;
  at: number;
}

const KEY = 'devbelt.esDslQueries';

/**
 * ES DSL 保存查询（S4）。
 *
 * 独立于 SQL 保存查询树：只落 globalState（不进同步数据），按 connId 隔离；
 * 结构简单（列表 upsert），不上查询历史/文件夹。
 */
export class EsDslStore {
  constructor(private readonly memento: Memento) {}

  list(connId: string): SavedEsQuery[] {
    return this.all()
      .filter((q) => q.connId === connId)
      .sort((a, b) => b.at - a.at);
  }

  /** 同名 upsert（更新 body/index 与时间）；Memento 写入 await（丢写/拒绝可见）。 */
  async save(connId: string, name: string, index: string, body: string): Promise<SavedEsQuery> {
    const trimmed = name.trim();
    const all = this.all();
    const existing = all.find((q) => q.connId === connId && q.name === trimmed);
    if (existing) {
      existing.index = index;
      existing.body = body;
      existing.at = Date.now();
      await this.memento.update(KEY, all);
      return existing;
    }
    const entry: SavedEsQuery = { id: uniqueId('esq'), name: trimmed, connId, index, body, at: Date.now() };
    all.push(entry);
    await this.memento.update(KEY, all);
    return entry;
  }

  /** 删除（按 id）；返回是否删除成功。 */
  async remove(id: string): Promise<boolean> {
    const all = this.all();
    const idx = all.findIndex((q) => q.id === id);
    if (idx < 0) return false;
    all.splice(idx, 1);
    await this.memento.update(KEY, all);
    return true;
  }

  private all(): SavedEsQuery[] {
    const raw = this.memento.get<SavedEsQuery[]>(KEY);
    if (!Array.isArray(raw)) return [];
    return raw.filter((q) => q && typeof q.id === 'string' && typeof q.connId === 'string');
  }
}
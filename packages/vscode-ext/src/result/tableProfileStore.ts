/**
 * 表视图 Profile：持久化每个连接 + 数据库 + 表的筛选/排序/列显隐状态。
 * 仅在预览具体表（TableQueryView.open）时生效；纯查询模式不使用。
 */
export interface TableProfile {
  sortCol?: string;
  sortDir?: string;
  filterCol?: string;
  filterVal?: string;
  /** 被隐藏的列名（按当前字段列表求交集后使用） */
  hiddenColumns?: string[];
  /** 用户调整后的列显示顺序（按当前字段列表求交集后使用） */
  columnOrder?: string[];
  /** 列名到像素宽度的映射（按当前字段列表求交集后使用） */
  columnWidths?: Record<string, number>;
}

export class TableProfileStore {
  private static readonly KEY = 'dbclient.tableProfile';

  constructor(
    private readonly memento: {
      get<T>(key: string): T | undefined;
      update(key: string, value: any): Thenable<void>;
    },
  ) {}

  private key(connId: string, database: string | undefined, table: string): string {
    return `${connId}::${database || ''}::${table}`;
  }

  /** 读取 Profile；未保存过则返回 undefined。 */
  get(connId: string, database: string | undefined, table: string): TableProfile | undefined {
    const all = this.memento.get<Record<string, TableProfile>>(TableProfileStore.KEY) || {};
    return all[this.key(connId, database, table)];
  }

  /** 保存（合并）Profile。 */
  async save(connId: string, database: string | undefined, table: string, patch: TableProfile): Promise<void> {
    const all = this.memento.get<Record<string, TableProfile>>(TableProfileStore.KEY) || {};
    const key = this.key(connId, database, table);
    all[key] = { ...all[key], ...patch };
    await this.memento.update(TableProfileStore.KEY, all);
  }

  /** 删除一张表的 Profile，使下次预览回到默认布局。 */
  async remove(connId: string, database: string | undefined, table: string): Promise<void> {
    const all = this.memento.get<Record<string, TableProfile>>(TableProfileStore.KEY) || {};
    delete all[this.key(connId, database, table)];
    await this.memento.update(TableProfileStore.KEY, all);
  }
}

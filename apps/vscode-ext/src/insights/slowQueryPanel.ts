import * as vscode from 'vscode';
import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import { BaseWebView } from '../result/baseWebView';
import { l10n } from '../i18n';
import type { HistoryStore } from '../history/historyStore';
import type {
  SlowQueryDownMessage,
  SlowQueryFilterView,
  SlowQueryGroupView,
  SlowQueryUpMessage,
} from '../result/protocol';
import { aggregateSlowQueries, type SlowQueryGroup } from './slowQueries';

export interface SlowQueryPanelDeps {
  history: HistoryStore;
  /** Saved connections (to resolve ids and show names). */
  connections: () => SavedConnection[];
  historyLimit: () => number;
  /** Open the SQL in an editor bound to the connection/database. */
  openSql: (sql: string, conn: SavedConnection | undefined, database: string | undefined) => Promise<void>;
  /** Open the EXPLAIN panel for the SQL. */
  explain: (sql: string, conn: SavedConnection, database: string | undefined) => void;
}

const DEFAULT_FILTER: SlowQueryFilterView = { range: '7d', keyword: '', sort: 'total' };

/**
 * P10 S5：慢查询分析面板（单例）。
 *
 * 只读本机查询历史并聚合，不连接数据库、不外发；历史变化时自动刷新。
 */
export class SlowQueryPanel extends BaseWebView {
  private static instance?: SlowQueryPanel;

  private filter: SlowQueryFilterView = { ...DEFAULT_FILTER };
  private webviewReady = false;
  /** 最近一次快照的分组（打开 SQL / EXPLAIN 按 key 查找）。 */
  private groups = new Map<string, SlowQueryGroup>();
  private readonly historySub: { dispose(): void };

  private constructor(private readonly deps: SlowQueryPanelDeps) {
    super('devbelt.slowQueries', l10n('wv.slow.panelTitle'), vscode.ViewColumn.Active);
    this.historySub = deps.history.onChanged(() => {
      if (this.webviewReady) this.pushSnapshot();
    });
  }

  static open(deps: SlowQueryPanelDeps): SlowQueryPanel {
    if (SlowQueryPanel.instance) {
      SlowQueryPanel.instance.reveal();
      if (SlowQueryPanel.instance.webviewReady) SlowQueryPanel.instance.pushSnapshot();
      return SlowQueryPanel.instance;
    }
    SlowQueryPanel.instance = new SlowQueryPanel(deps);
    return SlowQueryPanel.instance;
  }

  static current(): SlowQueryPanel | undefined {
    return SlowQueryPanel.instance;
  }

  static closeAll(): void {
    SlowQueryPanel.instance?.dispose();
    SlowQueryPanel.instance = undefined;
  }

  protected async handleMessage(msg: SlowQueryUpMessage): Promise<void> {
    if (msg?.type === 'ready') {
      if (!this.initSent) {
        this.initSent = true;
        this.webviewReady = false;
        this.post({ type: 'init', mode: 'slowQueries' } as SlowQueryDownMessage);
        return;
      }
      this.webviewReady = true;
      this.pushSnapshot();
      return;
    }
    if (msg.type === 'slowFilter') {
      this.filter = normalizeFilter(msg.filter);
      this.pushSnapshot();
      return;
    }
    if (msg.type === 'slowOpenSql' || msg.type === 'slowExplain') {
      const group = this.groups.get(String(msg.key ?? ''));
      if (!group) return;
      const conn = group.connectionId
        ? this.deps.connections().find((c) => c.id === group.connectionId)
        : undefined;
      if (msg.type === 'slowOpenSql') {
        await this.deps.openSql(group.sampleSql, conn, group.database);
        return;
      }
      if (!conn) {
        void vscode.window.showWarningMessage(l10n('wv.slow.connectionMissing', { name: group.connection }));
        return;
      }
      this.deps.explain(group.sampleSql, conn, group.database);
    }
  }

  protected onDispose(): void {
    super.onDispose();
    this.webviewReady = false;
    this.historySub.dispose();
    if (SlowQueryPanel.instance === this) SlowQueryPanel.instance = undefined;
  }

  private pushSnapshot(): void {
    const entries = this.deps.history.list();
    const connections = this.deps.connections();
    const known = new Set(connections.map((c) => c.id));
    const now = Date.now();
    const groups = aggregateSlowQueries(entries, {
      ...(this.filter.connectionId ? { connectionId: this.filter.connectionId } : {}),
      range: this.filter.range,
      keyword: this.filter.keyword,
      sort: this.filter.sort,
    }, now);
    this.groups = new Map(groups.map((g) => [g.key, g]));
    const views: SlowQueryGroupView[] = groups.map((g) => ({
      ...g,
      missingConnection: !g.connectionId || !known.has(g.connectionId),
    }));
    this.post({
      type: 'slowSnapshot',
      filter: this.filter,
      groups: views,
      connections: connections.map((c) => ({ id: c.id, name: c.name || c.host || c.id })),
      historySize: entries.length,
      historyLimit: this.deps.historyLimit(),
      now,
    } as SlowQueryDownMessage);
  }
}

const SORTS = new Set(['total', 'avg', 'max', 'count']);
const RANGES = new Set(['24h', '7d', '30d', 'all']);

/** webview 传来的筛选条件不可信：逐字段收敛到合法值。 */
export function normalizeFilter(input: unknown): SlowQueryFilterView {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const sort = typeof raw.sort === 'string' && SORTS.has(raw.sort) ? raw.sort : DEFAULT_FILTER.sort;
  const range = typeof raw.range === 'string' && RANGES.has(raw.range) ? raw.range : DEFAULT_FILTER.range;
  const keyword = typeof raw.keyword === 'string' ? raw.keyword.slice(0, 200) : '';
  const connectionId = typeof raw.connectionId === 'string' && raw.connectionId ? raw.connectionId : undefined;
  return {
    sort: sort as SlowQueryFilterView['sort'],
    range: range as SlowQueryFilterView['range'],
    keyword,
    ...(connectionId ? { connectionId } : {}),
  };
}
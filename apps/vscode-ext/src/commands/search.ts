import * as vscode from 'vscode';
import { DatabaseType } from '@devbelt/db-core';
import type { Deps, Sub } from './shared';
import { l10n } from '../i18n';
import { TableQueryView } from '../result/tableQueryView';

interface SearchHit {
  connId: string;
  connName: string;
  database: string;
  /** PG 对象所在 schema（搜索遍历全部 schema；其它方言为 undefined）。 */
  schema?: string;
  type: 'table' | 'view';
  name: string;
}

type SearchPickItem = vscode.QuickPickItem & { hit: SearchHit };

export function registerSearchCommands(deps: Deps, sub: Sub): void {
  sub('devbelt.searchObjects', async () => {
    const openIds = deps.treeProvider.getOpenConnIds();
    if (!openIds.length) {
      vscode.window.showInformationMessage(l10n('cmd.noConnection'));
      return;
    }

    const keyword = await vscode.window.showInputBox({
      prompt: l10n('search.prompt'),
      placeHolder: l10n('search.placeholder'),
    });
    if (keyword === undefined) return;
    const kw = keyword.trim().toLowerCase();
    if (!kw) return;

    const results = await searchObjects(deps, openIds, kw);
    if (!results.length) {
      vscode.window.showInformationMessage(l10n('search.noResults', { keyword }));
      return;
    }

    const capped = results.slice(0, 200);
    const items: SearchPickItem[] = capped.map((hit) => ({
      label: `${hit.type === 'table' ? '$(table)' : '$(eye)'} ${hit.name}`,
      description: hit.connName,
      detail: hit.schema ? `${hit.database}.${hit.schema}` : hit.database,
      hit,
    }));

    const picked = await vscode.window.showQuickPick<SearchPickItem>(items, {
      placeHolder: l10n('search.resultsPlaceholder', { n: items.length }),
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!picked) return;

    const conn = deps.store.get(picked.hit.connId);
    if (conn) {
      TableQueryView.open(conn, picked.hit.name, picked.hit.database, deps.manager, {
        objectType: picked.hit.type === 'view' ? 'view' : 'table',
        schema: picked.hit.schema,
      });
    }
  });
}

/** 搜索时最多枚举的库/每库 schema 数（每个库会开一个会话，防止大型实例开太多）。 */
const SEARCH_MAX_DATABASES = 12;
const SEARCH_MAX_SCHEMAS = 50;

async function searchObjects(deps: Deps, connIds: string[], keyword: string): Promise<SearchHit[]> {
  const perConn = connIds.map(async (id): Promise<SearchHit[]> => {
    const conn = deps.store.get(id);
    if (!conn) return [];
    try {
      const session = await deps.manager.connectSql(conn);
      const connName = conn.name || conn.host;
      // 搜索作用域：
      //  - PG（B2）：先取可见库，再对**每个库**取 schema（每个库用自己的会话）。
      //  - MySQL：逐库（一个会话可 USE 多库）。
      //  - 其余：单库。
      let scopes: { database: string; schema?: string }[];
      if (session.capabilities.schemas) {
        const dbs = session.capabilities.multiDatabaseExplorer
          ? await session.metadata.getDatabases()
          : [conn.database ?? ''];
        // 每个库会开一个会话：给库数/库内 schema 数加上限，避免大型 PG 实例一次开太多。
        const list = (dbs.length ? dbs : [conn.database ?? '']).slice(0, SEARCH_MAX_DATABASES);
        scopes = [];
        for (const db of list) {
          try {
            const dbSession = await deps.manager.connectSql(conn, db);
            const schemas = await dbSession.metadata.getSchemas();
            for (const schema of (schemas.length ? schemas : ['public']).slice(0, SEARCH_MAX_SCHEMAS)) scopes.push({ database: db, schema });
          } catch {
            // 某库无权限/取不到 schema：跳过该库。
          }
        }
      } else if (session.capabilities.multiDatabaseExplorer) {
        scopes = (await session.metadata.getDatabases()).map((db) => ({ database: db }));
      } else {
        scopes = [{ database: conn.database || (conn.dbType === DatabaseType.PG ? 'public' : 'main') }];
      }

      const hits: SearchHit[] = [];
      for (const scope of scopes) {
        const { database: db, schema } = scope;
        try {
          // 每个作用域取对应库的会话（PG 多库；其它引擎退化为同一主会话）。
          const sc = await deps.manager.connectSql(conn, db);
          const tables = await sc.metadata.getTables(db, schema);
          const views = await sc.metadata.getViews(db, schema);
          for (const t of tables) {
            if (t.name.toLowerCase().includes(keyword)) {
              hits.push({ connId: id, connName, database: db, schema, type: 'table', name: t.name });
            }
          }
          for (const v of views) {
            if (v.name.toLowerCase().includes(keyword)) {
              hits.push({ connId: id, connName, database: db, schema, type: 'view', name: v.name });
            }
          }
        } catch {
          // 单 scope 查询失败跳过
        }
      }
      return hits;
    } catch {
      return [];
    }
  });

  const settled = await Promise.allSettled(perConn);
  const all: SearchHit[] = [];
  for (const s of settled) {
    if (s.status === 'fulfilled') all.push(...s.value);
  }
  return all;
}

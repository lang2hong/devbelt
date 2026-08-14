import * as vscode from 'vscode';
import { DatabaseType } from '@db-client/core';
import type { Deps, Sub } from './shared';
import { l10n } from '../i18n';
import { TableQueryView } from '../result/tableQueryView';

interface SearchHit {
  connId: string;
  connName: string;
  database: string;
  type: 'table' | 'view';
  name: string;
}

type SearchPickItem = vscode.QuickPickItem & { hit: SearchHit };

export function registerSearchCommands(deps: Deps, sub: Sub): void {
  sub('dbclient.searchObjects', async () => {
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
      detail: hit.database,
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
      });
    }
  });
}

async function searchObjects(deps: Deps, connIds: string[], keyword: string): Promise<SearchHit[]> {
  const perConn = connIds.map(async (id): Promise<SearchHit[]> => {
    const conn = deps.store.get(id);
    if (!conn) return [];
    try {
      const session = await deps.manager.connect(conn);
      const connName = conn.name || conn.host;
      let databases: string[];
      if (session.capabilities.multiDatabaseExplorer) {
        databases = await session.metadata.getDatabases();
      } else {
        databases = [conn.database || (conn.dbType === DatabaseType.PG ? 'public' : 'main')];
      }

      const hits: SearchHit[] = [];
      for (const db of databases) {
        try {
          const tables = await session.metadata.getTables(db);
          const views = await session.metadata.getViews(db);
          for (const t of tables) {
            if (t.name.toLowerCase().includes(keyword)) {
              hits.push({ connId: id, connName, database: db, type: 'table', name: t.name });
            }
          }
          for (const v of views) {
            if (v.name.toLowerCase().includes(keyword)) {
              hits.push({ connId: id, connName, database: db, type: 'view', name: v.name });
            }
          }
        } catch {
          // 单库查询失败跳过
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

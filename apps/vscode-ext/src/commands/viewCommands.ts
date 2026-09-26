import * as vscode from 'vscode';
import {
  redisExists, redisExpire, redisHSet, redisPersist, redisRename, redisRPush, redisSAdd,
  redisScan, redisSelect, redisSet, redisUnlink, redisZAdd,
} from '@devbelt/db-core';
import type { ConnectionManager } from '../connection/connectionManager';
import type { DbTreeDataProvider } from '../tree/dbTreeDataProvider';
import type { BackupScheduler } from '../schedule/backupScheduler';
import type { AuthService } from '../sync/authService';
import { AuditLogger } from '../utils/auditLogger';
import { TerminalService } from '../terminal/terminalService';
import { TableDesignView } from '../result/tableDesignView';
import { StatusView } from '../result/statusView';
import { ERDiagramView } from '../result/erDiagramView';
import { DataDiffView } from '../result/dataDiffView';
import { DashboardView } from '../result/dashboardView';
import { AuditLogView } from '../result/auditLogView';
import { PoolStatusView } from '../result/poolStatusView';
import { RedisView } from '../result/redisView';
import { redisPrefixPattern, toRedisMatchPattern } from '../result/redisKeyFold';
import { canUseErDiagram } from '@devbelt/db-host/sync/entitlementGate';
import { configureBackupSchedule } from './backupWizard';
import { l10n } from '../i18n';

export interface ViewCommandDeps {
  context: vscode.ExtensionContext;
  manager: ConnectionManager;
  treeProvider: DbTreeDataProvider;
  auth: AuthService;
  backupScheduler: BackupScheduler;
  auditLogger: AuditLogger;
}

/**
 * 视图/面板类命令注册（从 extension.ts 抽出，降低 activate 篇幅）。
 */
export function registerViewCommands(deps: ViewCommandDeps): void {
  const { context, manager, treeProvider, auth, backupScheduler, auditLogger } = deps;

  /** 在共享 session 上执行一段「SELECT 归一 + 命令」（互斥，cluster 跳过 SELECT）。 */
  const withRedis = async (
    conn: any,
    dbIndex: number | undefined,
    fn: (client: any) => Promise<void>,
  ): Promise<void> => {
    const session = await manager.connect(conn);
    if (session.kind !== 'redis') throw new Error('connection is not a Redis session');
    const client = session.client;
    await client.runExclusive(async () => {
      if (!client.isCluster && dbIndex !== undefined && dbIndex !== session.db) {
        await redisSelect(client, dbIndex);
        session.db = dbIndex;
      }
      await fn(client);
    });
  };

  const auditRedis = (conn: any, dbIndex: number | undefined, sql: string, started?: number): void => {
    AuditLogger.tryLog({
      action: 'redis_command',
      connName: conn?.name || conn?.host || '',
      database: String(dbIndex ?? conn?.redisDb ?? 0),
      sql,
      costTime: started === undefined ? undefined : Date.now() - started,
    });
  };

  /** 树侧写操作后：重扫树 + 同步已打开的 keyBrowser 面板（键树/当前值）。 */
  const afterRedisMutation = async (node: any): Promise<void> => {
    await treeProvider.refreshRedisAfterMutation(node);
    if (node?.conn) RedisView.find(node.conn.id, 'keyBrowser')?.reloadKeys();
  };

  context.subscriptions.push(
    // Terminal 集成
    vscode.commands.registerCommand('devbelt.openTerminal', (node: any) => {
      if (node?.conn) TerminalService.open(node.conn, node.database);
    }),
    // 表设计视图
    vscode.commands.registerCommand('devbelt.designTable', async (node: any) => {
      if (node?.conn && node?.database) {
        const session = await manager.connectSql(node.conn);
        if (!session.capabilities.operations.includes('getTableDefinition')) {
          vscode.window.showWarningMessage(l10n('design.unsupported'));
          return;
        }
        void TableDesignView.open(node.conn, node.label, node.database, manager, () => treeProvider.refreshNode(node));
      }
    }),
    // 新建表（webview 表单）：比丢一段 CREATE TABLE 模板到编辑器更直接，
    // 且建完可以接着在同一面板里加列/加索引。
    vscode.commands.registerCommand('devbelt.newTableDesigner', async (node: any) => {
      const database = node?.database ?? node?.conn?.database;
      if (!node?.conn || !database) return;
      void TableDesignView.openNew(node.conn, database, manager, () => treeProvider.refreshNode(node));
    }),
    // Server 状态面板
    vscode.commands.registerCommand('devbelt.serverStatus', (node: any) => {
      if (node?.conn) {
        StatusView.open(node.conn, manager);
      }
    }),
    // ER 图
    vscode.commands.registerCommand('devbelt.showERDiagram', (node: any) => {
      if (!canUseErDiagram(auth.getCachedEntitlement())) {
        vscode.window.showWarningMessage(l10n('entitlement.erRequired'));
        return;
      }
      if (node?.conn && node?.database) {
        ERDiagramView.open(node.conn, node.database, manager);
      }
    }),
    // 数据对比
    vscode.commands.registerCommand('devbelt.compareData', async (node: any) => {
      if (!node?.conn || !node?.database) return;
      const session = await manager.connectSql(node.conn);
      const targetDbs = (await session.metadata.getDatabases()).filter((d: string) => d !== node.database);
      if (!targetDbs.length) {
        vscode.window.showWarningMessage(l10n('compare.noOtherDatabases'));
        return;
      }
      const target = await vscode.window.showQuickPick(
        targetDbs.map((d: string) => ({ label: d, value: d })),
        { placeHolder: l10n('compare.chooseData', { database: node.database ?? '' }) },
      );
      if (!target) return;
      void DataDiffView.open(node.conn, node.database, node.conn, target.value, manager);
    }),
    // 性能仪表盘
    vscode.commands.registerCommand('devbelt.dashboard', (node: any) => {
      if (node?.conn) {
        DashboardView.open(node.conn, manager);
      }
    }),
    // 审计日志
    vscode.commands.registerCommand('devbelt.showAuditLog', () => {
      AuditLogView.open(auditLogger);
    }),
    // 连接池状态
    vscode.commands.registerCommand('devbelt.showPoolStatus', () => {
      PoolStatusView.open(manager);
    }),
    // Redis 面板（P7 S2 / S5 拆分）：连接节点 → Status/Console/SlowLog/CommandLog；
    // DB 节点 → KeyBrowser（同连接复用实例，db 变化时切换）。
    vscode.commands.registerCommand('devbelt.redis.console', (node: any) => {
      if (node?.conn) RedisView.open(node.conn, manager, 'console', node.redisDbIndex);
    }),
    vscode.commands.registerCommand('devbelt.redis.keyBrowser', (node: any) => {
      if (node?.conn) RedisView.open(node.conn, manager, 'keyBrowser', node.redisDbIndex, node.redisKey);
    }),
    vscode.commands.registerCommand('devbelt.redis.serverStatus', (node: any) => {
      if (node?.conn) RedisView.open(node.conn, manager, 'serverStatus');
    }),
    vscode.commands.registerCommand('devbelt.redis.slowlog', (node: any) => {
      if (node?.conn) RedisView.open(node.conn, manager, 'slowlog');
    }),
    vscode.commands.registerCommand('devbelt.redis.commandLog', (node: any) => {
      if (node?.conn) RedisView.open(node.conn, manager, 'commandLog');
    }),
    // S5-3：键树「加载更多」哨兵（懒加载下一页 SCAN）。
    vscode.commands.registerCommand('devbelt.redis.loadMoreKeys', async (node: any) => {
      if (!node) return;
      await treeProvider.loadMoreRedisKeys(node);
      treeProvider.refreshNode(node.parent ?? node);
    }),
    // ───── C-1：树内写操作/搜索（导航与编辑都收进 explorer） ─────
    vscode.commands.registerCommand('devbelt.redis.searchKeys', async (node: any) => {
      if (!node?.conn) return;
      const raw = await vscode.window.showInputBox({ prompt: l10n('redis.tree.searchPrompt') });
      if (raw === undefined) return;
      treeProvider.setRedisMatch(node, toRedisMatchPattern(raw));
    }),
    vscode.commands.registerCommand('devbelt.redis.clearSearchKeys', (node: any) => {
      if (node?.conn) treeProvider.setRedisMatch(node, undefined);
    }),
    vscode.commands.registerCommand('devbelt.redis.renameKey', async (node: any) => {
      if (!node?.conn || !node.redisKey) return;
      const newKey = await vscode.window.showInputBox({ prompt: l10n('redis.tree.renamePrompt'), value: node.redisKey });
      if (!newKey || newKey === node.redisKey) return;
      const started = Date.now();
      try {
        await withRedis(node.conn, node.redisDbIndex, async (c) => {
          if (await redisExists(c, newKey)) throw new Error(l10n('cmd.redis.renameTargetExists'));
          await redisRename(c, node.redisKey, newKey);
        });
        auditRedis(node.conn, node.redisDbIndex, `RENAME ${node.redisKey}`, started);
        await afterRedisMutation(node);
      } catch (e) { vscode.window.showErrorMessage((e as Error).message); }
    }),
    vscode.commands.registerCommand('devbelt.redis.setKeyTtl', async (node: any) => {
      if (!node?.conn || !node.redisKey) return;
      const raw = await vscode.window.showInputBox({ prompt: l10n('redis.tree.ttlPrompt') });
      if (raw === undefined) return;
      const seconds = Number(raw);
      if (!Number.isFinite(seconds) || seconds < 0) return;
      try {
        await withRedis(node.conn, node.redisDbIndex, async (c) => {
          if (seconds > 0) await redisExpire(c, node.redisKey, seconds);
          else await redisPersist(c, node.redisKey);
        });
        auditRedis(node.conn, node.redisDbIndex, seconds > 0 ? `EXPIRE ${node.redisKey} ${seconds}` : `PERSIST ${node.redisKey}`);
        await afterRedisMutation(node);
      } catch (e) { vscode.window.showErrorMessage((e as Error).message); }
    }),
    vscode.commands.registerCommand('devbelt.redis.deleteKey', async (node: any) => {
      if (!node?.conn || !node.redisKey) return;
      const pick = await vscode.window.showWarningMessage(
        l10n('redis.tree.confirmDelete', { key: node.redisKey }), { modal: true }, l10n('common.delete'));
      if (pick !== l10n('common.delete')) return;
      const started = Date.now();
      try {
        await withRedis(node.conn, node.redisDbIndex, async (c) => { await redisUnlink(c, [node.redisKey]); });
        auditRedis(node.conn, node.redisDbIndex, `UNLINK ${node.redisKey}`, started);
        await afterRedisMutation(node);
      } catch (e) { vscode.window.showErrorMessage((e as Error).message); }
    }),
    vscode.commands.registerCommand('devbelt.redis.deleteFolder', async (node: any) => {
      if (!node?.conn) return;
      const prefix = node.redisKeyPrefix ?? '';
      if (!prefix) return;
      const pick = await vscode.window.showWarningMessage(
        l10n('redis.tree.confirmDeleteFolder', { prefix }), { modal: true }, l10n('common.delete'));
      if (pick !== l10n('common.delete')) return;
      const pattern = redisPrefixPattern(prefix, node.conn.keySeparator || ':');
      const started = Date.now();
      try {
        // 转义后的 pattern 也用于审计（记实际执行的 pattern）。
        // 注：该 db 全量循环在 runExclusive 内（不受 REDIS_TREE_MAX 树展示上限约束），
        // 正确性优先；期间其它 Redis 命令排队等待。
        await withRedis(node.conn, node.redisDbIndex, async (c) => {
          let cursor = '0';
          do {
            const page = await redisScan(c, cursor, { match: pattern, count: 500 });
            cursor = page.cursor;
            if (page.keys.length) await redisUnlink(c, page.keys);
          } while (cursor !== '0');
        });
        auditRedis(node.conn, node.redisDbIndex, `UNLINK ${pattern}`, started);
        await afterRedisMutation(node);
      } catch (e) { vscode.window.showErrorMessage((e as Error).message); }
    }),
    vscode.commands.registerCommand('devbelt.redis.newKey', async (node: any) => {
      if (!node?.conn) return;
      const name = await vscode.window.showInputBox({ prompt: l10n('redis.tree.newKeyName') });
      if (!name) return;
      const type = await vscode.window.showQuickPick(['string', 'hash', 'list', 'set', 'zset'], { placeHolder: l10n('redis.tree.newKeyType') });
      if (!type) return;
      let value = '';
      let score = '0';
      if (type !== 'string') {
        const valuePrompt = type === 'hash' ? l10n('redis.tree.newKeyField')
          : type === 'zset' ? l10n('redis.tree.newKeyMember')
            : l10n('redis.tree.newKeyValue');
        const v = await vscode.window.showInputBox({ prompt: valuePrompt });
        if (v === undefined) return;
        value = v;
        if (type === 'zset') {
          const s = await vscode.window.showInputBox({ prompt: l10n('redis.tree.newKeyScore'), value: '0' });
          if (s === undefined) return;
          score = s;
        }
      }
      try {
        await withRedis(node.conn, node.redisDbIndex, async (c) => {
          if (await redisExists(c, name)) throw new Error(l10n('cmd.redis.keyExists'));
          if (type === 'string') await redisSet(c, name, '');
          else if (type === 'hash') await redisHSet(c, name, value, '');
          else if (type === 'list') await redisRPush(c, name, [value]);
          else if (type === 'set') await redisSAdd(c, name, [value]);
          else await redisZAdd(c, name, score, value);
        });
        auditRedis(node.conn, node.redisDbIndex, `CREATE ${name}`);
        await afterRedisMutation(node);
        RedisView.open(node.conn, manager, 'keyBrowser', node.redisDbIndex, name);
      } catch (e) { vscode.window.showErrorMessage((e as Error).message); }
    }),
    // 定时备份
    vscode.commands.registerCommand('devbelt.scheduleBackup', async (node: any) => {
      if (!node?.conn || !node?.database) return;
      await configureBackupSchedule(backupScheduler, node.conn.id, node.database);
    }),
  );
}
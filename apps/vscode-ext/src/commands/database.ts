import * as vscode from 'vscode';
import { SchemaDiffService, BackupService, DataTransferService, DatabaseType, validateIdent } from '@devbelt/db-core';
import { DbTreeNode } from '../tree/dbTreeNode';
import { wrapIdentForConn, splitSqlStatements, streamSqlStatements, pgSchemaFor } from '../utils/sql';
import { confirmSqlExecution, ensureWritable } from '../utils/sqlSafety';
import { parseCsv, readCsvSample, streamCsvRows } from '../data/transfer/csv';
import { readJsonSample, streamJsonRows } from '../data/transfer/json';
import { parseXlsx, readXlsxSample, streamXlsxRows } from '../data/transfer/xlsx';
import { readXmlSample, streamXmlRows } from '../data/transfer/xml';
import { parseJson } from '../data/transfer/json';
import { parseXml } from '../data/transfer/xml';
import { autoMapFields, type FieldMapping } from '../data/transfer/fieldMapper';
import {
  exportFileName,
  exportFilters,
  writeTableExport,
  TransferCancelledError,
  type TransferFormat,
} from '../data/transfer/exportService';
import { writeChunksToFile } from '../utils/writeChunks';
import { importRows, importRowsStream } from '../data/transfer/importService';
import { AuditLogger } from '../utils/auditLogger';
import { l10n } from '../i18n';
import type { Deps, Sub } from './shared';
import { confirm, openSqlDoc, recordBulkHistory, requireCapability } from './shared';

export function registerDatabaseCommands(deps: Deps, sub: Sub): void {
  const { manager, treeProvider, connCtx } = deps;

  sub('devbelt.createDatabase', async (node: DbTreeNode) => {
    if (!node?.conn) return;
    if (!ensureWritable(node.conn)) return;
    const name = await vscode.window.showInputBox({ prompt: l10n('db.createPrompt') });
    if (!name) return;
    connCtx.setLast(node.conn);
    const session = await manager.connectSql(node.conn, node.database);
    if (!requireCapability(session, 'createDatabase')) return;
    await session.query.query(`CREATE DATABASE ${wrapIdentForConn(node.conn, validateIdent(name))}`);
    treeProvider.refresh();
    vscode.window.showInformationMessage(l10n('db.created', { name }));
  });

  sub('devbelt.dropDatabase', async (node: DbTreeNode) => {
    if (!node?.conn) return;
    if (!ensureWritable(node.conn)) return;
    if (!(await confirm('db.dropConfirm', 'db.drop', node.label))) return;
    const session = await manager.connectSql(node.conn, node.database);
    if (!requireCapability(session, 'dropDatabase')) return;
    await session.query.query(`DROP DATABASE ${wrapIdentForConn(node.conn, validateIdent(node.label))}`);
    manager.disposeConn(node.conn.id);
    treeProvider.refresh();
  });

  sub('devbelt.importData', async (node: DbTreeNode) => {
    if (!node?.conn) return;
    const format = await pickFormat('import');
    if (!format) return;

    const uri = await vscode.window.showOpenDialog({
      filters: importFilters(format),
      canSelectMany: false,
      openLabel: l10n('import.selectFile'),
    });
    if (!uri?.[0]) return;
    // 结构化格式统一走流式：传路径而不整文件读入（大文件 OOM）。
    if (format === 'csv' || format === 'json' || format === 'xml' || format === 'xlsx') {
      await importStructuredData(node, format, '', deps, undefined, uri[0].fsPath);
      return;
    }
    const raw = await vscode.workspace.fs.readFile(uri[0]);
    const text = Buffer.from(raw).toString('utf8');
    if (format === 'sql') {
      await importSqlScript(node, text, deps);
      return;
    }
    if (format === 'txt') return; // txt 仅导出
    await importStructuredData(node, format, text, deps);
  });

  sub('devbelt.exportConnection', async (node: DbTreeNode) => {
    if (!node?.conn) return;

    await runExportWizard(node, manager, connCtx);
  });

  sub('devbelt.restoreDatabase', async (node: DbTreeNode) => {
    if (!node?.conn) return;
    const conn = node.conn;
    if (!ensureWritable(conn)) return;
    const uri = await vscode.window.showOpenDialog({
      filters: { 'SQL Files': ['sql'] },
      canSelectMany: false,
      openLabel: l10n('restore.selectFile'),
    });
    if (!uri?.length) return;
    // 恢复自身用事务包裹，但 MySQL 的 DDL 会隐式提交：中途失败无法回滚已执行的
    // CREATE/ALTER/DROP。确认框必须讲清楚，避免用户以为失败即「什么都没变」。
    const restoreBtn = l10n('restore.confirmAction');
    const confirmed = await vscode.window.showWarningMessage(
      l10n('restore.confirm', { database: node.database ?? node.conn.database ?? '' }),
      { modal: true },
      restoreBtn,
    );
    if (confirmed !== restoreBtn) return;
    const session = await manager.connectSql(node.conn, node.database);
    // 流式读取 + 增量切分：过去整文件读进内存再一次性切分，GB 级 dump 会 OOM。
    const rawStatements = streamSqlStatements(uri[0].fsPath, manager.scanOptionsFor?.(node.conn));
    // PG 无 USE：dump 里不带 schema 的语句默认落到 search_path 的 schema。恢复事务由
    // BackupService.restore 自己 BEGIN，故把 `SET LOCAL` 作为首个语句注入（事务内生效）。
    const schema = pgSchemaFor(conn, node.schema);
    const statements = conn.dbType === DatabaseType.PG && schema
      ? (async function* () {
          yield `SET LOCAL search_path TO ${wrapIdentForConn(conn, validateIdent(schema))}`;
          yield* rawStatements;
        })()
      : rawStatements;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Restoring database...', cancellable: true },
      async (progress, token) => {
        let completed = 0;
        try {
          await BackupService.restore(session.query, statements, {
            onProgress: (p: any) => {
              completed = p.completed;
              progress.report({ message: `${p.completed}/${p.total}`, increment: 0 });
            },
            isCancelled: () => token.isCancellationRequested,
            // SQLite 的 CLI 驱动每查询独立进程，逐句执行时 BEGIN 会失效
            singleStatement: conn.dbType === DatabaseType.SQLITE,
          });
          await recordBulkHistory(
            deps, node.conn!,
            l10n('history.restore', { count: completed }),
            node.database || node.conn!.database,
          );
          vscode.window.showInformationMessage(l10n('restore.done', { count: completed }));
          treeProvider.refresh();
        } catch (err) {
          // 报出已执行条数：失败可能停在中途，用户需要知道目标库已改到什么程度。
          vscode.window.showErrorMessage(
            l10n('restore.failed', { count: completed, message: (err as Error).message }),
          );
        }
      },
    );
  });

  sub('devbelt.importTable', async (node: DbTreeNode) => {
    if (!node?.conn) return;
    const format = await pickFormat('import');
    if (!format) return;

    const uri = await vscode.window.showOpenDialog({
      filters: importFilters(format),
      canSelectMany: false,
      openLabel: l10n('import.selectFile'),
    });
    if (!uri?.[0]) return;
    if (format === 'csv' || format === 'json' || format === 'xml' || format === 'xlsx') {
      await importStructuredData(node, format, '', deps, node.label, uri[0].fsPath);
      return;
    }
    const raw = await vscode.workspace.fs.readFile(uri[0]);
    const text = Buffer.from(raw).toString('utf8');
    if (format === 'sql') {
      await importSqlScript(node, text, deps);
      return;
    }
    if (format === 'txt') return; // txt 仅导出
    await importStructuredData(node, format, text, deps, node.label);
  });

  sub('devbelt.exportTable', async (node: DbTreeNode) => {
    if (!node?.conn) return;

    await runExportWizard(node, manager, connCtx, node.label);
  });

  sub('devbelt.compareSchema', async (node: DbTreeNode) => {
    if (!node?.conn || !node?.database) return;
    if (node.conn.dbType === DatabaseType.REDIS) return; // SQL 专用：禁止 Redis 进入
    const session = await manager.connectSql(node.conn, node.database);
    if (!requireCapability(session, 'schemaSync')) return;
    // PG 连接绑定单个数据库（无 USE），同一连接上的「另一个库」取不到其元数据：
    // 对比会退化成拿库和自己比、恒输出无差异。明确拒绝，而不是给出误导结果。
    if (node.conn.dbType === DatabaseType.PG) {
      vscode.window.showWarningMessage(l10n('schema.pgCrossDbUnsupported'));
      return;
    }
    const targetDbs = (await session.metadata.getDatabases()).filter((d) => d !== node.database);
    if (!targetDbs.length) {
      vscode.window.showWarningMessage(l10n('compare.noOtherDatabases'));
      return;
    }
    const target = await vscode.window.showQuickPick(
      targetDbs.map((d) => ({ label: d, value: d })),
      { placeHolder: l10n('compare.chooseDatabase', { database: node.database ?? '' }) },
    );
    if (!target) return;

    const diffs = await SchemaDiffService.diff(session.metadata, node.database, session.metadata, target.value);
    const syncSql = await SchemaDiffService.generateSyncSql(diffs, target.value, session.table, node.database, session.query.dialect);
    const added = diffs.filter((d) => d.status === 'added').length;
    const removed = diffs.filter((d) => d.status === 'removed').length;
    const changed = diffs.filter((d) => d.status === 'changed').length;
    const header = `-- Diff: ${node.database} -> ${target.value} (${added} added, ${removed} removed, ${changed} changed)\n\n`;
    await openSqlDoc(header + syncSql);
  });

  sub('devbelt.syncDatabase', async (node: DbTreeNode) => {
    if (!node?.conn || !node?.database) return;
    if (node.conn.dbType === DatabaseType.REDIS) return; // SQL 专用：禁止 Redis 进入
    // 同 compareSchema：PG 无法在单连接上跨库同步结构（见上）。
    if (node.conn.dbType === DatabaseType.PG) {
      vscode.window.showWarningMessage(l10n('schema.pgCrossDbUnsupported'));
      return;
    }

    const conns = deps.store.getVisibleTreeData().connections.filter((c) => c.id !== node.conn!.id && c.dbType !== DatabaseType.REDIS);
    if (!conns.length) {
      vscode.window.showWarningMessage(l10n('sync.noOtherConnections'));
      return;
    }
    const target = await vscode.window.showQuickPick(
      conns.map((c) => ({ label: c.name || c.host, description: c.dbType, value: c })),
      { placeHolder: l10n('sync.chooseConnection', { database: node.database ?? '' }) },
    );
    if (!target) return;
    // 写的是**目标**连接，不是 node.conn —— 只读标记必须查目标，
    // 否则「只读」的连接可以作为同步目标被整库覆盖
    if (!ensureWritable(target.value)) return;
    const targetSession = await manager.connectSql(target.value);
    const targetDbs = await targetSession.metadata.getDatabases();
    const targetDb = await vscode.window.showQuickPick(
      targetDbs.map((d: string) => ({ label: d, value: d })),
      { placeHolder: l10n('sync.chooseDatabase') },
    );
    if (!targetDb) return;
    const syncBtn = l10n('sync.confirmAction');
    const confirmed = await vscode.window.showWarningMessage(
      l10n('sync.confirm', {
        database: node.database ?? '',
        target: targetDb.value,
        conn: target.value.name || target.value.host,
      }),
      { modal: true },
      syncBtn,
    );
    if (confirmed !== syncBtn) return;
    const sourceSession = await manager.connectSql(node.conn, node.database);
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: l10n('sync.progressTitle'), cancellable: true },
      async (progress, token) => {
        const result = await DataTransferService.transferDatabase(
          sourceSession.query, sourceSession.metadata, sourceSession.table, node.database!,
          targetSession.query, targetSession.metadata, targetDb.value,
          {
            onProgress: (p: { table: string; phase: string }) => progress.report({ message: `${p.table} (${p.phase})` }),
            isCancelled: () => token.isCancellationRequested,
          },
        );
        if (result.errors.length) {
          vscode.window.showWarningMessage(
            l10n('sync.doneErrors', { errors: result.errors.length, count: result.tablesSynced }),
          );
        } else {
          vscode.window.showInformationMessage(l10n('sync.done', { count: result.tablesSynced }));
        }
        await recordBulkHistory(
          deps, node.conn!,
          l10n('history.transfer', {
            source: node.database!,
            target: targetDb.value,
            count: result.tablesSynced,
          }),
          node.database!,
        );
        treeProvider.refresh();
      },
    );
  });
}

export async function runExportWizard(
  node: DbTreeNode,
  manager: Deps['manager'],
  connCtx: Deps['connCtx'],
  fixedTable?: string,
): Promise<void> {
  if (!node.conn) return;
  const format = await pickFormat('export');
  if (!format) return;
  const defaultSession = await manager.connectSql(node.conn);
  const database = await pickExportDatabase(node, defaultSession.metadata.getDatabases.bind(defaultSession.metadata));
  if (database === undefined && node.conn.dbType === DatabaseType.MYSQL && !node.database) return;
  const schema = pgSchemaFor(node.conn, node.schema);
  // B2：按选中的库取会话（PG 多库；其它引擎退化为同一主会话），元数据与导出都走它。
  const session = await manager.connectSql(node.conn, database);
  const tables = fixedTable ? [fixedTable] : await pickTables(session.metadata.getTables.bind(session.metadata), database, schema);
  if (!tables?.length) return;
  const exportContents = format === 'sql'
    ? (await vscode.window.showQuickPick(
      [
        { label: l10n('export.structureOnly'), value: { includeStructure: true, includeData: false } },
        { label: l10n('export.structureData'), value: { includeStructure: true, includeData: true } },
        { label: l10n('export.dataOnly'), value: { includeStructure: false, includeData: true } },
      ],
      { placeHolder: l10n('export.choose') },
    ))?.value
    : { includeStructure: false, includeData: true };
  if (!exportContents) return;
  const destination = tables.length === 1
    ? await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(exportFileName(tables[0], format)), filters: exportFilters(format) })
    : (await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: l10n('export.selectFolder') }))?.[0];
  if (!destination) return;
  connCtx.setLast(node.conn, database);
  const conn = node.conn;
  let version: string | undefined;
  try {
    const versionSql = conn.dbType === DatabaseType.MYSQL ? 'SELECT VERSION()' : conn.dbType === DatabaseType.PG ? 'SELECT version()' : 'select sqlite_version()';
    const vr = await session.query.query(versionSql);
    version = Object.values(vr.rows[0] ?? {})[0] as string | undefined;
  } catch { version = undefined; }
  const serverInfo = { name: conn.name, dbType: conn.dbType, host: conn.host, port: conn.port, version };
  const withBom = (format === 'csv' || format === 'txt')
    && vscode.workspace.getConfiguration('devbelt').get<boolean>('export.addUtf8Bom') === true;
  try {
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: l10n('export.progress'),
      cancellable: true,
    }, async (progress, token) => {
      for (let index = 0; index < tables.length; index++) {
        const table = tables[index];
        progress.report({ message: `${table} (${index + 1}/${tables.length})` });
        const target = tables.length === 1 ? destination : vscode.Uri.joinPath(destination, exportFileName(table, format));
        // 流式写盘：逐页读取、逐块写出，避免整表驻留内存。
        await writeChunksToFile(target.fsPath, (write) => writeTableExport({
          source: { query: session.query, metadata: session.metadata, table: session.table },
          format,
          table,
          database,
          schema,
          includeStructure: exportContents.includeStructure,
          includeData: exportContents.includeData,
          serverInfo,
          withBom,
          isCancelled: () => token.isCancellationRequested,
          onProgress: ({ rows }) => progress.report({ message: `${table}: ${rows} row(s)` }),
        }, write));
      }
    });
    AuditLogger.tryLog({
      action: 'export_data',
      connName: node.conn.name || node.conn.host,
      database,
      sql: `EXPORT ${format.toUpperCase()} ${tables.length} table(s): ${tables.join(', ')}`,
      rowCount: tables.length,
    });
    vscode.window.showInformationMessage(l10n('export.done', { count: tables.length }));
  } catch (error) {
    if (error instanceof TransferCancelledError) {
      vscode.window.showInformationMessage(l10n('transfer.cancelled'));
    } else {
      vscode.window.showErrorMessage(l10n('export.failed', { message: (error as Error).message }));
    }
  }
}

async function importSqlScript(
  node: DbTreeNode,
  sql: string,
  deps: Deps,
): Promise<void> {
  const { manager, treeProvider, connCtx } = deps;
  const conn = node.conn;
  if (!conn) return;
  if (!(await confirmSqlExecution(conn, sql, manager.scanOptionsFor?.(conn)))) return;
  const session = await manager.connectSql(conn, node.database);
  const database = node.database;
  const schema = pgSchemaFor(conn, node.schema);
  connCtx.setLast(conn, database);
  if (database && conn.dbType === DatabaseType.MYSQL) {
    await session.query.query(`USE ${wrapIdentForConn(conn, validateIdent(database))}`);
  }
  const txControl = /^(BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK|END)\s*;?\s*$/i;
  const statements = splitSqlStatements(sql, manager.scanOptionsFor?.(conn))
    .filter((st) => !txControl.test(st.trim()));
  // 脚本导入过去逐句直接执行，中途失败会留下半截数据。除 SQLite（CLI 驱动每句独立
  // 进程、无法跨语句事务）外，用事务包裹，失败整体回滚。MySQL 的 DDL 会隐式提交，
  // 仍无法完全原子，但 DML 脚本可回滚。
  const transactional = conn.dbType !== DatabaseType.SQLITE;
  let done = 0;
  let insertedRows = 0;
  let hasAffectedInfo = false;
  try {
    if (transactional) await session.query.query('BEGIN');
    // PG 无 USE：脚本里不带 schema 的 INSERT/CREATE 默认落到 search_path 的 schema。
    // 在事务内 `SET LOCAL search_path` 把上下文定到目标 schema（事务结束自动还原）。
    if (conn.dbType === DatabaseType.PG && schema) {
      await session.query.query(`SET LOCAL search_path TO ${wrapIdentForConn(conn, validateIdent(schema))}`);
    }
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: l10n('import.progress'), cancellable: true }, async (progress, token) => {
      for (const statement of statements) {
        if (token.isCancellationRequested) throw new TransferCancelledError();
        const result = await session.query.query(statement);
        done++;
        const upper = statement.trimStart().toUpperCase();
        if (upper.startsWith('INSERT') || upper.startsWith('REPLACE')) {
          if (typeof result.affectedRows === 'number') {
            hasAffectedInfo = true;
            insertedRows += result.affectedRows;
          } else {
            // SQLite 等无法从结果取 affectedRows 的驱动：按 INSERT 语句计数（近似）
            insertedRows++;
          }
        }
        progress.report({ message: `${done}/${statements.length}` });
      }
    });
    if (transactional) await session.query.query('COMMIT');
    const importedCount = hasAffectedInfo ? insertedRows : done;
    await recordBulkHistory(
      deps, conn,
      l10n('history.importScript', { count: done }),
      database, importedCount,
    );
    vscode.window.showInformationMessage(l10n('import.rowsDone', { count: importedCount }));
    treeProvider.refresh();
  } catch (error) {
    if (transactional) {
      try { await session.query.query('ROLLBACK'); } catch { /* 事务可能已被服务端结束 */ }
    }
    if (error instanceof TransferCancelledError) vscode.window.showInformationMessage(l10n('transfer.cancelled'));
    else vscode.window.showErrorMessage(l10n('import.failedStatement', { count: done, message: (error as Error).message }));
  }
}

async function importStructuredData(
  node: DbTreeNode,
  format: Exclude<TransferFormat, 'sql' | 'txt'>,
  text: string,
  deps: Deps,
  fixedTable?: string,
  filePath?: string,
): Promise<void> {
  const { manager, treeProvider, connCtx } = deps;
  const conn = node.conn;
  if (!conn) return;
  let source: { columns: string[]; rows: Record<string, unknown>[] };
  // 报错行号：带表头时首个数据行是文件第 2 行。xlsx 的表头恒为工作表第 1 行。
  let rowOffset = 0;
  // CSV/JSON/XML：只读表头 + 样本用于预览/映射，真正的导入走流式（见下方 importRowsStream）。
  let streamRows: (() => AsyncIterable<Record<string, unknown>>) | undefined;
  try {
    if (format === 'csv') {
      const header = await vscode.window.showQuickPick(
        [{ label: l10n('import.firstRowHeader'), value: true }, { label: l10n('import.noHeader'), value: false }],
        { placeHolder: l10n('import.headerChoice') },
      );
      if (!header) return;
      if (filePath) {
        source = await readCsvSample(filePath, header.value);
        streamRows = () => streamCsvRows(filePath, header.value);
      } else {
        source = parseCsv(text, header.value);
      }
      rowOffset = header.value ? 1 : 0;
    } else if (format === 'json') {
      if (filePath) {
        source = await readJsonSample(filePath);
        streamRows = () => streamJsonRows(filePath);
      } else {
        source = parseJson(text);
      }
    } else if (format === 'xlsx') {
      rowOffset = 1;
      if (filePath) {
        source = await readXlsxSample(filePath);
        streamRows = () => streamXlsxRows(filePath);
      } else {
        const parsed = parseXlsx(Buffer.from(text, 'base64'));
        source = { columns: parsed.length ? Object.keys(parsed[0]) : [], rows: parsed };
      }
    } else if (format === 'xml') {
      if (filePath) {
        source = await readXmlSample(filePath);
        streamRows = () => streamXmlRows(filePath);
      } else {
        const parsed = parseXml(text);
        source = { columns: parsed.length ? Object.keys(parsed[0]) : [], rows: parsed };
      }
    } else {
      throw new Error(`Unsupported format: ${format}`);
    }
  } catch (error) {
    vscode.window.showErrorMessage(l10n('import.parseFailed', { message: (error as Error).message }));
    return;
  }
  if (!source.rows.length) {
    vscode.window.showWarningMessage(l10n('import.noRows'));
    return;
  }
  const defaultSession = await manager.connectSql(conn);
  const database = await pickImportDatabase(node, defaultSession.metadata.getDatabases.bind(defaultSession.metadata));
  if (database === undefined && conn.dbType === DatabaseType.MYSQL && !node.database) return;
  const schema = pgSchemaFor(conn, node.schema);
  // B2：按选中的库取会话（PG 多库；其它引擎退化为同一主会话）。
  const session = await manager.connectSql(conn, database);
  const tables = await session.metadata.getTables(database, schema);
  const table = fixedTable
    ? { label: fixedTable }
    : await vscode.window.showQuickPick(tables.map((item) => ({ label: item.name })), { placeHolder: l10n('import.selectTable') });
  if (!table) return;
  const mappings = await configureMappings(source.columns, (await session.metadata.getColumns(table.label, database, schema)).map((column) => column.name));
  if (!mappings) return;
  const selected = mappings.filter((mapping) => mapping.target);
  if (!selected.length) return;
  const preview = l10n('import.preview', { rows: source.rows.length, fields: selected.map((mapping) => `${mapping.source} -> ${mapping.target}`).join(', ') });
  const run = await vscode.window.showWarningMessage(preview, { modal: true }, l10n('import.run'));
  if (run !== l10n('import.run')) return;
  const firstTarget = selected[0].target;
  if (!firstTarget) return;
  const insertPreview = session.query.dialect.buildInsertSql([{ [firstTarget]: source.rows[0][selected[0].source] }], [firstTarget], table.label, database, schema);
  if (!(await confirmSqlExecution(conn, insertPreview, manager.scanOptionsFor?.(conn)))) return;
  connCtx.setLast(conn, database);
  try {
    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: l10n('import.progress'), cancellable: true }, (progress, token) => {
      const common = {
        query: session.query,
        table: table.label,
        database,
        schema,
        mappings,
        batchWrites: conn.dbType === DatabaseType.SQLITE,
        rowOffset,
        isCancelled: () => token.isCancellationRequested,
        onProgress: ({ completed, total }: { completed: number; total: number }) => progress.report({ message: `${completed}/${total}`, increment: total ? 100 / total : 0 }),
      };
      // CSV 流式：逐行解析+插入，不整文件驻留；其余格式沿用数组导入。
      return streamRows
        ? importRowsStream({ ...common, rows: streamRows() })
        : importRows({ ...common, rows: source.rows });
    });
    if (result.errors.length) {
      await showImportReport(result.errors[0].row, result.errors[0].message);
      vscode.window.showErrorMessage(l10n('import.rolledBack', { row: result.errors[0].row }));
      return;
    }
    AuditLogger.tryLog({
      action: 'import_data',
      connName: conn.name || conn.host,
      database,
      sql: `IMPORT INTO ${table.label} (${result.imported} row(s))`,
      rowCount: result.imported,
    });
    await recordBulkHistory(
      deps, conn,
      l10n('history.importRows', { table: table.label, count: result.imported }),
      database, result.imported,
    );
    treeProvider.refresh();
    vscode.window.showInformationMessage(l10n('import.rowsDone', { count: result.imported }));
  } catch (error) {
    if (error instanceof TransferCancelledError) vscode.window.showInformationMessage(l10n('transfer.cancelled'));
    else vscode.window.showErrorMessage(l10n('import.failed', { message: (error as Error).message }));
  }
}

async function configureMappings(sourceColumns: string[], targetColumns: string[]): Promise<FieldMapping[] | undefined> {
  const mappings = autoMapFields(sourceColumns, targetColumns);
  for (const mapping of mappings) {
    const used = new Set(mappings.filter((item) => item !== mapping).map((item) => item.target).filter(Boolean));
    const choice = await vscode.window.showQuickPick(
      [
        { label: l10n('import.skipField'), value: undefined as string | undefined },
        ...targetColumns.filter((column) => !used.has(column)).map((column) => ({ label: column, value: column })),
      ],
      { placeHolder: `${mapping.source} -> ${mapping.target || l10n('import.skipField')}` },
    );
    if (!choice) return undefined;
    mapping.target = choice.value;
  }
  return mappings.some((mapping) => mapping.target) ? mappings : undefined;
}

async function pickImportDatabase(node: DbTreeNode, getDatabases: () => Promise<string[]>): Promise<string | undefined> {
  if (node.database) return node.database;
  const databases = await getDatabases();
  if (!databases.length) return undefined;
  return vscode.window.showQuickPick(databases, { placeHolder: l10n('import.selectDatabase') });
}

async function pickExportDatabase(node: DbTreeNode, getDatabases: () => Promise<string[]>): Promise<string | undefined> {
  if (node.database) return node.database;
  const databases = await getDatabases();
  if (!databases.length) return undefined;
  return vscode.window.showQuickPick(databases, { placeHolder: l10n('export.selectDatabase') });
}

async function pickTables(getTables: (database?: string, schema?: string) => Promise<{ name: string }[]>, database?: string, schema?: string): Promise<string[] | undefined> {
  const tables = await getTables(database, schema);
  const chosen = await vscode.window.showQuickPick(tables.map((item) => ({ label: item.name, picked: true })), {
    canPickMany: true,
    placeHolder: l10n('export.selectTables'),
  });
  return chosen?.map((item) => item.label);
}

function importFilters(format: TransferFormat): Record<string, string[]> {
  if (format === 'csv') return { CSV: ['csv'] };
  if (format === 'json') return { JSON: ['json'] };
  if (format === 'xlsx') return { Excel: ['xlsx'] };
  if (format === 'xml') return { XML: ['xml'] };
  return { 'SQL scripts': ['sql'] };
}

async function pickFormat(action: 'import' | 'export'): Promise<TransferFormat | undefined> {
  // Excel 由 data/transfer/xlsx.ts 自行读写（Node 内置 zlib），不再依赖可选包，
  // 因此恒定提供 —— 过去该选项挂在未安装的 `xlsx` 包上，实际永远不出现。
  const items: { label: string; description: string; value: TransferFormat }[] = [
    { label: 'SQL', description: action === 'import' ? l10n('import.formatSql') : l10n('export.formatSql'), value: 'sql' },
    { label: 'CSV', description: action === 'import' ? l10n('import.formatCsv') : l10n('export.formatCsv'), value: 'csv' },
    { label: 'JSON', description: action === 'import' ? l10n('import.formatJson') : l10n('export.formatJson'), value: 'json' },
    // Text（.txt，制表符分隔）仅导出提供；导入不支持。
    ...(action === 'export' ? [{ label: 'Text', description: '.txt', value: 'txt' as const }] : []),
    { label: 'Excel', description: '.xlsx', value: 'xlsx' },
    { label: 'XML', description: '.xml', value: 'xml' },
  ];
  return (await vscode.window.showQuickPick(
    items,
    { placeHolder: action === 'import' ? l10n('import.chooseFormat') : l10n('export.chooseFormat') },
  ))?.value;
}

async function showImportReport(row: number, message: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({
    language: 'plaintext',
    content: `Import rolled back.\n\nFirst failing source row: ${row}\nError: ${message}\n`,
  });
  await vscode.window.showTextDocument(doc, { preview: false });
}

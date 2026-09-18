import { describe, expect, it, vi } from 'vitest';

// auditLogger → utils/diagnostics → vscode。
vi.mock('vscode', () => ({
  window: { createOutputChannel: () => ({ info: () => {}, warn: () => {}, error: () => {}, dispose: () => {} }) },
}));
import { AuditLogger, type AuditAction } from '../../src/utils/auditLogger';

function memento() {
  const store = new Map<string, unknown>();
  return {
    get: <T>(k: string, d?: T): T => (store.has(k) ? store.get(k) as T : d as T),
    update: async (k: string, v: unknown): Promise<void> => { store.set(k, v); },
  } as any;
}

describe('AuditLogger', () => {
  it('log 后可读回，最新在前', () => {
    const logger = AuditLogger.init(memento());
    logger.log({ action: 'query_execute', connName: 'a' });
    logger.log({ action: 'data_edit', connName: 'b' });

    const entries = logger.getEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0].action).toBe('data_edit');
    expect(entries[1].action).toBe('query_execute');
  });

  it('id 唯一（同毫秒批量写入不覆盖）', () => {
    const logger = AuditLogger.init(memento());
    for (let i = 0; i < 200; i++) logger.log({ action: 'query_execute', connName: 'a' });
    const ids = logger.getEntries(500).map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('按 action 过滤', () => {
    const logger = AuditLogger.init(memento());
    logger.log({ action: 'query_execute', connName: 'a' });
    logger.log({ action: 'schema_change', connName: 'a' });
    logger.log({ action: 'query_execute', connName: 'a' });

    expect(logger.getEntries(100, 'query_execute')).toHaveLength(2);
    expect(logger.getEntries(100, 'schema_change')).toHaveLength(1);
    expect(logger.getEntries(100, 'user_manage')).toHaveLength(0);
  });

  it('limit 生效', () => {
    const logger = AuditLogger.init(memento());
    for (let i = 0; i < 10; i++) logger.log({ action: 'query_execute', connName: 'a' });
    expect(logger.getEntries(3)).toHaveLength(3);
  });

  it('clear 清空', () => {
    const logger = AuditLogger.init(memento());
    logger.log({ action: 'query_execute', connName: 'a' });
    logger.clear();
    expect(logger.getEntries()).toHaveLength(0);
  });

  /**
   * tryLog / tryGet 是给旁路写入点用的：审计拿不到实例不该让主流程失败，
   * 也不该逼每个调用点包 try/catch getInstance()。
   */
  it('tryLog 在已初始化时写入', () => {
    const logger = AuditLogger.init(memento());
    AuditLogger.tryLog({ action: 'connection_open', connName: 'a' });
    expect(logger.getEntries()).toHaveLength(1);
  });

  it('tryGet 返回当前实例', () => {
    const logger = AuditLogger.init(memento());
    expect(AuditLogger.tryGet()).toBe(logger);
  });

  /** 11 种动作全部可写入（曾只有 query_execute 有写入点）。 */
  it('11 种 AuditAction 都能记录', () => {
    const logger = AuditLogger.init(memento());
    const actions: AuditAction[] = [
      'query_execute', 'query_explain', 'data_edit', 'data_delete', 'data_insert',
      'schema_change', 'connection_open', 'connection_close', 'user_manage',
      'import_data', 'export_data',
    ];
    for (const action of actions) logger.log({ action, connName: 'a' });

    const recorded = logger.getEntries(100).map((e) => e.action);
    for (const action of actions) expect(recorded).toContain(action);
  });
});

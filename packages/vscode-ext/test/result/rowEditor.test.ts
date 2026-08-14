import { describe, expect, it, vi } from 'vitest';
import { RowEditor } from '../../src/result/rowEditor';
import { DataChangeEvent, eventBus } from '../../src/utils/event';
import { AuditLogger } from '../../src/utils/auditLogger';

vi.mock('vscode', () => ({ window: { showErrorMessage: () => {} } }));

const conn: any = { id: 'c1', database: 'test', dbType: 'MYSQL', host: 'h', name: 'n', readOnly: false, environment: 'development' };

function makeEditor(manager: any): { editor: RowEditor; posted: any[]; refreshes: { count: number } } {
  const posted: any[] = [];
  const refreshes = { count: 0 };
  const editor = new RowEditor(manager, conn, 'users', 'test', (m) => posted.push(m), {
    refresh: async () => { refreshes.count++; },
  });
  return { editor, posted, refreshes };
}

describe('RowEditor', () => {
  it('updateCell 委托 DataService 并回报 cellUpdated', async () => {
    const data = { updateCell: async (t: string, pkCols: string[], pkVals: any[], col: string, val: any) => { expect([t, pkCols, pkVals, col, val]).toEqual(['users', ['id'], [5], 'name', 'x']); } };
    const manager: any = { connect: async () => ({ data }) };
    const { editor, posted, refreshes } = makeEditor(manager);
    await editor.updateCell(['id'], [5], 'name', 'x');
    expect(posted).toContainEqual({ type: 'cellUpdated' });
    expect(refreshes.count).toBe(1);
  });

  it('无定位列时不执行更新并报错', async () => {
    const called: boolean[] = [];
    const manager: any = { connect: async () => ({ data: { updateCell: async () => { called.push(true); } } }) };
    const { editor, posted } = makeEditor(manager);
    await editor.updateCell([], [], 'name', 'x');
    expect(called).toEqual([]);
    expect(posted.some((m) => m.type === 'error')).toBe(true);
  });

  it('insertRow 后触发刷新', async () => {
    const data = { insertRow: async () => {} };
    const manager: any = { connect: async () => ({ data }) };
    const { editor, refreshes } = makeEditor(manager);
    await editor.insertRow(['name'], ['x']);
    expect(refreshes.count).toBe(1);
  });

  it('deleteRows 委托原子删除并触发刷新', async () => {
    const data = { deleteRows: async (_t: string, _pkCols: string[], rows: any[][]) => { expect(rows).toEqual([[1], [2]]); } };
    const manager: any = { connect: async () => ({ data }) };
    const { editor, posted, refreshes } = makeEditor(manager);
    await editor.deleteRows([{ pkColumns: ['id'], pkValues: [1] }, { pkColumns: ['id'], pkValues: [2] }]);
    expect(posted).toContainEqual({ type: 'rowsDeleted', count: 2 });
    expect(refreshes.count).toBe(1);
  });
});
/**
 * 回归：数据编辑必须发 DataChangeEvent 并写审计。
 * 二者此前都没有任何写入点：DataChangeEvent 只有类型定义，
 * 审计日志只记查询执行，改了哪一行完全不留痕。
 */
describe('RowEditor 事件与审计', () => {
  function memento() {
    const store = new Map<string, unknown>();
    return {
      get: <T>(k: string, d?: T): T => (store.has(k) ? store.get(k) as T : d as T),
      update: async (k: string, v: unknown): Promise<void> => { store.set(k, v); },
    } as any;
  }

  it('updateCell 发布 DataChangeEvent(update) 并记 data_edit', async () => {
    const logger = AuditLogger.init(memento());
    const events: DataChangeEvent[] = [];
    const sub = eventBus.subscribe(DataChangeEvent, (e) => { events.push(e); });

    const manager: any = { connect: async () => ({ data: { updateCell: async () => {} } }) };
    const { editor } = makeEditor(manager);
    await editor.updateCell(['id'], [5], 'name', 'x');
    sub.dispose();

    expect(events).toHaveLength(1);
    expect(events[0].operation).toBe('update');
    expect(events[0].table).toBe('users');
    expect(logger.getEntries().map((e) => e.action)).toContain('data_edit');
  });

  it('deleteRows 记 data_delete 且 rowCount 为删除行数', async () => {
    const logger = AuditLogger.init(memento());
    const manager: any = { connect: async () => ({ data: { deleteRows: async () => {} } }) };
    const { editor } = makeEditor(manager);
    await editor.deleteRows([
      { pkColumns: ['id'], pkValues: [1] },
      { pkColumns: ['id'], pkValues: [2] },
    ]);

    const entry = logger.getEntries().find((e) => e.action === 'data_delete');
    expect(entry).toBeDefined();
    expect(entry!.rowCount).toBe(2);
  });

  it('insertRow 记 data_insert', async () => {
    const logger = AuditLogger.init(memento());
    const manager: any = { connect: async () => ({ data: { insertRow: async () => {} } }) };
    const { editor } = makeEditor(manager);
    await editor.insertRow(['name'], ['x']);

    expect(logger.getEntries().map((e) => e.action)).toContain('data_insert');
  });

  it('操作失败时不发事件、不写审计', async () => {
    const logger = AuditLogger.init(memento());
    const events: DataChangeEvent[] = [];
    const sub = eventBus.subscribe(DataChangeEvent, (e) => { events.push(e); });

    const manager: any = { connect: async () => ({ data: { updateCell: async () => { throw new Error('boom'); } } }) };
    const { editor, posted } = makeEditor(manager);
    await editor.updateCell(['id'], [5], 'name', 'x');
    sub.dispose();

    expect(posted.some((m) => m.type === 'error')).toBe(true);
    expect(events).toHaveLength(0);
    expect(logger.getEntries()).toHaveLength(0);
  });
});
import { describe, expect, it, vi } from 'vitest';
import { RowEditor } from '../../src/result/rowEditor';

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
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  window: {
    createOutputChannel: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), dispose: vi.fn() }),
  },
  LogOutputChannel: class {},
}));

import { CompletionService } from '../../src/result/completionService';

const conn: any = { id: 'c1', database: 'test', dbType: 'MYSQL', host: 'h', name: 'n' };
const table = { name: 'users' };
const column = { name: 'name' };

function makeService(manager: any, post: (msg: any) => void): CompletionService {
  return new CompletionService(manager, conn, 'test', post);
}

describe('CompletionService', () => {
  it('返回表名候选（FROM 后）', async () => {
    const manager: any = { connectSql: async () => ({ metadata: { getTables: async () => [table], getColumns: async () => [column] } }) };
    const posted: any[] = [];
    const svc = makeService(manager, (m) => posted.push(m));
    await svc.handle('SELECT * FROM ', 'SELECT * FROM ');
    expect(posted[0].type).toBe('completionItems');
    expect(posted[0].items.map((c: any) => c.label)).toContain('users');
    expect(posted[0].items.every((c: any) => c.kind === 'table')).toBe(true);
  });

  it('缓存表列表，避免重复查询元数据', async () => {
    let calls = 0;
    const manager: any = { connectSql: async () => ({ metadata: { getTables: async () => { calls++; return [table]; }, getColumns: async () => [column] } }) };
    const posted: any[] = [];
    const svc = makeService(manager, (m) => posted.push(m));
    await svc.handle('SELECT * FROM ', 'SELECT * FROM ');
    await svc.handle('SELECT * FROM ', 'SELECT * FROM ');
    expect(calls).toBe(1);
  });

  it('元数据异常时返回空候选而非抛错', async () => {
    const manager: any = { connectSql: async () => ({ metadata: { getTables: async () => { throw new Error('boom'); }, getColumns: async () => [column] } }) };
    const posted: any[] = [];
    const svc = makeService(manager, (m) => posted.push(m));
    await svc.handle('SELECT * FROM ', 'SELECT * FROM ');
    expect(posted[0].type).toBe('completionItems');
    expect(posted[0].items).toEqual([]);
  });
});
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  window: {
    showErrorMessage: () => {},
    showWarningMessage: async () => 'Run SQL',
    createOutputChannel: () => ({ appendLine: () => {}, error: () => {}, warn: () => {}, info: () => {}, dispose: () => {}, show: () => {} }),
  },
}));

import { QueryRunner } from '../../src/result/queryRunner';
import { AiSqlRegistry } from '../../src/ai/aiSqlRegistry';

const conn: any = { id: 'c1', database: 'test', dbType: 'MYSQL', host: 'h', name: 'n', readOnly: false, environment: 'development' };

function makeRunner(opts: {
  queryImpl: (sql: string) => Promise<unknown>;
}): { runner: QueryRunner; posted: any[] } {
  const session: any = {
    query: { query: vi.fn(opts.queryImpl), wrap: (id: string) => `\`${id}\``, cancel: () => true },
    metadata: { getColumns: async () => [] },
  };
  const manager: any = {
    connectSql: vi.fn(async () => session),
    peekSql: () => session,
    disposeConn: () => {},
    scanOptionsFor: () => undefined,
  };
  const posted: any[] = [];
  const runner = new QueryRunner(conn, manager, 'users', 'test', (msg) => posted.push(msg));
  return { runner, posted };
}

describe('QueryRunner · P9 S4 AI 附加字段', () => {
  it('错误：干净 message/sql → sqlForAi 原样 + dbType/costTime/askAi/secretRisk=false', async () => {
    const { runner, posted } = makeRunner({
      queryImpl: async () => {
        throw new Error('Unknown column x');
      },
    });
    await runner.execute('SELECT x FROM t');
    const error = posted.find((m) => m.type === 'error');
    expect(error).toMatchObject({
      message: 'Unknown column x',
      sqlForAi: 'SELECT x FROM t',
      dbType: 'MYSQL',
      askAi: true,
      secretRisk: false,
    });
    expect(typeof error.costTime).toBe('number');
  });

  it('错误：message 含口令字面量 → sqlForAi=null + secretRisk=true（阻断发送）', async () => {
    const { runner, posted } = makeRunner({
      queryImpl: async () => {
        throw new Error("Access denied; WITH PASSWORD 'hunter2' rejected");
      },
    });
    await runner.execute('SELECT 1');
    const error = posted.find((m) => m.type === 'error');
    expect(error.secretRisk).toBe(true);
    expect(error.sqlForAi).toBeNull();
  });

  it('错误：SQL 含口令模式 → sqlForAi=null', async () => {
    const { runner, posted } = makeRunner({
      queryImpl: async () => {
        throw new Error('syntax error');
      },
    });
    await runner.execute("CREATE USER u IDENTIFIED BY 'pw'");
    const error = posted.find((m) => m.type === 'error');
    expect(error.secretRisk).toBe(true);
    expect(error.sqlForAi).toBeNull();
  });

  it('结果：AI 标记的 SQL → aiGenerated=true；未标记 false', async () => {
    AiSqlRegistry.init();
    try {
      const first = makeRunner({ queryImpl: async () => ({ rows: [{ id: 1 }], fields: [{ name: 'id' }] }) });
      await first.runner.execute('SELECT * FROM users');
      expect(first.posted.find((m) => m.type === 'result')?.aiGenerated).toBe(false);

      AiSqlRegistry.tryMark('SELECT * FROM users');
      const second = makeRunner({ queryImpl: async () => ({ rows: [{ id: 1 }], fields: [{ name: 'id' }] }) });
      await second.runner.execute('SELECT * FROM users');
      expect(second.posted.find((m) => m.type === 'result')?.aiGenerated).toBe(true);
    } finally {
      AiSqlRegistry.reset();
    }
  });
});
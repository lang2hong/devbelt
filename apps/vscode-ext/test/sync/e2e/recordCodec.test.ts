import { describe, expect, it } from 'vitest';
import { DatabaseType } from '@devbelt/db-core';
import {
  encodeEntityPayload,
  encodeRecordPayload,
  decodeEntityPayload,
  decodeRecordPayload,
  openRecord,
  recordAad,
  sealRecord,
  SQL_MAX_BYTES,
} from '@devbelt/db-host/sync/e2e/recordCodec';

const noRef = () => undefined;

describe('encodeEntityPayload 按引擎白名单 + type 判别', () => {
  it('MySQL 只保留白名单+路径字段，剔除 id/时间戳/deleted；dbType 归一为 engine，含 type', () => {
    const conn = {
      id: 'c-1', name: 'n', dbType: DatabaseType.MYSQL, host: 'h', port: 3306, user: 'u', password: 'p',
      database: 'db', schema: 's', timezone: 'tz', groupId: 'g',
      environment: 'development', readOnly: false, useConnectionString: false,
      useSSL: false, caPath: '/ca', clientCertPath: '/cert', clientKeyPath: '/key', socketPath: '/sock',
      sshHost: 'ssh', sshPort: 22, sshUser: 'su', sshPassword: 'sp', sshPrivateKeyPath: '/sshkey', sshPassphrase: 'pp',
      dbPath: '/db', createTime: 1, updateTime: 2, deleted: false,
    } as any;
    const out = encodeRecordPayload(conn, noRef);
    expect(out.type).toBe('connection');
    expect(out).not.toHaveProperty('id');
    expect(out).not.toHaveProperty('createTime');
    expect(out).not.toHaveProperty('deleted');
    expect(out.password).toBe('p');
    expect(out.dbType).toBe('mysql');
    // 路径字段同步（D1）
    expect(out).toHaveProperty('caPath', '/ca');
    expect(out).toHaveProperty('sshPrivateKeyPath', '/sshkey');
    // groupId 在无 resolver 时省略（unresolved）
    expect(out).not.toHaveProperty('groupId');
  });

  it('SQLite payload 仅 SQLite 字段，无 host/port/user/ssh', () => {
    const conn = {
      id: 'c-2', name: 'sq', dbType: DatabaseType.SQLITE, password: 'p', database: 'db',
      timezone: 'tz', environment: 'development', readOnly: false, useSSL: false,
      host: '', port: 0, user: '', dbPath: '/db', createTime: 1, updateTime: 2, deleted: false,
    } as any;
    const out = encodeRecordPayload(conn, noRef);
    expect(out.type).toBe('connection');
    expect(out.dbType).toBe('sqlite');
    expect(out).not.toHaveProperty('host');
    expect(out).not.toHaveProperty('port');
    expect(out).not.toHaveProperty('user');
    expect(out).not.toHaveProperty('sshHost');
    expect(out).toHaveProperty('dbPath', '/db');
  });

  it('SQLite 编码时引擎专属字段非空 fail-closed', () => {
    const base = { id: 'c-3', name: 'sq', dbType: DatabaseType.SQLITE, dbPath: '/db' } as any;
    expect(() => encodeRecordPayload({ ...base, host: 'localhost' })).toThrowError(/host/);
    expect(() => encodeRecordPayload({ ...base, port: 3306 })).toThrowError(/port/);
    expect(() => encodeRecordPayload({ ...base, user: 'root' })).toThrowError(/user/);
    expect(() => encodeRecordPayload({ ...base, useSSL: true })).toThrowError(/useSSL/);
    expect(() => encodeRecordPayload({ ...base, sshHost: 'ssh' })).toThrowError(/sshHost/);
  });

  it('SQLite 空值（host:""/port:0/useSSL:false）不抛错', () => {
    const conn = { id: 'c-4', name: 'sq', dbType: DatabaseType.SQLITE, host: '', port: 0, user: '', useSSL: false, dbPath: '/db' } as any;
    expect(() => encodeRecordPayload(conn)).not.toThrow();
  });

  it('P8：ES 连接编/解码显式 fail-closed（同步 codec 未支持）', () => {
    const conn = { id: 'c-es', name: 'es', dbType: DatabaseType.ELASTICSEARCH, host: 'h', port: 9200, user: '', createTime: 1, updateTime: 2, deleted: false } as any;
    expect(() => encodeRecordPayload(conn)).toThrowError(/elasticsearch connections are not syncable yet/);
    expect(() => decodeEntityPayload({ type: 'connection', dbType: 'elasticsearch', name: 'es', host: 'h', port: 9200, user: '' }))
      .toThrowError(/elasticsearch connections are not syncable yet/);
  });

  it('groupId 经 resolver 转 recordId 引用', () => {
    const conn = { id: 'c-5', name: 'n', dbType: DatabaseType.MYSQL, host: 'h', port: 3306, user: 'u', groupId: 'g-1' } as any;
    const out = encodeRecordPayload(conn, (_type, localId) => (localId === 'g-1' ? 'R'.repeat(22) : undefined));
    expect(out.groupId).toBe('R'.repeat(22));
  });
});

describe('encodeEntityPayload 分组/文件夹/查询', () => {
  it('group：name + parentId(recordId)，根为 undefined', () => {
    const out = encodeEntityPayload({ type: 'group', entity: { id: 'g-1', name: 'Root' } as any }, noRef);
    expect(out).toEqual({ type: 'group', name: 'Root' });
    const child = encodeEntityPayload({ type: 'group', entity: { id: 'g-2', name: 'Child', parentId: 'g-1' } as any }, (_t, id) => (id === 'g-1' ? 'R'.repeat(22) : undefined));
    expect(child).toEqual({ type: 'group', name: 'Child', parentId: 'R'.repeat(22) });
  });

  it('queryFolder：name + connId(recordId)', () => {
    const out = encodeEntityPayload({ type: 'queryFolder', entity: { id: 'qf-1', name: 'F', connId: 'c-1' } as any }, (_t, id) => (id === 'c-1' ? 'C'.repeat(22) : undefined));
    expect(out).toEqual({ type: 'queryFolder', name: 'F', connId: 'C'.repeat(22) });
  });

  it('query：name/sql/database + connId/folderId(recordId)', () => {
    const out = encodeEntityPayload({
      type: 'query',
      entity: { id: 'q-1', name: 'Q', sql: 'SELECT 1', database: 'app', connId: 'c-1', folderId: 'qf-1' } as any,
    }, (_t, id) => (id === 'c-1' ? 'C'.repeat(22) : id === 'qf-1' ? 'F'.repeat(22) : undefined));
    expect(out).toEqual({ type: 'query', name: 'Q', sql: 'SELECT 1', database: 'app', connId: 'C'.repeat(22), folderId: 'F'.repeat(22) });
  });

  it('query.sql UTF-8 超 64 KiB fail-closed', () => {
    const big = '中'.repeat(25000); // 3 bytes each = 75000 bytes
    expect(() => encodeEntityPayload({ type: 'query', entity: { id: 'q-1', name: 'Q', sql: big, connId: 'c-1' } as any }, noRef))
      .toThrowError(/64 KiB/);
  });

  it('query.sql 恰好 64 KiB 边界内可通过', () => {
    const ok = 'a'.repeat(SQL_MAX_BYTES);
    expect(() => encodeEntityPayload({ type: 'query', entity: { id: 'q-1', name: 'Q', sql: ok, connId: 'c-1' } as any }, noRef)).not.toThrow();
  });
});

describe('decodeEntityPayload', () => {
  it('connection 还原 dbType + type 判别', () => {
    const d = decodeEntityPayload({ type: 'connection', name: 'n', dbType: 'mysql', host: 'h', port: 3306, user: 'u' });
    expect(d.type).toBe('connection');
    expect(d).toMatchObject({ type: 'connection', data: { name: 'n', dbType: DatabaseType.MYSQL, host: 'h', port: 3306, user: 'u' } });
  });

  it('group/queryFolder/query 解码', () => {
    expect(decodeEntityPayload({ type: 'group', name: 'G', parentId: 'R'.repeat(22) })).toEqual({ type: 'group', data: { name: 'G', parentId: 'R'.repeat(22) } });
    expect(decodeEntityPayload({ type: 'queryFolder', name: 'F', connId: 'C'.repeat(22) })).toEqual({ type: 'queryFolder', data: { name: 'F', connId: 'C'.repeat(22) } });
    expect(decodeEntityPayload({ type: 'query', name: 'Q', sql: 'SELECT 1' })).toEqual({ type: 'query', data: { name: 'Q', sql: 'SELECT 1' } });
  });

  it('无法识别 type fail-closed', () => {
    expect(() => decodeEntityPayload({ type: 'widget', name: 'x' })).toThrowError(/unknown sync entity type/);
  });

  it('缺少 type fail-closed（v2 强制判别）', () => {
    expect(() => decodeRecordPayload({ name: 'n', dbType: 'mysql', host: 'h', port: 3306, user: 'u' })).toThrowError(/unknown sync entity type/);
  });

  it('decodeRecordPayload 仍解码 connection', () => {
    expect(decodeRecordPayload({ type: 'connection', name: 'n', dbType: 'mysql', host: 'h', port: 3306, user: 'u' })).toMatchObject({ name: 'n' });
  });

  it('SQL 超限 decode fail-closed', () => {
    expect(() => decodeEntityPayload({ type: 'query', name: 'Q', sql: '中'.repeat(25000) })).toThrowError(/64 KiB/);
  });

  it('未知 engine fail-closed', () => {
    expect(() => decodeRecordPayload({ type: 'connection', name: 'n', dbType: 'oracle', host: 'h' })).toThrowError(/unknown database engine/);
  });

  it('向前兼容（D14）：未知字段被忽略，不抛错', () => {
    // 新版本给 payload 增字段时，旧客户端不得整页失败；未知字段在 AEAD 密文内、无法注入。
    expect(decodeRecordPayload({ type: 'connection', name: 'n', dbType: 'mysql', host: 'h', port: 3306, user: 'u', futureField: 1 }))
      .toMatchObject({ name: 'n', host: 'h' });
  });
});

describe('recordAad', () => {
  it('purpose 恒为 record，含协议常量', () => {
    expect(recordAad({ userId: '7', keyEpoch: '1', recordId: 'r', recordVersion: '2' })).toEqual({
      userId: '7', keyEpoch: '1', recordId: 'r', recordVersion: '2',
      protocolVersion: 1, cipherSuite: 'AES-256-GCM', formatVersion: 1, purpose: 'record',
    });
  });
});

describe('seal/open record', () => {
  const dek = new Uint8Array(32).fill(1);
  const nonce = new Uint8Array(12).fill(2);
  const ctx = { userId: '7', keyEpoch: '1', recordId: 'r', recordVersion: '1' };

  it('roundtrip', () => {
    const pt = new TextEncoder().encode('payload');
    const box = sealRecord(dek, nonce, pt, ctx);
    expect(new TextDecoder().decode(openRecord(dek, nonce, box.ciphertext, box.tag, ctx))).toBe('payload');
  });

  it('AAD 不一致（recordVersion 变化）解密失败', () => {
    const box = sealRecord(dek, nonce, new Uint8Array([1, 2, 3]), ctx);
    expect(() => openRecord(dek, nonce, box.ciphertext, box.tag, { ...ctx, recordVersion: '2' })).toThrow();
  });
});
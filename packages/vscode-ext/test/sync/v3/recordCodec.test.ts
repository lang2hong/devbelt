import { describe, expect, it } from 'vitest';
import {
  RECORD_PAYLOAD_FIELDS,
  encodeRecordPayload,
  openRecord,
  recordAad,
  sealRecord,
} from '../../../src/sync/v3/recordCodec';

describe('encodeRecordPayload 白名单', () => {
  it('只保留白名单字段，剔除本机路径/id/时间戳/deleted；dbType 归一为 engine', () => {
    const conn = {
      id: 'c-1', name: 'n', dbType: 'MYSQL', host: 'h', port: 3306, user: 'u', password: 'p',
      database: 'db', schema: 's', timezone: 'tz', groupId: 'g',
      environment: 'development', readOnly: false, useConnectionString: false,
      useSSL: false, caPath: '/ca', clientCertPath: '/cert', clientKeyPath: '/key', socketPath: '/sock',
      sshHost: 'ssh', sshPort: 22, sshUser: 'su', sshPassword: 'sp', sshPrivateKeyPath: '/sshkey', sshPassphrase: 'pp',
      dbPath: '/db', createTime: 1, updateTime: 2, deleted: false,
    } as any;
    const out = encodeRecordPayload(conn);
    expect(Object.keys(out).sort()).toEqual([...RECORD_PAYLOAD_FIELDS].sort());
    expect(out).not.toHaveProperty('id');
    expect(out).not.toHaveProperty('dbPath');
    expect(out).not.toHaveProperty('sshPrivateKeyPath');
    expect(out).not.toHaveProperty('caPath');
    expect(out).not.toHaveProperty('createTime');
    expect(out).not.toHaveProperty('deleted');
    expect(out.password).toBe('p');
    expect(out.dbType).toBe('mysql');
  });

  it('connectionUrl/useConnectionString/sqliteCommand fail-closed（不含内容）', () => {
    const base = { name: 'n', dbType: 'MYSQL', host: 'h' } as any;
    expect(() => encodeRecordPayload({ ...base, connectionUrl: '/some/secret/url' })).toThrowError(/connectionUrl/);
    expect(() => encodeRecordPayload({ ...base, useConnectionString: true })).toThrowError(/useConnectionString/);
    expect(() => encodeRecordPayload({ ...base, sqliteCommand: '/usr/bin/sqlite3' })).toThrowError(/sqliteCommand/);
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
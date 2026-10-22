import { describe, expect, it } from 'vitest';
import {
  supportsConnectionUrl,
  validateConnectionForm,
  type ConnectionFormValidationInput,
} from '../../webview/src/utils/connectionFormValidation';

function input(overrides: Partial<ConnectionFormValidationInput> = {}): ConnectionFormValidationInput {
  return {
    dbType: 'MYSQL',
    host: 'localhost',
    port: '3306',
    dbPath: '',
    useConnectionString: false,
    connectionUrl: '',
    redisMode: 'standalone',
    clusterNodes: '',
    sentinelNodes: '',
    sentinelName: '',
    ...overrides,
  };
}

describe('supportsConnectionUrl', () => {
  it('只有 MySQL / PostgreSQL 支持连接串', () => {
    expect(supportsConnectionUrl('MYSQL')).toBe(true);
    expect(supportsConnectionUrl('PG')).toBe(true);
    expect(supportsConnectionUrl('SQLITE')).toBe(false);
    expect(supportsConnectionUrl('REDIS')).toBe(false);
    expect(supportsConnectionUrl('ELASTICSEARCH')).toBe(false);
  });
});

describe('validateConnectionForm', () => {
  it('SQLite 只要求文件路径', () => {
    expect(validateConnectionForm(input({ dbType: 'SQLITE' }))).toEqual({
      dbPath: 'wv.form.errSqlitePath',
    });
    expect(validateConnectionForm(input({ dbType: 'SQLITE', dbPath: '/tmp/app.db' }))).toEqual({});
  });

  it('SQL 校验 host 与端口范围', () => {
    expect(validateConnectionForm(input({ host: '  ' }))).toEqual({
      host: 'wv.form.errHost',
    });
    expect(validateConnectionForm(input({ port: '0' }))).toEqual({ port: 'wv.form.errPort' });
    expect(validateConnectionForm(input({ port: '65536' }))).toEqual({ port: 'wv.form.errPort' });
    expect(validateConnectionForm(input({ port: '3306' }))).toEqual({});
    // 编辑回填：SavedConnection.port 是 number，不能按字符串调用 trim。
    expect(validateConnectionForm(input({ port: 3306 }))).toEqual({});
  });

  it('连接串模式校验必填与协议', () => {
    expect(validateConnectionForm(input({ useConnectionString: true }))).toEqual({
      connectionUrl: 'wv.form.errUrlRequired',
    });
    expect(validateConnectionForm(input({ useConnectionString: true, connectionUrl: 'not a url' }))).toEqual({
      connectionUrl: 'wv.form.errUrlInvalid',
    });
    expect(validateConnectionForm(input({ useConnectionString: true, connectionUrl: 'postgres://u:p@h:5432/d' }))).toEqual({
      connectionUrl: 'wv.form.errUrlInvalid',
    });
    expect(validateConnectionForm(input({ useConnectionString: true, connectionUrl: 'mysql://u:p@h:3306/d' }))).toEqual({});
  });

  it('PostgreSQL 接受 postgres:// 与 postgresql://', () => {
    expect(validateConnectionForm(input({ dbType: 'PG', useConnectionString: true, connectionUrl: 'postgres://u:p@h/d' }))).toEqual({});
    expect(validateConnectionForm(input({ dbType: 'PG', useConnectionString: true, connectionUrl: 'postgresql://u:p@h/d' }))).toEqual({});
  });

  it('Redis cluster 需要节点列表', () => {
    expect(validateConnectionForm(input({ dbType: 'REDIS', redisMode: 'cluster' }))).toEqual({
      clusterNodes: 'wv.form.errClusterNodes',
    });
    expect(validateConnectionForm(input({
      dbType: 'REDIS',
      redisMode: 'cluster',
      clusterNodes: '10.0.0.1:6379,10.0.0.2:6379',
    }))).toEqual({});
  });

  it('Redis sentinel 需要节点与 master 名称', () => {
    expect(validateConnectionForm(input({ dbType: 'REDIS', redisMode: 'sentinel' }))).toEqual({
      sentinelNodes: 'wv.form.errSentinelNodes',
      sentinelName: 'wv.form.errSentinelName',
    });
    expect(validateConnectionForm(input({
      dbType: 'REDIS',
      redisMode: 'sentinel',
      sentinelNodes: '10.0.0.1:26379',
      sentinelName: 'mymaster',
    }))).toEqual({});
  });

  it('Elasticsearch 不要求 database / socket（输入中也没有这两个字段）', () => {
    expect(validateConnectionForm(input({ dbType: 'ELASTICSEARCH', port: '9200' }))).toEqual({});
  });
});
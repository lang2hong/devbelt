import { describe, expect, it } from 'vitest';
import { DatabaseType } from '@devbelt/db-core';
import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import { connectionTargetChanged } from '../../src/utils/connectionTarget';

function conn(over: Partial<SavedConnection> = {}): SavedConnection {
  return {
    id: 'c1', name: 'n', dbType: DatabaseType.MYSQL, host: 'h', port: 3306, user: 'u', database: 'db',
    ...over,
  } as SavedConnection;
}

describe('connectionTargetChanged（H6：编辑连接是否需重建会话）', () => {
  it('目标/SSH 字段变化 → true', () => {
    expect(connectionTargetChanged(conn(), conn({ host: 'h2' }))).toBe(true);
    expect(connectionTargetChanged(conn(), conn({ port: 3307 }))).toBe(true);
    expect(connectionTargetChanged(conn(), conn({ database: 'other' }))).toBe(true);
    expect(connectionTargetChanged(conn(), conn({ sshHost: 'jump' }))).toBe(true);
    expect(connectionTargetChanged(conn(), conn({ readOnly: true }))).toBe(true);
  });

  it('仅展示字段变化 → false（改名/分组不踢会话）', () => {
    expect(connectionTargetChanged(conn(), conn({ name: 'renamed' }))).toBe(false);
    expect(connectionTargetChanged(conn(), conn({ groupId: 'g2' }))).toBe(false);
    expect(connectionTargetChanged(conn(), conn({ color: '#f00' }))).toBe(false);
  });

  it('密钥字段单独变化不判定（无法可靠比较）', () => {
    expect(connectionTargetChanged(conn({ password: 'a' }), conn({ password: 'b' }))).toBe(false);
  });
});
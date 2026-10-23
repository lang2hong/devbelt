import { describe, expect, it, vi } from 'vitest';
import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import { DatabaseType } from '@devbelt/db-core';

vi.mock('../../src/connection/sshTunnel', () => ({
  SshTunnel: { create: async () => undefined, close: () => {}, release: () => {}, closeAll: () => {} },
}));

import { sqlConnectionConfig } from '../../src/connection/buildSqlSession';

function conn(over: Partial<SavedConnection> = {}): SavedConnection {
  return { id: 'c-1', name: 'n', dbType: DatabaseType.MYSQL, host: 'h', port: 3306, user: 'u', ...over } as SavedConnection;
}

describe('sqlConnectionConfig — read-only', () => {
  it('passes readOnly to the driver config so the database enforces it', () => {
    expect(sqlConnectionConfig(conn({ readOnly: true }), 'h', 3306).readOnly).toBe(true);
  });

  it('defaults to writable when the flag is absent or false', () => {
    expect(sqlConnectionConfig(conn(), 'h', 3306).readOnly).toBe(false);
    expect(sqlConnectionConfig(conn({ readOnly: false }), 'h', 3306).readOnly).toBe(false);
  });

  it('applies to every SQL engine', () => {
    for (const dbType of [DatabaseType.MYSQL, DatabaseType.PG, DatabaseType.SQLITE]) {
      expect(sqlConnectionConfig(conn({ dbType, readOnly: true }), 'h', 1).readOnly, dbType).toBe(true);
    }
  });
});

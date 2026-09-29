import { describe, expect, it } from 'vitest';
import { ConnectionStore } from '@devbelt/db-host/connection/connectionStore';
import { sanitizeConnectionForExport } from '../../src/utils/connectionExport';

describe('sanitizeConnectionForExport', () => {
  it('删除全部 SENSITIVE_FIELDS（含 sentinelPassword）', () => {
    const conn: any = {
      id: 'c1', name: 'sentinel', host: 'h', dbType: 'REDIS',
      password: 'pw', sshPassword: 'spw', sshPassphrase: 'pass', sentinelPassword: 'sp',
      readOnly: false,
    };
    const { out } = sanitizeConnectionForExport(conn);
    for (const field of ConnectionStore.SENSITIVE_FIELDS) {
      expect(out[field], `未删除 ${field}`).toBeUndefined();
    }
    expect(out.name).toBe('sentinel');
  });

  it('剥离 URL 内嵌凭据并报告', () => {
    const { out, urlStripped } = sanitizeConnectionForExport({
      id: 'c2', name: 'u', host: 'h', dbType: 'MYSQL', connectionUrl: 'mysql://user:secret@h:3306/db',
    } as any);
    expect(urlStripped).toBe(true);
    expect(String(out.connectionUrl)).not.toContain('secret');
  });

  it('无凭据时不动 URL、不报告', () => {
    const { out, urlStripped } = sanitizeConnectionForExport({
      id: 'c3', name: 'u', host: 'h', dbType: 'MYSQL', connectionUrl: 'mysql://h:3306/db',
    } as any);
    expect(urlStripped).toBe(false);
    expect(out.connectionUrl).toBe('mysql://h:3306/db');
  });
});
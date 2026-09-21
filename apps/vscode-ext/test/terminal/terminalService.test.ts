import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { TerminalService } from '../../src/terminal/terminalService';
import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import { DatabaseType } from '@devbelt/db-core';

describe('TerminalService.buildCommand', () => {
  const base = { id: 'c1', name: 'c', host: 'localhost', port: 3306, user: 'root' } as unknown as SavedConnection;

  it('port 经 shellQuote 包裹，阻断命令注入（MySQL）', () => {
    const conn = { ...base, dbType: DatabaseType.MYSQL, port: '3306; touch /tmp/pwned' as unknown as number };
    const cmd = TerminalService.buildCommand(conn)!.cmd;
    expect(cmd).toContain("-P '3306; touch /tmp/pwned'");
  });

  it('port 经 shellQuote 包裹（PG）', () => {
    const conn = { ...base, dbType: DatabaseType.PG, port: '5432`id`' as unknown as number };
    const cmd = TerminalService.buildCommand(conn)!.cmd;
    expect(cmd).toContain("-p '5432`id`'");
  });
});
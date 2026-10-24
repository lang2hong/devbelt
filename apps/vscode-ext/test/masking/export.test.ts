import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MysqlDialect } from '@devbelt/db-core';
import type { ColumnMeta } from '@devbelt/db-core';
import { exportMaskedTable, readMaskedRows, type MaskedExportDeps } from '../../src/masking/export';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

const columns = (over: Partial<ColumnMeta>[] = []): ColumnMeta[] => [
  { name: 'id', simpleType: 'int', type: 'int', comment: '', key: 'PRI', nullable: '', maxLength: '', defaultValue: null, extra: '', isNotNull: true, isAutoIncrement: true, isUnique: true, ...over[0] },
  { name: 'email', simpleType: 'varchar', type: 'varchar(120)', comment: '', key: '', nullable: 'YES', maxLength: '120', defaultValue: null, extra: '', isNotNull: false, isAutoIncrement: false, isUnique: false, ...over[1] },
  { name: 'phone', simpleType: 'varchar', type: 'varchar(11)', comment: '', key: '', nullable: 'YES', maxLength: '11', defaultValue: null, extra: '', isNotNull: false, isAutoIncrement: false, isUnique: false, ...over[2] },
] as ColumnMeta[];

function deps(over: Partial<MaskedExportDeps> = {}, rows: Array<Record<string, unknown>> = []) {
  const sql: string[] = [];
  const base: MaskedExportDeps = {
    query: { async query(statement: string) { sql.push(statement); return { rows } as never; } } as never,
    dialect: new MysqlDialect(),
    metadata: { async getColumns() { return columns(); } },
    table: 'users',
    database: 'app',
    columns: { email: { rule: 'email' }, phone: { rule: 'phone' } },
    salt: 'salt',
    maxRows: 100,
  };
  return { deps: { ...base, ...over }, sql };
}

describe('readMaskedRows', () => {
  it('requires a rule for PII columns unless explicitly allowed', async () => {
    const { deps: d } = deps({ columns: { email: { rule: 'email' } } });
    await expect(readMaskedRows(d, 20)).rejects.toThrow(/phone/);
    await expect(readMaskedRows({ ...d, allowUnmasked: ['phone'] }, 20)).resolves.toBeDefined();
  });

  it('applies WHERE and LIMIT and masks the configured columns', async () => {
    const rows = [{ id: 1, email: 'a@x.test', phone: '13800000000' }, { id: 2, email: 'a@x.test', phone: '13900000000' }];
    const { deps: d, sql } = deps({ where: 'id > 0' }, rows);
    const result = await readMaskedRows(d, 20);
    expect(sql[0]).toBe('SELECT `id`, `email`, `phone` FROM `app`.`users` WHERE id > 0 LIMIT 21');
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]!.email).toMatch(/@masked\.invalid$/);
    expect(result.rows[0]!.phone).toHaveLength(11);
    expect(result.rows[0]!.email).toBe(result.rows[1]!.email); // deterministic
  });

  it('rejects config columns that do not exist and NOT NULL null rules', async () => {
    const { deps: d } = deps({ columns: { nope: { rule: 'redact' }, email: { rule: 'email' }, phone: { rule: 'phone' } } });
    await expect(readMaskedRows(d, 20)).rejects.toThrow(/Unknown column/);
    const { deps: d2 } = deps({ columns: { id: { rule: 'null' }, email: { rule: 'email' }, phone: { rule: 'phone' } } });
    await expect(readMaskedRows(d2, 20)).rejects.toThrow(/NOT NULL/);
  });

  it('rejects duplicate values on unique columns after masking', async () => {
    const { deps: d } = deps(
      {
        metadata: { async getColumns() { return columns([{}, { isUnique: true }]); } },
        columns: { email: { rule: 'fixed', value: 'same' }, phone: { rule: 'phone' } },
      },
      [{ id: 1, email: 'a@x.test', phone: '1' }, { id: 2, email: 'b@x.test', phone: '2' }],
    );
    await expect(readMaskedRows(d, 20)).rejects.toThrow(/duplicate value for unique column email/);
  });

  it('refuses when the query matches more rows than the limit', async () => {
    const { deps: d } = deps({}, [{ id: 1, email: 'a', phone: '1' }, { id: 2, email: 'b', phone: '2' }]);
    await expect(readMaskedRows(d, 1)).rejects.toThrow(/more than 1 rows/);
  });
});

describe('exportMaskedTable', () => {
  it('writes a masked CSV atomically with owner-only permissions', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'masked-export-'));
    dirs.push(dir);
    const file = join(dir, 'out.csv');
    const { deps: d } = deps({}, [{ id: 1, email: 'a@x.test', phone: '13800000000' }]);
    const result = await exportMaskedTable(d, 'csv', file, 20);
    expect(result.rows).toBe(1);
    const text = await fs.readFile(file, 'utf8');
    expect(text).toContain('id,email,phone');
    expect(text).not.toContain('a@x.test');
    expect(text).toContain('@masked.invalid');
    if (process.platform !== 'win32') expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });

  it('does not leave a temp file behind when masking fails', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'masked-export-'));
    dirs.push(dir);
    const file = join(dir, 'out.csv');
    const { deps: d } = deps({ columns: { email: { rule: 'email' } } });
    await expect(exportMaskedTable(d, 'csv', file, 20)).rejects.toThrow(/phone/);
    expect(await fs.readdir(dir)).toEqual([]);
  });
});
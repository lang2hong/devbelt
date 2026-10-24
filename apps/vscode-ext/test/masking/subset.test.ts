import { describe, expect, it } from 'vitest';
import { MysqlDialect } from '@devbelt/db-core';
import type { ColumnMeta, ForeignKeyMeta } from '@devbelt/db-core';
import { parseMaskingConfig, type MaskingConfig } from '@devbelt/masking-core';
import { collectMaskedSubset, type SubsetExportDeps } from '../../src/masking/subset';

const col = (name: string, over: Partial<ColumnMeta> = {}): ColumnMeta => ({
  name, simpleType: 'int', type: 'int', comment: '', key: '', nullable: 'YES', maxLength: '',
  defaultValue: null, extra: '', isNotNull: false, isAutoIncrement: false, isUnique: false, isPrimary: false, pk: '', ...over,
});

const TABLES: Record<string, ColumnMeta[]> = {
  users: [col('id', { key: 'PRI', isPrimary: true, isNotNull: true }), col('email', { maxLength: '120' })],
  orders: [col('id', { key: 'PRI', isPrimary: true, isNotNull: true }), col('user_id'), col('note')],
  items: [col('id', { key: 'PRI', isPrimary: true, isNotNull: true }), col('order_id'), col('sku')],
};
const FKS: ForeignKeyMeta[] = [
  { tableName: 'orders', columnName: 'user_id', refTable: 'users', refColumn: 'id', constraintName: 'fk_orders_user' },
  { tableName: 'items', columnName: 'order_id', refTable: 'orders', refColumn: 'id', constraintName: 'fk_items_order' },
];
const DATA: Record<string, Array<Record<string, unknown>>> = {
  users: [{ id: 1, email: 'a@x.test' }, { id: 2, email: 'b@x.test' }],
  orders: [{ id: 10, user_id: 1, note: 'n1' }, { id: 11, user_id: 2, note: 'n2' }],
  items: [{ id: 100, order_id: 10, sku: 's1' }, { id: 101, order_id: 11, sku: 's2' }],
};

function config(tables: Record<string, unknown>, maxRowsTotal = 100): MaskingConfig {
  const parsed = parseMaskingConfig({ version: 1, maxRowsTotal, tables });
  if (!parsed.ok) throw new Error(parsed.errors.join(', '));
  return parsed.config;
}

function fake(opts: { fks?: ForeignKeyMeta[]; config: MaskingConfig; rootTable?: string; data?: typeof DATA }) {
  const data = opts.data ?? DATA;
  const sql: string[] = [];
  const deps: SubsetExportDeps = {
    query: {
      async query(statement: string) {
        sql.push(statement);
        const table = /FROM\s+(?:`[^`]+`\.)*`([^`]+)`/.exec(statement)?.[1];
        if (!table) return { rows: [] } as never;
        let rows = (data[table] ?? []).map((r) => ({ ...r }));
        const inMatch = /`([^`]+)` IN \(([^)]*)\)/.exec(statement);
        if (inMatch) {
          const values = new Set(inMatch[2]!.split(',').map((v) => v.trim().replace(/^'|'$/g, '')));
          rows = rows.filter((r) => values.has(String(r[inMatch[1]!])));
        } else {
          const eq = /WHERE `?([A-Za-z_][A-Za-z0-9_]*)`? = ([^ ]+)/.exec(statement);
          if (eq) rows = rows.filter((r) => String(r[eq[1]!]) === eq[2]!.replace(/'/g, ''));
        }
        return { rows } as never;
      },
    } as never,
    dialect: new MysqlDialect(),
    metadata: {
      async getColumns(table: string) { return TABLES[table] ?? []; },
      async getForeignKeys() { return opts.fks ?? FKS; },
    },
    database: 'app',
    config: opts.config,
    salt: 'salt',
    rootTable: opts.rootTable ?? 'orders',
  };
  return { deps, sql };
}

describe('collectMaskedSubset', () => {
  it('pulls the referenced parent and keeps both sides of the FK equal', async () => {
    const cfg = config({
      orders: { where: 'id = 10', referenced: true, columns: {} },
      users: { columns: { id: 'hash', email: 'email' } },
    });
    const result = await collectMaskedSubset(fake({ config: cfg }).deps);
    expect(result.tables.map((t) => t.name)).toEqual(['users', 'orders']);
    const users = result.tables.find((t) => t.name === 'users')!;
    const orders = result.tables.find((t) => t.name === 'orders')!;
    expect(users.rows).toHaveLength(1);
    expect(orders.rows).toHaveLength(1);
    expect(orders.rows[0]!.user_id).toBe(users.rows[0]!.id);
    expect(String(users.rows[0]!.email)).toMatch(/@masked\.invalid$/);
  });

  it('walks down through referencing tables up to maxDepth', async () => {
    const cfg = config({
      users: { where: 'id = 1', referencing: true, maxDepth: 2, columns: { id: 'hash', email: 'email' } },
      orders: { columns: {} },
      items: { columns: {} },
    });
    const result = await collectMaskedSubset(fake({ config: cfg, rootTable: 'users' }).deps);
    expect(result.tables.map((t) => t.name)).toEqual(['users', 'orders', 'items']);
    expect(result.rows).toBe(3);
  });

  it('rejects composite foreign keys', async () => {
    const cfg = config({ orders: { referenced: true, columns: {} }, users: { columns: { id: 'hash', email: 'email' } } });
    const composite: ForeignKeyMeta[] = [
      { tableName: 'orders', columnName: 'a', refTable: 'users', refColumn: 'x', constraintName: 'fk1' },
      { tableName: 'orders', columnName: 'b', refTable: 'users', refColumn: 'y', constraintName: 'fk1' },
    ];
    await expect(collectMaskedSubset(fake({ fks: composite, config: cfg }).deps)).rejects.toThrow(/Composite foreign keys/);
  });

  it('rejects cyclic dependencies', async () => {
    const cfg = config({ orders: { referenced: true, columns: {} }, users: { columns: { id: 'hash', email: 'email' } } });
    const cycle: ForeignKeyMeta[] = [
      { tableName: 'users', columnName: 'id', refTable: 'orders', refColumn: 'user_id', constraintName: 'c1' },
      { tableName: 'orders', columnName: 'user_id', refTable: 'users', refColumn: 'id', constraintName: 'c2' },
    ];
    await expect(collectMaskedSubset(fake({ fks: cycle, config: cfg }).deps)).rejects.toThrow(/Cyclic/);
  });

  it('stops at the row budget', async () => {
    const cfg = config({
      orders: { referenced: true, columns: {} },
      users: { columns: { id: 'hash', email: 'email' } },
    }, 1);
    await expect(collectMaskedSubset(fake({ config: cfg }).deps)).rejects.toThrow(/budget|more than/);
  });

  it('refuses a pulled-in table with PII columns and no rules', async () => {
    const cfg = config({ orders: { where: 'id = 10', referenced: true, columns: {} } });
    await expect(collectMaskedSubset(fake({ config: cfg }).deps)).rejects.toThrow(/PII columns.*users/);
  });
});
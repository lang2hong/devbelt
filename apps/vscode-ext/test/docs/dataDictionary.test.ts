import { describe, expect, it } from 'vitest';
import { en } from '../../src/i18n/catalog';
import {
  escapeHtml,
  mdCell,
  renderHtml,
  renderMarkdown,
  tableAnchor,
  type DictionaryLabels,
  type DictionaryModel,
} from '../../src/docs/dataDictionary';

const labels = Object.fromEntries(
  [
    'title', 'database', 'schema', 'engine', 'generatedAt', 'contents', 'tableCount', 'truncated', 'noTables',
    'rowsEstimate', 'columns', 'indexes', 'foreignKeys', 'colName', 'colType', 'colNullable', 'colDefault',
    'colComment', 'colKey', 'yes', 'no', 'primaryKey', 'autoIncrement', 'unique', 'indexName', 'indexColumns',
    'indexKind', 'fkName', 'fkColumns', 'fkReferences', 'none',
  ].map((k) => [k, en[`dict.${k}`]]),
) as unknown as DictionaryLabels;

function model(overrides: Partial<DictionaryModel> = {}): DictionaryModel {
  return {
    database: 'shop',
    dbType: 'MYSQL',
    generatedAt: '2026-10-23T00:00:00.000Z',
    totalTables: 2,
    truncated: false,
    tables: [
      {
        name: 'orders',
        comment: 'Customer orders',
        rowsEstimate: '1200',
        columns: [
          { name: 'id', type: 'bigint', nullable: false, defaultValue: '', comment: '', isPrimary: true, isAutoIncrement: true },
          { name: 'user_id', type: 'bigint', nullable: false, defaultValue: '', comment: 'Buyer', isPrimary: false, isAutoIncrement: false },
          { name: 'status', type: 'varchar(20)', nullable: true, defaultValue: "'new'", comment: 'a | b\nc', isPrimary: false, isAutoIncrement: false },
        ],
        indexes: [
          { name: 'PRIMARY', columns: ['id'], isUnique: true, isPrimary: true },
          { name: 'idx_user', columns: ['user_id'], isUnique: false, isPrimary: false },
        ],
        foreignKeys: [{ name: 'fk_user', columns: ['user_id'], refTable: 'users', refColumns: ['id'] }],
      },
      {
        name: 'users',
        comment: '',
        columns: [{ name: 'id', type: 'bigint', nullable: false, defaultValue: '', comment: '', isPrimary: true, isAutoIncrement: false }],
        indexes: [],
        foreignKeys: [],
      },
    ],
    ...overrides,
  };
}

describe('escaping helpers', () => {
  it('escapes Markdown table cells', () => {
    expect(mdCell('a | b\nc <x>')).toBe('a \\| b<br>c &lt;x&gt;');
  });

  it('escapes HTML', () => {
    expect(escapeHtml(`<script>alert("x")</script>'`)).toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&#39;');
  });

  it('builds stable anchors', () => {
    expect(tableAnchor('Order Items')).toBe('table-order-items');
    expect(tableAnchor('用户')).toBe('table-用户');
    expect(tableAnchor('***')).toBe('table-unnamed');
  });
});

describe('renderMarkdown', () => {
  it('renders header, contents, columns, indexes and linked foreign keys', () => {
    const md = renderMarkdown(model(), labels);
    expect(md).toContain('# Data Dictionary');
    expect(md).toContain('- **Database**: shop');
    expect(md).toContain('- [orders](#table-orders) — Customer orders');
    expect(md).toContain('<a id="table-orders"></a>');
    expect(md).toContain('| `id` | bigint | No |  | Primary key, Auto increment |  |');
    expect(md).toContain("| `status` | varchar(20) | Yes | `'new'` |  | a \\| b<br>c |");
    expect(md).toContain('| `idx_user` | user_id |  |');
    expect(md).toContain('| `fk_user` | user_id | [users (id)](#table-users) |');
    expect(md).toContain('Estimated rows: 1200');
  });

  it('leaves empty comments empty and writes None for missing sections', () => {
    const md = renderMarkdown(model(), labels);
    const users = md.slice(md.indexOf('## users'));
    expect(users).toContain('### Indexes\n\nNone');
    expect(users).toContain('### Foreign keys\n\nNone');
    expect(md).not.toContain('undefined');
  });

  it('notes truncation and the empty case', () => {
    expect(renderMarkdown(model({ truncated: true, totalTables: 900 }), labels)).toContain('Only the first 2 of 900 tables are included.');
    expect(renderMarkdown(model({ tables: [], totalTables: 0 }), labels)).toContain('No tables.');
  });

  it('does not link cross-schema references', () => {
    const m = model();
    m.tables[0].foreignKeys = [{ columns: ['user_id'], refTable: 'users', refSchema: 'auth', refColumns: ['id'] }];
    expect(renderMarkdown(m, labels)).toContain('|  | user_id | auth.users (id) |');
  });
});

describe('renderHtml', () => {
  it('is a standalone document with a strict CSP and anchors', () => {
    const html = renderHtml(model(), labels);
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('<h2 id="table-orders">orders</h2>');
    expect(html).toContain('<a href="#table-users">users (id)</a>');
    expect(html).not.toMatch(/<script/i);
  });

  it('escapes hostile metadata', () => {
    const m = model();
    m.tables[0].comment = '<script>alert(1)</script>';
    m.tables[0].columns[0].name = '<img src=x onerror=alert(1)>';
    const html = renderHtml(m, labels);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});

describe('no connection details', () => {
  it('never includes host, user or password', () => {
    // The model type has no connection fields; extra properties must not leak either.
    const leaky = { ...model(), host: 'db.internal', user: 'admin', password: 's3cret' } as unknown as DictionaryModel;
    for (const out of [renderMarkdown(leaky, labels), renderHtml(leaky, labels)]) {
      expect(out).not.toContain('db.internal');
      expect(out).not.toContain('admin');
      expect(out).not.toContain('s3cret');
    }
  });
});
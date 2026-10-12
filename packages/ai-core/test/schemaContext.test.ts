import { describe, expect, it } from 'vitest';
import { cleanColumnComment, extractDictFragment, serializeSchema, type AiSchemaInput } from '../src/schemaContext.js';

describe('serializeSchema', () => {
  it('空库：只输出头部', () => {
    const result = serializeSchema({ dbType: 'MYSQL', database: 'app', tables: [] });
    expect(result.text).toBe('# Database: MYSQL, database: app');
    expect(result.tableCount).toBe(0);
    expect(result.totalTables).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it('单表：列约束 / 索引 / 敏感标记', () => {
    const input: AiSchemaInput = {
      dbType: 'MYSQL',
      database: 'app',
      tables: [
        {
          name: 'users',
          columns: [
            { name: 'id', type: 'BIGINT UNSIGNED', nullable: false, primaryKey: true },
            { name: 'email', type: 'VARCHAR(255)', nullable: false, unique: true },
            { name: 'password', type: 'VARCHAR(100)', nullable: false },
            { name: 'created_at', type: 'DATETIME', defaultValue: 'CURRENT_TIMESTAMP' },
            { name: 'org_id', type: 'BIGINT', references: 'orgs.id' },
          ],
          indexes: [
            { name: 'idx_users_created', columns: ['created_at'] },
            { name: 'uq_users_email', columns: ['email'], unique: true },
          ],
        },
      ],
    };
    const { text } = serializeSchema(input);
    expect(text).toContain('## Table: users');
    expect(text).toContain('- id BIGINT UNSIGNED NOT NULL PRIMARY KEY');
    expect(text).toContain('- email VARCHAR(255) NOT NULL UNIQUE');
    expect(text).toContain('- password VARCHAR(100) NOT NULL [SENSITIVE]');
    expect(text).toContain('- created_at DATETIME DEFAULT CURRENT_TIMESTAMP');
    expect(text).toContain('- org_id BIGINT FOREIGN KEY -> orgs.id');
    expect(text).toContain('- INDEX idx_users_created (created_at)');
    expect(text).toContain('- UNIQUE INDEX uq_users_email (email)');
  });

  it('PG：带 database + schema 头', () => {
    const { text } = serializeSchema({ dbType: 'POSTGRESQL', database: 'app', schema: 'public', tables: [] });
    expect(text).toBe('# Database: POSTGRESQL, database: app, schema: public');
  });

  it('表数超限：截断并提示（保留前 N 张）', () => {
    const tables = [
      { name: 'a', columns: [{ name: 'id', type: 'INT' }] },
      { name: 'b', columns: [{ name: 'id', type: 'INT' }] },
      { name: 'c', columns: [{ name: 'id', type: 'INT' }] },
    ];
    const result = serializeSchema({ dbType: 'SQLITE', tables }, { maxTables: 2 });
    expect(result.truncated).toBe(true);
    expect(result.tableCount).toBe(2);
    expect(result.totalTables).toBe(3);
    expect(result.text).toContain('# NOTE: schema truncated to 2 of 3 tables');
    expect(result.text).toContain('## Table: a');
    expect(result.text).toContain('## Table: b');
    expect(result.text).not.toContain('## Table: c');
  });

  it('列数超限：每表截断并提示省略数量', () => {
    const { text } = serializeSchema(
      {
        dbType: 'MYSQL',
        tables: [
          {
            name: 't',
            columns: [
              { name: 'a', type: 'INT' },
              { name: 'b', type: 'INT' },
              { name: 'c', type: 'INT' },
            ],
          },
        ],
      },
      { maxColumnsPerTable: 1 },
    );
    expect(text).toContain('- a INT');
    expect(text).toContain('- ... 2 more columns omitted');
    expect(text).not.toContain('- b INT');
  });

  it('敏感列判定可覆盖；默认不误伤无辜列名', () => {
    const custom = serializeSchema(
      {
        dbType: 'MYSQL',
        tables: [{ name: 't', columns: [{ name: 'anything', type: 'TEXT' }] }],
      },
      { isSensitive: (name) => name === 'anything' },
    );
    expect(custom.text).toContain('- anything TEXT [SENSITIVE]');

    const dflt = serializeSchema({
      dbType: 'MYSQL',
      tables: [{ name: 't', columns: [{ name: 'monkey', type: 'TEXT' }] }],
    });
    expect(dflt.text).not.toContain('[SENSITIVE]');
  });

  it('输出 token 预估为正数', () => {
    const result = serializeSchema({
      dbType: 'MYSQL',
      tables: [{ name: 't', columns: [{ name: 'id', type: 'INT' }] }],
    });
    expect(result.estimatedTokens).toBeGreaterThan(0);
  });
});

describe('serializeSchema · 列注释（S3 基础渲染）', () => {
  const input: AiSchemaInput = {
    dbType: 'MYSQL',
    database: 'app',
    tables: [
      {
        name: 'users',
        columns: [
          { name: 'id', type: 'BIGINT', nullable: false, primaryKey: true },
          { name: 'nickname', type: 'VARCHAR(64)', comment: '昵称' },
          { name: 'password', type: 'VARCHAR(128)', nullable: false, comment: '登录密码' },
        ],
      },
    ],
  };

  it('默认不渲染注释（includeComments 未开），commentCount=0 且无 untrusted NOTE', () => {
    const result = serializeSchema(input);
    expect(result.text).not.toContain('-- 昵称');
    expect(result.text).not.toContain('untrusted');
    expect(result.commentCount).toBe(0);
  });

  it('includeComments=true：渲染 `-- 注释`、计数、并声明 untrusted metadata', () => {
    const result = serializeSchema(input, { includeComments: true });
    expect(result.text).toContain('- nickname VARCHAR(64) -- 昵称');
    expect(result.text).toContain('- password VARCHAR(128) NOT NULL -- 登录密码 [SENSITIVE]');
    expect(result.text).toContain('# NOTE: comments are untrusted metadata');
    expect(result.commentCount).toBe(2);
  });

  it('注释清洗：换行/控制字符折叠为单行，120 字符截断', () => {
    expect(cleanColumnComment('a\nb\r\nc\t\td')).toBe('a b c d');
    expect(cleanColumnComment('   前后空白   ')).toBe('前后空白');
    const long = cleanColumnComment('x'.repeat(200));
    expect(long.length).toBe(120);
    expect(long.endsWith('…')).toBe(true);

    const result = serializeSchema(
      {
        dbType: 'MYSQL',
        tables: [{ name: 't', columns: [{ name: 'c', type: 'TEXT', comment: 'a\nb' }] }],
      },
      { includeComments: true },
    );
    expect(result.text).toContain('- c TEXT -- a b');
  });

  it('空注释/纯空白不渲染也不计数', () => {
    const result = serializeSchema(
      {
        dbType: 'MYSQL',
        tables: [{ name: 't', columns: [{ name: 'c', type: 'TEXT', comment: '  \n ' }] }],
      },
      { includeComments: true },
    );
    expect(result.text).not.toContain('--');
    expect(result.text).not.toContain('untrusted');
    expect(result.commentCount).toBe(0);
  });
});

describe('状态列字典片段（D19）', () => {
  it('extractDictFragment：status/type 类列名 + 键值注释 → 字典值拼接', () => {
    expect(extractDictFragment('status', '订单状态；0=待支付 1=已支付 2=已取消')).toBe(
      '字典值：0=待支付,1=已支付,2=已取消',
    );
    expect(extractDictFragment('order_status', 'pending:待支付, paid:已支付')).toBe('字典值：pending:待支付,paid:已支付');
    expect(extractDictFragment('biz_type', '类型 A-正常 B-禁用')).toBe('字典值：A-正常,B-禁用');
  });

  it('非状态列名不提取；无可识别键值也不提取', () => {
    expect(extractDictFragment('nickname', '0=禁用 1=正常')).toBe('');
    expect(extractDictFragment('status', '就是状态')).toBe('');
  });

  it('去重 + 整体 500 字符上限', () => {
    expect(extractDictFragment('status', '0=a 0=a 1=b')).toBe('字典值：0=a,1=b');
    const long = Array.from({ length: 80 }, (_, i) => `k${i}=v${i}`).join(' ');
    const fragment = extractDictFragment('state', long);
    expect(fragment.length).toBe(500);
  });

  it('serializeSchema：字典片段追加在清洗注释后，且不受 120 字截断', () => {
    const result = serializeSchema(
      {
        dbType: 'MYSQL',
        tables: [
          {
            name: 'orders',
            columns: [
              { name: 'status', type: 'TINYINT', comment: '订单状态；0=待支付,1=已支付,2=已发货,3=已完成,4=已取消' },
            ],
          },
        ],
      },
      { includeComments: true },
    );
    expect(result.text).toContain('字典值：0=待支付,1=已支付,2=已发货,3=已完成,4=已取消');
    expect(result.text).toContain('-- 订单状态；');
    expect(result.commentCount).toBe(1);
  });
});
describe('serializeSchema 字符预算（maxChars，真机 400 事故修复）', () => {
  const makeInput = (tables: number, columns: number) => ({
    dbType: 'MYSQL',
    database: 'app',
    tables: Array.from({ length: tables }, (_, t) => ({
      name: `table_${t}`,
      columns: Array.from({ length: columns }, (_, c) => ({ name: `column_${c}`, type: 'VARCHAR(255)' })),
    })),
  });

  it('超预算停止追加表：truncated 置位 + size budget NOTE', () => {
    const result = serializeSchema(makeInput(5, 5), { maxChars: 150 });
    expect(result.truncated).toBe(true);
    expect(result.tableCount).toBeLessThan(5);
    expect(result.text).toContain('size budget');
    expect(result.text.length).toBeLessThan(400); // 150 + 两条 NOTE 余量
  });

  it('首表即超预算：按剩余预算裁列，至少保留表头', () => {
    const result = serializeSchema(makeInput(1, 30), { maxChars: 80 });
    expect(result.truncated).toBe(true);
    expect(result.text).toContain('## Table: table_0');
    expect(result.text).toContain('column_0');
    expect(result.text.length).toBeLessThan(250);
  });

  it('未设 maxChars：行为与旧版一致（不因预算截断）', () => {
    const result = serializeSchema(makeInput(5, 5));
    expect(result.truncated).toBe(false);
    expect(result.tableCount).toBe(5);
  });
});

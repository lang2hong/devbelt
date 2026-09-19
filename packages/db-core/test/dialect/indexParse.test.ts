import { describe, expect, it } from 'vitest';
import { MysqlDialect } from '../../src/dialect/mysqlDialect';
import { PostgreSqlDialect } from '../../src/dialect/postgreSqlDialect';
import { SqliteDialect } from '../../src/dialect/sqliteDialect';
import { normalizeColumnMeta } from '../../src/query/normalize';
import { DatabaseType } from '../../src/types/connection';

/**
 * 索引/列元数据的布尔字段归一化回归测试。
 *
 * MySQL 驱动 typeCast 把布尔表达式字符串化为 `"0"`/`"1"`；此前直接赋给
 * isUnique/isPrimary，前端 `!!"0"` 判真，导致表设计里所有索引都被当作主键，
 * 编辑/删除按钮全部禁用，Unique 列也全显示 YES。
 */
describe('parseIndexList 布尔归一化', () => {
  it('MySQL：字符串化的 0/1 正确归一，并按索引名聚合列', () => {
    const rows = [
      { name: 'PRIMARY', col: 'id', is_unique: '1', is_primary: '1' },
      { name: 'idx_name', col: 'first', is_unique: '0', is_primary: '0' },
      { name: 'idx_name', col: 'last', is_unique: '0', is_primary: '0' },
      { name: 'uk_email', col: 'email', is_unique: '1', is_primary: '0' },
    ];
    const indexes = new MysqlDialect().parseIndexList(rows);

    expect(indexes).toHaveLength(3);
    const byName = new Map(indexes.map((i) => [i.name, i]));

    expect(byName.get('PRIMARY')!.isPrimary).toBe(true);
    expect(byName.get('PRIMARY')!.isUnique).toBe(true);

    // 关键断言：非主键索引不能因为 "0" 被判为主键
    expect(byName.get('idx_name')!.isPrimary).toBe(false);
    expect(byName.get('idx_name')!.isUnique).toBe(false);
    expect(byName.get('idx_name')!.columns).toEqual(['first', 'last']);

    expect(byName.get('uk_email')!.isUnique).toBe(true);
    expect(byName.get('uk_email')!.isPrimary).toBe(false);
  });

  it('MySQL：原生数值 0/1 同样正确', () => {
    const indexes = new MysqlDialect().parseIndexList([
      { name: 'idx_a', col: 'a', is_unique: 0, is_primary: 0 },
    ]);
    expect(indexes[0].isUnique).toBe(false);
    expect(indexes[0].isPrimary).toBe(false);
  });

  it('SQLite：标志位归一化', () => {
    const indexes = new SqliteDialect().parseIndexList([
      { name: 'idx_a', is_unique: '0', is_primary: '0' },
      { name: 'uk_b', is_unique: 1, is_primary: 0 },
    ]);
    expect(indexes[0].isUnique).toBe(false);
    expect(indexes[1].isUnique).toBe(true);
  });

  it('SQLite：按索引名归并列，origin=pk 才是主键', () => {
    const indexes = new SqliteDialect().parseIndexList([
      { name: 'idx_a', is_unique: 0, is_primary: 0, col: 'a' },
      { name: 'idx_a', is_unique: 0, is_primary: 0, col: 'b' },
      { name: 'sqlite_autoindex_t_1', is_unique: 1, is_primary: 1, col: 'id' },
    ]);
    expect(indexes.map((i) => i.name)).toEqual(['idx_a', 'sqlite_autoindex_t_1']);
    // 过去列恒空（UI 看不到索引列），unique 恒 0。
    expect(indexes[0].columns).toEqual(['a', 'b']);
    expect(indexes[0].isPrimary).toBe(false);
    expect(indexes[1].isPrimary).toBe(true);
    expect(indexes[1].isUnique).toBe(true);
  });
});

describe('PG parseIndexList 列名提取', () => {
  const pg = new PostgreSqlDialect();

  it('从 indexdef 提取列名（此前恒为空数组，索引编辑弹窗勾选项全空）', () => {
    const indexes = pg.parseIndexList([
      { name: 'idx_users_name', definition: 'CREATE INDEX idx_users_name ON public.users USING btree (first_name, last_name)' },
    ]);
    expect(indexes[0].columns).toEqual(['first_name', 'last_name']);
  });

  it('剥离排序、NULLS、操作符类修饰与引号', () => {
    const indexes = pg.parseIndexList([
      {
        name: 'idx_mixed',
        definition: 'CREATE INDEX idx_mixed ON t USING btree ("createdAt" DESC NULLS LAST, name varchar_pattern_ops)',
      },
    ]);
    expect(indexes[0].columns).toEqual(['createdAt', 'name']);
  });

  it('表达式索引保留原样（嵌套括号不被当作分隔）', () => {
    const indexes = pg.parseIndexList([
      { name: 'idx_expr', definition: 'CREATE INDEX idx_expr ON t USING btree (lower(email), coalesce(a, b))' },
    ]);
    expect(indexes[0].columns).toEqual(['lower(email)', 'coalesce(a, b)']);
  });

  it('UNIQUE 从定义串识别', () => {
    const indexes = pg.parseIndexList([
      { name: 'uk_email', definition: 'CREATE UNIQUE INDEX uk_email ON t USING btree (email)' },
    ]);
    expect(indexes[0].isUnique).toBe(true);
  });

  it('无括号定义不抛错', () => {
    expect(pg.parseIndexList([{ name: 'weird', definition: 'CREATE INDEX weird' }])[0].columns).toEqual([]);
    expect(pg.parseIndexList([{ name: 'nil' }])[0].columns).toEqual([]);
  });
});

describe('normalizeColumnMeta 布尔归一化', () => {
  it('MySQL SHOW FULL COLUMNS 形态', () => {
    const col = normalizeColumnMeta({
      Field: 'id', Type: 'int unsigned', Null: 'NO', Key: 'PRI', Default: null, Extra: 'auto_increment', Comment: 'pk',
    });
    expect(col.name).toBe('id');
    expect(col.isPrimary).toBe(true);
    expect(col.isNotNull).toBe(true);
    expect(col.isAutoIncrement).toBe(true);
    expect(col.simpleType).toBe('int unsigned');
  });

  it('非主键列不被误判（Key 为空串）', () => {
    const col = normalizeColumnMeta({ Field: 'name', Type: 'varchar(50)', Null: 'YES', Key: '', Extra: '' });
    expect(col.isPrimary).toBe(false);
    expect(col.isNotNull).toBe(false);
    expect(col.pk).toBe('');
  });

  it('SQLite pk 字段为字符串 "0" 时不判为主键', () => {
    const col = normalizeColumnMeta({ name: 'c', type: 'TEXT', pk: '0', isNotNull: '0' });
    expect(col.isPrimary).toBe(false);
    expect(col.isNotNull).toBe(false);
  });

  it('SQLite pk 字段为 "1" 时判为主键', () => {
    const col = normalizeColumnMeta({ name: 'c', type: 'INTEGER', pk: '1', isNotNull: '1' });
    expect(col.isPrimary).toBe(true);
    expect(col.isNotNull).toBe(true);
  });

  it('UNI key 标记唯一列', () => {
    expect(normalizeColumnMeta({ Field: 'e', Type: 'varchar(1)', Key: 'UNI' }).isUnique).toBe(true);
    expect(normalizeColumnMeta({ Field: 'e', Type: 'varchar(1)', Key: '' }).isUnique).toBe(false);
  });
});

describe('方言列类型候选', () => {
  it('各方言提供自己的类型集合，不共用 MySQL 的', () => {
    const mysql = new MysqlDialect().columnTypes;
    const pg = new PostgreSqlDialect().columnTypes;
    const sqlite = new SqliteDialect().columnTypes;

    expect(mysql).toContain('LONGTEXT');
    expect(mysql).not.toContain('JSONB');

    expect(pg).toContain('JSONB');
    expect(pg).toContain('SERIAL');
    expect(pg).toContain('TIMESTAMPTZ');
    expect(pg).not.toContain('LONGTEXT');

    expect(sqlite).toContain('INTEGER');
    expect(sqlite).toContain('REAL');
    expect(sqlite).not.toContain('JSONB');
  });

  it('dbType 与候选表一一对应', () => {
    expect(new MysqlDialect().dbType).toBe(DatabaseType.MYSQL);
    expect(new PostgreSqlDialect().dbType).toBe(DatabaseType.PG);
    expect(new SqliteDialect().dbType).toBe(DatabaseType.SQLITE);
  });
});

import { describe, expect, it } from 'vitest';
import { DatabaseType } from '@devkit/db-core';
import { escapeSqlString, statementTextAt, wrapIdent } from '../../src/utils/sql';

/**
 * 本包只保留 vscode 特有的标识符/字面量转义。
 * 语句切分已下沉 `@devkit/db-core/sql`，其行为由 db-core 的
 * `test/sql/split.test.ts` 与本包的 `test/utils/sqlContract.test.ts` 覆盖。
 */
describe('wrapIdent', () => {
  it('MySQL 用反引号，其余用双引号', () => {
    expect(wrapIdent(DatabaseType.MYSQL, 'users')).toBe('`users`');
    expect(wrapIdent(DatabaseType.PG, 'users')).toBe('"users"');
    expect(wrapIdent(DatabaseType.SQLITE, 'users')).toBe('"users"');
  });

  it('内嵌引号按方言翻倍，逃不出标识符上下文', () => {
    expect(wrapIdent(DatabaseType.MYSQL, 'a`b')).toBe('`a``b`');
    expect(wrapIdent(DatabaseType.PG, 'a"b')).toBe('"a""b"');
  });
});

describe('escapeSqlString', () => {
  it('单引号在所有方言都翻倍', () => {
    for (const dbType of [DatabaseType.MYSQL, DatabaseType.PG, DatabaseType.SQLITE]) {
      expect(escapeSqlString("O'Brien", dbType)).toBe("O''Brien");
    }
  });

  it('反斜杠只在 MySQL 翻倍', () => {
    expect(escapeSqlString('C:\\tmp', DatabaseType.MYSQL)).toBe('C:\\\\tmp');
    expect(escapeSqlString('C:\\tmp', DatabaseType.PG)).toBe('C:\\tmp');
    expect(escapeSqlString('C:\\tmp', DatabaseType.SQLITE)).toBe('C:\\tmp');
  });

  it('注入形状不逃出字面量', () => {
    expect(escapeSqlString("x' OR 1=1 -- ", DatabaseType.MYSQL)).toBe("x'' OR 1=1 -- ");
    expect(escapeSqlString("x' OR 1=1 -- ", DatabaseType.PG)).toBe("x'' OR 1=1 -- ");
  });
});
describe('statementTextAt（补全上下文）', () => {
  it('返回光标所在语句，而非整篇的首个 FROM', () => {
    const text = 'SELECT * FROM first;\nSELECT * FROM second WHERE';
    const offset = text.indexOf('WHERE');
    const stmt = statementTextAt(text, offset);
    expect(stmt).toContain('second');
    expect(stmt).not.toContain('first');
  });

  it('光标在分号后的空白处返回空串', () => {
    const text = 'SELECT 1;\n\n';
    expect(statementTextAt(text, text.length)).toBe('');
  });
});

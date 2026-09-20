import { describe, expect, it } from 'vitest';
import { DatabaseType } from '@devkit/db-core';
import { escapeSqlString, statementTextAt, streamSqlStatements, wrapIdent } from '../../src/utils/sql';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

  it('MySQL NO_BACKSLASH_ESCAPES 下反斜杠不翻倍，单引号仍翻倍', () => {
    expect(escapeSqlString('C:\\tmp', DatabaseType.MYSQL, true)).toBe('C:\\tmp');
    expect(escapeSqlString("O'Brien\\x", DatabaseType.MYSQL, true)).toBe("O''Brien\\x");
    // 非 MySQL 不受该开关影响
    expect(escapeSqlString('C:\\tmp', DatabaseType.PG, true)).toBe('C:\\tmp');
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

  it('剥离语句前的注释，避免注释里的 FROM 污染补全表名', () => {
    const text = '/* old FROM fake */ SELECT * FROM users WHERE';
    const stmt = statementTextAt(text, text.indexOf('WHERE'));
    expect(stmt).toContain('FROM users');
    expect(stmt).not.toContain('fake');
  });
});

describe('streamSqlStatements', () => {
  function write(sql: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'devbelt-stream-sql-'));
    const file = join(dir, 'dump.sql');
    writeFileSync(file, sql);
    return file;
  }

  it('小块读取时 MySQL DELIMITER 例程切分与全量一致（DELIMITER 不当成美元引用）', async () => {
    // 注意：DELIMITER 与 PG 美元引用不能混写——切分器按「出现 DELIMITER」判定为
    // MySQL 语义并关闭美元引用识别（真实 dump 按方言二选一，见 split.ts 注释）。
    const { splitSqlWithRanges } = await import('@devkit/db-core/sql');
    const sql = [
      'INSERT INTO t VALUES (1);',
      'INSERT INTO t VALUES (2);',
      'DELIMITER $$',
      'CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END$$',
      'DELIMITER ;',
    ].join('\n');
    const full = splitSqlWithRanges(sql).map((s) => s.sql);
    expect(full).toEqual([
      'INSERT INTO t VALUES (1)',
      'INSERT INTO t VALUES (2)',
      'CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END',
    ]);
    const file = write(sql);
    try {
      for (const chunk of [16, 64, 1024]) {
        const out: string[] = [];
        for await (const stmt of streamSqlStatements(file, undefined, chunk)) out.push(stmt);
        expect(out, `chunk=${chunk}`).toEqual(full);
      }
    } finally {
      rmSync(join(file, '..'), { recursive: true, force: true });
    }
  });

  it('小块读取时 PG 命名美元引用（$function$）不被切断', async () => {
    const file = write([
      'INSERT INTO t VALUES (1);',
      'CREATE FUNCTION f() RETURNS int AS $function$ SELECT 1; SELECT 2; $function$ LANGUAGE sql;',
    ].join('\n'));
    try {
      const out: string[] = [];
      for await (const stmt of streamSqlStatements(file, undefined, 24)) out.push(stmt);
      expect(out.length).toBe(2);
      expect(out.join('\n')).toContain('SELECT 2');
    } finally {
      rmSync(join(file, '..'), { recursive: true, force: true });
    }
  });

  it('与全量 splitSqlWithRanges 输出一致（多块尺寸 / 注释 / 引号 / CRLF / 未闭合）', async () => {
    const { splitSqlWithRanges } = await import('@devkit/db-core/sql');
    const samples = [
      "INSERT INTO t VALUES (1);\nINSERT INTO t VALUES (';not a split');\n",
      '-- leading comment\nSELECT 1;\n/* block ; comment */ SELECT 2;\n',
      "SELECT 'a''b' AS x; SELECT \"c;d\";\n",
      'SELECT 1;\r\nSELECT 2;\r\n',
      'SELECT 1;\nSELECT 2', // 末句无分号
      "SELECT 'unterminated\n; still one",
      'SELECT 1 /* trailing unterminated',
      // DELIMITER 指令（不应被当作美元引用，且指令行本身不产出语句）
      'INSERT INTO t VALUES (1);\nDELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; END$$\nDELIMITER ;\n',
      // 标识符名为 delimiter 时不应触发 DELIMITER 消歧；同一文件仍有美元引用
      'SELECT delimiter FROM t;\nCREATE FUNCTION f() RETURNS int AS $q$ SELECT 1; $q$ LANGUAGE sql;\n',
    ];
    for (const sql of samples) {
      const file = write(sql);
      try {
        for (const chunk of [1, 3, 7, 16, 1000]) {
          const streamed: string[] = [];
          for await (const stmt of streamSqlStatements(file, undefined, chunk)) streamed.push(stmt);
          const full = splitSqlWithRanges(sql).map((s) => s.sql);
          expect(streamed, `chunk=${chunk} sql=${JSON.stringify(sql)}`).toEqual(full);
        }
      } finally {
        rmSync(join(file, '..'), { recursive: true, force: true });
      }
    }
  });

  it('MySQL 反斜杠转义下与全量一致（跨块转义/引号）', async () => {
    const { splitSqlWithRanges } = await import('@devkit/db-core/sql');
    const sql = "SELECT 'a\\\\b'; SELECT 'c\\'d';";
    const opts = { backslashEscapes: true };
    const file = write(sql);
    try {
      for (const chunk of [1, 2, 5, 999]) {
        const streamed: string[] = [];
        for await (const stmt of streamSqlStatements(file, opts, chunk)) streamed.push(stmt);
        expect(streamed, `chunk=${chunk}`).toEqual(splitSqlWithRanges(sql, opts).map((s) => s.sql));
      }
    } finally {
      rmSync(join(file, '..'), { recursive: true, force: true });
    }
  });

  it('PG E 串跨块与全量一致（含 E 与引号被块边界分开）', async () => {
    const { splitSqlWithRanges } = await import('@devkit/db-core/sql');
    const sql = String.raw`SELECT E'\''; DELETE FROM t`;
    const opts = { escapeStringPrefix: true };
    const file = write(sql);
    try {
      for (const chunk of [1, 2, 5, 12]) {
        const streamed: string[] = [];
        for await (const stmt of streamSqlStatements(file, opts, chunk)) streamed.push(stmt);
        expect(streamed, `chunk=${chunk}`).toEqual(splitSqlWithRanges(sql, opts).map((s) => s.sql));
      }
    } finally {
      rmSync(join(file, '..'), { recursive: true, force: true });
    }
  });

  it('4 MiB 单条语句在小块流式下不为 O(n²)（20s 内完成）', async () => {
    const payload = 'a'.repeat(4 * 1024 * 1024);
    const sql = `INSERT INTO big VALUES ('${payload}');\nSELECT 1;\n`;
    const file = write(sql);
    try {
      const out: string[] = [];
      for await (const stmt of streamSqlStatements(file, undefined, 64 * 1024)) out.push(stmt);
      expect(out.length).toBe(2);
      expect(out[0].endsWith("')")).toBe(true);
      expect(out[1]).toBe('SELECT 1');
    } finally {
      rmSync(join(file, '..'), { recursive: true, force: true });
    }
  }, 20_000);
});

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(process.cwd(), 'src');

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts'))
    .map((e) => join(e.parentPath ?? (e as any).path, e.name));
}

/**
 * H1 治理：PG schema 必须来自**显式 schema**，绝不能从 `database` 推断。
 *
 * 结果面板过去用 `pgSchemaFor(conn, database)` 把库名当 schema；在「库名与某个
 * schema 同名」时会静默写到错误对象。这条断言拦住任何再次出现 `pgSchemaFor(…,
 * *.database)` 的写法。
 */
describe('H1：pgSchemaFor 只接受显式 schema', () => {
  it('源码中不存在 pgSchemaFor(…, *.database)', () => {
    const offenders: string[] = [];
    for (const file of tsFiles(SRC)) {
      const text = readFileSync(file, 'utf8');
      const re = /pgSchemaFor\s*\([^)]*\.database\b/g;
      if (re.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('H3：导入 SQL 脚本在 PG 非默认 schema 下设置 search_path', () => {
    const src = readFileSync(join(SRC, 'commands', 'database.ts'), 'utf8');
    expect(src).toContain('SET LOCAL search_path TO');
    // 只在 PG 且拿到 schema 时设置，不能影响 MySQL/SQLite。
    expect(src).toMatch(/conn\.dbType === DatabaseType\.PG && schema/);
  });

  it('pgSchemaFor 的形参名是 schema 而非 database', () => {
    const src = readFileSync(join(SRC, 'utils', 'sql.ts'), 'utf8');
    const m = /export function pgSchemaFor\(([\s\S]*?)\)\s*:/.exec(src);
    expect(m).toBeTruthy();
    expect(m![1]).toContain('schema');
    expect(m![1]).not.toContain('database');
  });
});
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => {
  class Position { constructor(public line: number, public character: number) {} }
  class Range { constructor(public start: Position, public end: Position) {} }
  class CodeLens { constructor(public range: Range, public command?: unknown) {} }
  return { Position, Range, CodeLens };
});

import { DatabaseType } from '@devbelt/db-core';
import { SqlCodeLensProvider } from '../../src/completion/sqlCodeLensProvider';

function doc(text: string): any {
  return {
    uri: { toString: () => 'file:///q.sql' },
    getText: () => text,
    positionAt: (offset: number) => ({ offset }),
  };
}

/** MySQL 文档：`#` 注释里的分号不得被 CodeLens 切开（否则会多出一个可执行 DROP 的 Run）。 */
const MYSQL_TEXT = 'SELECT 1 # note; DROP TABLE t';

describe('SqlCodeLensProvider 方言化切分', () => {
  it('MySQL 连接：`#` 注释内的分号不切分，只出一个 Run', async () => {
    const provider = new SqlCodeLensProvider(() => DatabaseType.MYSQL);
    const lenses = await provider.provideCodeLenses(doc(MYSQL_TEXT));
    expect(lenses).toHaveLength(1);
    expect((lenses[0].command as any).arguments[0]).toBe('SELECT 1 # note; DROP TABLE t');
  });

  it('PG 连接：`#` 是运算符，按分号切分', async () => {
    const provider = new SqlCodeLensProvider(() => DatabaseType.PG);
    const lenses = await provider.provideCodeLenses(doc(MYSQL_TEXT));
    expect(lenses).toHaveLength(2);
    expect((lenses[1].command as any).arguments[0]).toBe('DROP TABLE t');
  });

  it('未绑定文档：保守默认（按代码），不隐藏 `#` 后的语句', async () => {
    const provider = new SqlCodeLensProvider();
    const lenses = await provider.provideCodeLenses(doc(MYSQL_TEXT));
    expect(lenses).toHaveLength(2);
  });

  /**
   * MySQL NO_BACKSLASH_ESCAPES 下 `\'` 不转义：连接已建时必须用连接的扫描选项切分，
   * 否则 CodeLens 的语句边界与实际执行不一致（多/少一个 Run）。
   */
  it('注入 resolveScanOptions（NBE）后，切分与执行侧一致', async () => {
    const text = "SELECT 'a\\'; DROP TABLE t";
    // 默认（反斜杠转义）：`\'` 转义引号 → 字符串未闭合，整段是一条语句
    const base = new SqlCodeLensProvider(() => DatabaseType.MYSQL);
    expect(await base.provideCodeLenses(doc(text))).toHaveLength(1);
    // NBE：反斜杠不转义 → `'a\'` 闭合，DROP 成为第二条语句
    const nbe = new SqlCodeLensProvider(
      () => DatabaseType.MYSQL,
      () => ({ hashComment: true, dashDashRequiresSpace: true, backslashEscapes: false, escapeStringPrefix: false }),
    );
    const lenses = await nbe.provideCodeLenses(doc(text));
    expect(lenses).toHaveLength(2);
    expect((lenses[1].command as any).arguments[0]).toContain('DROP TABLE t');
  });
});
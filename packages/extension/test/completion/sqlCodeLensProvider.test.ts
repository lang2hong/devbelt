import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => {
  class Position { constructor(public line: number, public character: number) {} }
  class Range { constructor(public start: Position, public end: Position) {} }
  class CodeLens { constructor(public range: Range, public command?: unknown) {} }
  return { Position, Range, CodeLens };
});

import { DatabaseType } from '@devkit/core';
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
});
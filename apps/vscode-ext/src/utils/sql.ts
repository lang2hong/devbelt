import { DatabaseType } from '@devkit/db-core';
import type { SavedConnection } from '@devkit/db-host/connection/connectionStore';
import { splitSqlWithRanges, stripSqlComments, SqlScanner, StreamingStatementSplitter } from '@devkit/db-core/sql';
import { createReadStream } from 'node:fs';
import type { SqlScanOptions } from '@devkit/db-core/sql';

/**
 * SQL 标识符包裹工具（统一 wrapIdent / wrapQualified，消除重复）。
 *
 * MySQL/SQLite 用反引号，PostgreSQL 用双引号。内嵌的引号必须按方言规则
 * 翻倍（`` ` ``→`` `` ``, `"`→`""`），否则含引号的库/表/列名会逃出标识符上下文。
 */
export function wrapIdent(dbType: DatabaseType, name: string): string {
  return dbType === DatabaseType.MYSQL
    ? '`' + name.replace(/`/g, '``') + '`'
    : '"' + name.replace(/"/g, '""') + '"';
}

/** 便捷版：基于已保存连接。 */
export function wrapIdentForConn(conn: SavedConnection, name: string): string {
  return wrapIdent(conn.dbType, name);
}

/**
 * 转义 SQL 字符串字面量内容（不含外层引号，防注入）。
 *
 * 转义规则按方言分流：MySQL 默认开启反斜杠转义，`\` 需翻倍；
 * PostgreSQL（standard_conforming_strings=on）与 SQLite 中反斜杠无转义语义，
 * 若照 MySQL 规则翻倍会把一个反斜杠写成两个字面反斜杠，导致匹配错误行。
 *
 * `dbType` 是**必填**：原先可省略并默认按 MySQL 处理，一旦调用方漏传，
 * PG/SQLite 上就会静默过度转义。方言差异不该有「默认值」。
 */
export function escapeSqlString(value: string, dbType: DatabaseType): string {
  const escaped = String(value).replace(/'/g, "''");
  return dbType === DatabaseType.MYSQL
    ? escaped.replace(/\\/g, '\\\\')
    : escaped;
}

/**
 * 语句切分复用 `@devkit/db-core/sql`（全仓唯一词法来源）。
 *
 * 编辑器侧语义：保留注释、带位置（供 CodeLens）。db-core 侧另有
 * `splitExecutableStatements`（丢弃注释），两者共享同一 lexer。
 */
export { splitSqlWithRanges };
export type { SqlStatementRange } from '@devkit/db-core/sql';

/**
 * 拆分 SQL 语句（按分号，感知引号、注释、美元引用与 DELIMITER）。
 * 只要文本不要位置时用这个；需要位置见 `splitSqlWithRanges`。
 */
export function splitSqlStatements(sql: string, options?: SqlScanOptions): string[] {
  return splitSqlWithRanges(sql, options).map((s) => s.sql);
}

/**
 * 流式拆分 SQL 文件：分块读取、增量切分，恢复大 dump 时不再把整个文件读进内存。
 *
 * 用有状态的 `SqlScanner` + `StreamingStatementSplitter` 增量切分：每块只处理新增文本
 * （不再对累积 buffer 反复全量 `splitSqlWithRanges`，消除大单语句下的 O(n²)）。
 * 词法规则仍来自 db-core 的同一实现，跨块引号/注释/美元引用/DELIMITER 不会被误切。
 */
const DELIMITER_LINE = /^[ \t]*DELIMITER[ \t]+\S/i;

/**
 * 预扫描判定脚本是否在代码区使用 `DELIMITER` 指令。
 *
 * 与 db-core 全量 `usesDelimiterDirective` 同口径（非代码段掩成单个空格、按行首匹配）。
 * 必须**先**判定再切分：`$$` 在 `DELIMITER $$` 里是结束符，在 PG 里是美元引用，
 * 逐块即时判定会因「scanner 已把 `$$` 当美元引用消费」而错过（且结果随块大小变化）。
 */
async function usesDelimiterDirectiveStream(
  filePath: string,
  options: SqlScanOptions | undefined,
  chunkSize: number,
): Promise<boolean> {
  const stream = createReadStream(filePath, { encoding: 'utf8', highWaterMark: chunkSize });
  const scanner = new SqlScanner(options, false);
  let line = '';
  let found = false;
  const consume = (masked: string): void => {
    let start = 0;
    for (let i = 0; i < masked.length; i++) {
      if (masked[i] === '\n') {
        line += masked.slice(start, i);
        if (DELIMITER_LINE.test(line)) found = true;
        line = '';
        start = i + 1;
      }
    }
    line += masked.slice(start);
  };
  for await (const chunk of stream) {
    for (const seg of scanner.push(chunk as string)) consume(seg.kind === 'code' ? seg.text : ' ');
  }
  for (const seg of scanner.finish()) consume(seg.kind === 'code' ? seg.text : ' ');
  if (DELIMITER_LINE.test(line)) found = true;
  return found;
}

/** 流式切分 SQL 文件（见 `streamSqlStatements`）。 */
export async function* streamSqlStatements(
  filePath: string,
  options?: SqlScanOptions,
  chunkSize = 1 << 20,
): AsyncGenerator<string> {
  // 先判定 DELIMITER（决定 `$$` 语义），再正式切分，保证与全量 splitSqlWithRanges 一致。
  const dollarQuotes = !(await usesDelimiterDirectiveStream(filePath, options, chunkSize));
  const stream = createReadStream(filePath, { encoding: 'utf8', highWaterMark: chunkSize });
  const scanner = new SqlScanner(options, dollarQuotes);
  const splitter = new StreamingStatementSplitter();
  for await (const chunk of stream) {
    for (const seg of scanner.push(chunk as string)) {
      for (const stmt of splitter.push(seg)) yield stmt;
    }
  }
  for (const seg of scanner.finish()) {
    for (const stmt of splitter.push(seg, true)) yield stmt;
  }
  for (const stmt of splitter.finish()) yield stmt;
}

/**
 * 光标所在语句的文本（含光标前的部分即可满足补全上下文）。
 *
 * 补全过去对整篇文档解析 FROM/JOIN，多语句文件里会取到**第一个** FROM，
 * 导致第二段之后（尤其是复制的脚本）补全候选错位。这里限定到光标所在语句。
 * 光标落在语句间隙（分号后空白）时返回空串。
 *
 * 返回值已剥离普通注释：`splitSqlWithRanges` 为 CodeLens 保留注释，而 `seg.sql`
 * 会连同语句前的注释一起返回；若注释里出现 `FROM`/`JOIN`，补全会解析到错误表。
 */
export function statementTextAt(
  text: string,
  offset: number,
  options?: SqlScanOptions,
): string {
  for (const seg of splitSqlWithRanges(text, options)) {
    if (offset >= seg.start && offset <= seg.end) return stripSqlComments(seg.sql, options);
  }
  return '';
}

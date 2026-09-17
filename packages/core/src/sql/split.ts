import { scanSql, type SqlScanOptions } from './lexer.js';

/**
 * 两套切分适配器，共用 `./lexer` 的词法规则：
 *  - `splitSqlWithRanges`：编辑器侧（CodeLens / 查询面板）——保留注释、带位置。
 *  - `splitExecutableStatements`：db-core 侧（同步/备份）——丢弃注释、只要文本。
 *
 * 语义差异是刻意的（是否保留注释、是否要 range），但「什么算注释/字面量/美元引用」
 * 只有 lexer 一处实现，杜绝两侧规则漂移。
 */

/** 一条语句及其在源文本中的位置（供 CodeLens 定位）。 */
export interface SqlStatementRange {
  /** 语句文本（已 trim，不含结尾分号） */
  sql: string;
  /** 语句首字符在源文本中的偏移 */
  start: number;
  /** 语句末字符之后的偏移 */
  end: number;
}

/** MySQL 客户端 `DELIMITER` 指令（仅出现在语句起始处的整行；容忍 CRLF 的 `\r`）。 */
const DELIMITER_LINE_RE = /^DELIMITER[\t ]+(\S+)[\t ]*\r?$/i;
/** 可跨行匹配的 DELIMITER 指令（用于 db-core 的流式切分）。 */
const DELIMITER_RE = /^DELIMITER[\t ]+(\S+)[\t ]*(?:\r?\n|$)/i;

interface DelimiterDirective {
  delimiter: string;
  /** 指令行之后的下一个位置 */
  next: number;
}

/**
 * 若 `p` 处是一条位于语句起始处的 `DELIMITER <token>` 整行指令，则解析它。
 * 指令是 MySQL 客户端命令、驱动不认，因此切分器要消费掉而不是当语句执行。
 *
 * 「语句起始」由调用方用 `sawCode` 判定（是否已见到代码字符）——不能看原文
 * `slice(segStart,p).trim()`，否则语句前的**注释**（独立 segment、原文保留）
 * 会让它非空，导致 `-- c\nDELIMITER $$` 这类指令失配。
 */
function matchDelimiterDirective(sql: string, p: number): DelimiterDirective | undefined {
  const nl = sql.indexOf('\n', p);
  const lineEnd = nl === -1 ? sql.length : nl;
  const m = DELIMITER_LINE_RE.exec(sql.slice(p, lineEnd));
  if (!m) return undefined;
  return { delimiter: m[1], next: lineEnd < sql.length ? lineEnd + 1 : lineEnd };
}

/**
 * 拆分 SQL 语句并记录位置（保留注释）。
 *
 * 引号上下文（单引号 / 双引号 / 反引号）、美元引用（`$$...$$`）、`--`
 * 行注释与块注释内的分号都不切分；`#` 仅当 `options.hashComment` 为真
 * （MySQL）时才当行注释；`/*! ... *\/`（MySQL 可执行注释）内容会被执行，
 * 参与切分。`DELIMITER` 指令切换当前结束符（用于 MySQL 例程体），
 * 指令自身不产出语句。
 */
export function splitSqlWithRanges(sql: string, options?: SqlScanOptions): SqlStatementRange[] {
  const result: SqlStatementRange[] = [];
  let segStart = 0;
  let delimiter = ';';
  /** 当前语句是否已出现代码字符（注释/空白不计），用于识别语句起始处的 DELIMITER。 */
  let sawCode = false;

  /** 把 [segStart, endExclusive) 去除首尾空白后作为一条语句收集。 */
  const flush = (endExclusive: number): void => {
    const raw = sql.slice(segStart, endExclusive);
    const trimmed = raw.trim();
    if (trimmed) {
      const lead = raw.length - raw.trimStart().length;
      const start = segStart + lead;
      result.push({ sql: trimmed, start, end: start + trimmed.length });
    }
    sawCode = false;
  };

  for (const seg of scanSql(sql, options)) {
    if (seg.kind !== 'code') continue;
    let p = seg.start;
    while (p < seg.end) {
      if (!sawCode) {
        const directive = matchDelimiterDirective(sql, p);
        if (directive) {
          delimiter = directive.delimiter;
          segStart = directive.next;
          p = directive.next;
          continue;
        }
      }
      if (delimiter && sql.startsWith(delimiter, p)) {
        flush(p);
        p += delimiter.length;
        segStart = p;
        continue;
      }
      if (!/\s/.test(sql[p])) sawCode = true;
      p++;
    }
  }

  flush(sql.length);
  return result;
}

/**
 * 按结束符切分**可执行**语句，丢弃注释（普通块注释与行注释不产出语句，
 * MySQL 可执行注释 `/*! *\/` 内容保留）。`DELIMITER` 指令切换结束符且自身不是语句。
 *
 * 供 db-core 内部（同步 / 备份）使用：这些 SQL 由本仓生成，注释不需要保留。
 */
export function splitExecutableStatements(sql: string, options: SqlScanOptions = {}): string[] {
  const out: string[] = [];
  let buf = '';
  let delimiter = ';';

  const commit = (): void => {
    const stmt = buf.trim();
    if (stmt) out.push(stmt);
    buf = '';
  };

  for (const seg of scanSql(sql, options)) {
    // 普通注释丢弃；字符串/美元引用/可执行注释原文并入当前语句。
    if (seg.kind === 'comment') continue;
    if (seg.kind !== 'code') {
      buf += sql.slice(seg.start, seg.end);
      continue;
    }

    let p = seg.start;
    while (p < seg.end) {
      // DELIMITER 指令：仅出现在语句起始（buf 目前只有空白/被丢弃的注释）。
      if (buf.trim() === '' && (sql[p] === 'D' || sql[p] === 'd')) {
        const m = DELIMITER_RE.exec(sql.slice(p));
        if (m) {
          delimiter = m[1];
          p += m[0].length;
          continue;
        }
      }
      if (delimiter && sql.startsWith(delimiter, p)) {
        commit();
        p += delimiter.length;
        continue;
      }
      buf += sql[p];
      p++;
    }
  }

  commit();
  return out;
}
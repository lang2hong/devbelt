import { scanSql, type SqlScanOptions, type SqlScannedSegment } from './lexer.js';

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
 * 去掉普通注释（`--`、`#`、`/* … *\/`）后的文本，保留可执行注释（`/*! … *\/`）与
 * 字符串/美元引用原文。供补全侧扫描 FROM/JOIN：语句前的注释里若出现 `FROM`，
 * 会污染表名/别名解析，取到错误表。
 */
export function stripSqlComments(sql: string, options?: SqlScanOptions): string {
  let out = '';
  for (const seg of scanSql(sql, options)) {
    // 用空格而非直接删除：否则 `SELECT/*x*/FROM` 会粘连成 `SELECTFROM`，破坏词边界。
    if (seg.kind === 'comment') { out += ' '; continue; }
    out += sql.slice(seg.start, seg.end);
  }
  return out;
}

/**
 * 增量语句切分器：消费 `SqlScanner` 的分段，按结束符与 `DELIMITER` 指令切分。
 *
 * 语义对齐 `splitSqlWithRanges`（保留注释、丢弃 `DELIMITER` 指令、可执行注释内不切分），
 * 但每块只处理新增文本，供流式切分避免 O(n²)。
 */
export class StreamingStatementSplitter {
  private pieces: string[] = [];
  private delimiter = ';';
  private sawCode = false;
  /** 可能是结束符前缀的代码尾巴（跨分段）。 */
  private codeCarry = '';

  push(seg: SqlScannedSegment, final = false): string[] {
    if (seg.kind !== 'code') {
      // 暂存的分隔符前缀是真实代码字符，非代码段打断时须先归位，不能丢弃。
      if (this.codeCarry) { this.pieces.push(this.codeCarry); this.codeCarry = ''; }
      this.pieces.push(seg.text);
      return [];
    }
    return this.feedCode(seg.text, final);
  }

  finish(): string[] {
    const out = this.feedCode('', true);
    const stmt = this.pieces.join('').trim();
    this.pieces = [];
    this.codeCarry = '';
    this.sawCode = false;
    if (stmt) out.push(stmt);
    return out;
  }

  private feedCode(text: string, final: boolean): string[] {
    const combined = this.codeCarry + text;
    this.codeCarry = '';
    if (combined === '') return [];
    const out: string[] = [];
    let p = 0;
    let run = '';
    while (p < combined.length) {
      // 语句起始处可能是 DELIMITER 指令（且会被分块截断）：每个语句起点都探测，
      // 整行到手再判定。逐字符判会因 `DELIMITER $` 未拿到完整 token 而误判，且首字符
      // 会过早把 sawCode 置真。
      if (!this.sawCode) {
        const probe = combined.slice(p);
        const stripped = probe.replace(/^[ \t\r\n]*/, '');
        const up = stripped.toUpperCase();
        const maybeDirective = up === ''
          ? true
          : up.length <= 'DELIMITER'.length
            ? 'DELIMITER'.startsWith(up)
            : /^DELIMITER$/i.test(stripped) || /^DELIMITER[ \t]/.test(stripped);
        if (maybeDirective) {
          // 指令行是否已到齐：看候选文本（去掉前导空白）里有没有换行。
          if (!final && stripped.indexOf('\n') === -1) {
            if (run) { this.pieces.push(run); run = ''; }
            this.codeCarry = probe;
            return out;
          }
          const lead = probe.length - stripped.length;
          const directive = matchDelimiterDirective(probe, lead);
          if (directive) {
            this.pieces = [];
            this.delimiter = directive.delimiter;
            run = '';
            p += directive.next;
            continue;
          }
        }
      }
      if (this.delimiter && combined.startsWith(this.delimiter, p)) {
        this.pieces.push(run);
        run = '';
        const stmt = this.pieces.join('').trim();
        if (stmt) out.push(stmt);
        this.pieces = [];
        this.sawCode = false;
        p += this.delimiter.length;
        continue;
      }
      const ch = combined[p];
      run += ch;
      if (!/\s/.test(ch)) this.sawCode = true;
      p++;
    }
    // 结束符前缀跨分段的尾巴：暂存到下一次，不计入语句文本/sawCode。
    if (!final && this.delimiter.length > 1 && run.length > 0) {
      const maxKeep = Math.min(run.length, this.delimiter.length - 1);
      for (let k = maxKeep; k >= 1; k--) {
        if (this.delimiter.startsWith(run.slice(-k))) {
          this.codeCarry = run.slice(-k);
          run = run.slice(0, -k);
          break;
        }
      }
    }
    this.pieces.push(run);
    return out;
  }
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
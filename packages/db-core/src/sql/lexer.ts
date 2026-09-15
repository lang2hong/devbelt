/**
 * SQL 词法扫描器（全仓唯一实现）。
 *
 * 分类器（`@db-client/core/sql` 的骨架 + 上层 `sqlRisk`）与两套切分器
 * （编辑器侧保留注释/带 range、db-core 侧丢弃注释）都必须共用这里的规则，
 * 否则会出现「分类看不到的写、切分却执行了」这类绕过。
 *
 * 识别范围：
 *  - 行注释 `--`（所有方言；MySQL 要求后跟空白，见 `dashDashRequiresSpace`）
 *    与 `#`（仅 MySQL，须显式开启，见 `hashComment`）
 *  - 块注释 `/* ... *\/`
 *  - MySQL 可执行注释 `/*! ... *\/`（内容会被数据库执行，**不得**当惰性注释）
 *  - 引号字面量/标识符 `'` `"` `` ` ``（`'`/`"` 支持 MySQL 反斜杠转义）
 *  - 美元引用 `$$ ... $$` 与 `$tag$ ... $tag$`
 *
 * 扫描结果是连续的段（覆盖整个输入），消费方据此决定「哪些字符是语法骨架」。
 */

export type SqlSegmentKind = 'code' | 'string' | 'comment' | 'execComment' | 'dollar';

export interface SqlSegment {
  kind: SqlSegmentKind;
  /** 段首字符偏移（含） */
  start: number;
  /** 段末字符之后（不含） */
  end: number;
}

export interface SqlScanOptions {
  /**
   * 是否把 `#` 视为 MySQL 行注释。
   *
   * 默认 `false`（`#` 按代码处理）：PG 里 `#`/`#>`/`#-` 是运算符，若一刀切当注释，
   * `SELECT 1 # 2; DROP TABLE t` 会被判只读且不切分，而 PG simple query 仍会执行
   * 两条语句 —— 只读边界被绕过。只有确认是 MySQL 时才传 `true`。
   */
  hashComment?: boolean;
  /**
   * MySQL 的 `--` 只有在后跟空白/控制字符（或行尾）时才起注释作用；
   * 否则 `SELECT 1--2` 是减法（值为 3）。其余方言 `--` 恒为注释。
   */
  dashDashRequiresSpace?: boolean;
  /**
   * 字符串里反斜杠是否转义下一个字符。
   *
   * MySQL 默认开（`'a\'b'` 里 `\'` 不是结束）；PG 在默认
   * `standard_conforming_strings=on` 与 SQLite 下反斜杠是普通字符，`'a\'` 已在
   * `'` 处结束。默认 `true` 保持旧行为，PG/SQLite 需显式传 `false`。
   */
  backslashEscapes?: boolean;
}

interface CoreOptions {
  hashComment: boolean;
  dashDashSpace: boolean;
  dollarQuotes: boolean;
  backslashEscapes: boolean;
}

/** 匹配 `$` 处的美元引用起始标记（`$$` 或 `$tag$`）；不匹配返回 undefined。 */
function matchDollarTag(sql: string, at: number): string | undefined {
  const m = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(at));
  return m ? m[0] : undefined;
}

/**
 * 核心扫描。`dollarQuotes` 由调用方决定（DELIMITER 消歧的结果）。
 */
function scanCore(sql: string, opts: CoreOptions): SqlSegment[] {
  const segments: SqlSegment[] = [];
  const len = sql.length;
  const { hashComment, dashDashSpace, dollarQuotes } = opts;
  let i = 0;
  let codeStart = 0;

  const flushCode = (end: number): void => {
    if (end > codeStart) segments.push({ kind: 'code', start: codeStart, end });
  };

  while (i < len) {
    const ch = sql[i];
    const next = i + 1 < len ? sql[i + 1] : '';

    // 行注释：--（MySQL 需后跟空白/控制/行尾）与（仅 MySQL）#
    const dashDash = ch === '-' && next === '-';
    const dashAllowed = dashDash
      && (!dashDashSpace || sql[i + 2] === undefined || /[\s\u0000-\u001f]/.test(sql[i + 2]));
    if (dashAllowed || (hashComment && ch === '#')) {
      flushCode(i);
      const nl = sql.indexOf('\n', i);
      const end = nl === -1 ? len : nl;
      segments.push({ kind: 'comment', start: i, end });
      i = end;
      codeStart = end;
      continue;
    }

    // 块注释：/*! 为 MySQL 可执行注释，内容仍需参与分类与切分
    if (ch === '/' && next === '*') {
      flushCode(i);
      const executable = sql[i + 2] === '!';
      const close = sql.indexOf('*/', i + 2);
      const end = close === -1 ? len : close + 2;
      segments.push({ kind: executable ? 'execComment' : 'comment', start: i, end });
      i = end;
      codeStart = end;
      continue;
    }

    // 引号字面量/标识符：' " `
    if (ch === "'" || ch === '"' || ch === '\x60') {
      flushCode(i);
      const start = i;
      const quote = ch;
      i++;
      while (i < len) {
        // MySQL 反斜杠转义：跳过被转义的下一个字符（反引号无此语义）
        if (quote !== '\x60' && opts.backslashEscapes && sql[i] === '\\') {
          i = Math.min(i + 2, len);
          continue;
        }
        if (sql[i] === quote) { i++; break; }
        i++;
      }
      segments.push({ kind: 'string', start, end: i });
      codeStart = i;
      continue;
    }

    // 美元引用：$$ 或 $tag$，整体视为字面量（DELIMITER 脚本按 MySQL 语义关闭）
    if (dollarQuotes && ch === '$') {
      const tag = matchDollarTag(sql, i);
      if (tag) {
        flushCode(i);
        const close = sql.indexOf(tag, i + tag.length);
        const end = close === -1 ? len : close + tag.length;
        segments.push({ kind: 'dollar', start: i, end });
        i = end;
        codeStart = end;
        continue;
      }
    }

    i++;
  }

  flushCode(len);
  return segments;
}

/**
 * 脚本是否在**代码区**使用 MySQL 客户端 `DELIMITER` 指令。
 *
 * 同一串 `$$` 在 PG 里是美元引用、在 MySQL 例程脚本里是 `DELIMITER $$` 的结束符，
 * 无法逐字符区分，故按脚本整体消歧：只要代码区出现 `DELIMITER` 指令，就关闭美元
 * 引用识别，否则按 PG 处理。
 *
 * 先以「`$` 当普通字符」扫一遍，并把非代码段（字符串/注释）替换为空格再匹配，
 * 避免字符串/注释里出现的 `DELIMITER` 误关 PG 美元引用。
 */
export function usesDelimiterDirective(sql: string): boolean {
  const masked = scanCore(sql, { hashComment: false, dashDashSpace: false, dollarQuotes: false, backslashEscapes: true })
    .map((seg) => (seg.kind === 'code' ? sql.slice(seg.start, seg.end) : ' '))
    .join('');
  return /(^|\n)[ \t]*DELIMITER[ \t]+\S/i.test(masked);
}

/**
 * 全量扫描 SQL，返回按出现顺序排列、互不重叠且覆盖整个输入的段。
 */
export function scanSql(sql: string, options: SqlScanOptions = {}): SqlSegment[] {
  return scanCore(sql, {
    hashComment: options.hashComment === true,
    dashDashSpace: options.dashDashRequiresSpace === true,
    dollarQuotes: !usesDelimiterDirective(sql),
    backslashEscapes: options.backslashEscapes !== false,
  });
}

/**
 * 生成用于关键字分类的「语法骨架」：
 * 保留代码与可执行注释文本，其余（字符串、注释、美元字面量）替换为空格。
 *
 * 替换为空格而非删除，避免 `a'x'b` 粘连成新词。
 */
export function sqlSkeleton(sql: string, options: SqlScanOptions = {}): string {
  let out = '';
  for (const seg of scanSql(sql, options)) {
    if (seg.kind === 'code' || seg.kind === 'execComment') out += sql.slice(seg.start, seg.end);
    else out += ' ';
  }
  return out;
}
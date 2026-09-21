/**
 * SQL 词法扫描器（全仓唯一实现）。
 *
 * 分类器（`@devbelt/db-core/sql` 的骨架 + 上层 `sqlRisk`）与两套切分器
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
   * **默认 `false`（SQL 标准）**：PG 在默认 `standard_conforming_strings=on` 与
   * SQLite 下反斜杠是普通字符，`'a\'` 已在 `'` 处结束。MySQL 需显式传 `true`
   * （经 `dialectScanOptions` 派生）。此前默认 `true` 会让「忘记传选项」的 PG
   * 路径按 MySQL 语义误判。
   */
  backslashEscapes?: boolean;
  /**
   * 是否识别 `E'...'` / `e'...'` 转义字符串前缀（PostgreSQL）。
   *
   * E 串即使 `standard_conforming_strings=on` 也启用反斜杠转义；不识别会把
   * `\'` 当作闭合引号，使后续写语句被吞进「字符串」，切分与只读分类同时失效。
   */
  escapeStringPrefix?: boolean;
}

interface CoreOptions {
  hashComment: boolean;
  dashDashSpace: boolean;
  dollarQuotes: boolean;
  backslashEscapes: boolean;
  escapeStringPrefix: boolean;
}

/** 匹配 `$` 处的美元引用起始标记（`$$` 或 `$tag$`）。tag 须以字母/下划线开头（SQL 标识符规则）。 */
function matchDollarTag(sql: string, at: number): string | undefined {
  const m = /^\$([A-Za-z_][A-Za-z_0-9]*)?\$/.exec(sql.slice(at));
  return m ? m[0] : undefined;
}

/**
 * 判定 `quoteIndex` 处的单引号是否为 `E'...'` 转义串的起始：前一个字符是
 * `E`/`e`，且再前一个不是标识符字符（避免把 `NAME'...'` 这类粘连误判）。
 */
function isEscapeStringPrefix(sql: string, quoteIndex: number): boolean {
  const e = quoteIndex > 0 ? sql[quoteIndex - 1] : '';
  if (e !== 'E' && e !== 'e') return false;
  const before = quoteIndex > 1 ? sql[quoteIndex - 2] : '';
  return !/[A-Za-z0-9_$]/.test(before);
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
      const escapeString = quote === "'" && opts.escapeStringPrefix && isEscapeStringPrefix(sql, start);
      i++;
      while (i < len) {
        // MySQL 反斜杠转义（以及 PG E 串）：跳过被转义的下一个字符（反引号无此语义）
        if (quote !== '\x60' && (opts.backslashEscapes || escapeString) && sql[i] === '\\') {
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
 *
 * 结果按 SQL 原文缓存：`scanSql` 与 `sqlSkeleton` 会对同一 SQL 各调用一次本函数，
 * 缓存省掉重复的整串扫描。仅缓存有限长度的 SQL 并对条目数设上限，避免大脚本占内存。
 */
const DELIMITER_CACHE = new Map<string, boolean>();
const DELIMITER_CACHE_MAX = 256;
const DELIMITER_CACHE_MAX_SQL = 8192;

export function usesDelimiterDirective(sql: string): boolean {
  const cached = DELIMITER_CACHE.get(sql);
  if (cached !== undefined) return cached;
  const masked = scanCore(sql, { hashComment: false, dashDashSpace: false, dollarQuotes: false, backslashEscapes: true, escapeStringPrefix: false })
    .map((seg) => (seg.kind === 'code' ? sql.slice(seg.start, seg.end) : ' '))
    .join('');
  const result = /(^|\n)[ \t]*DELIMITER[ \t]+\S/i.test(masked);
  if (sql.length <= DELIMITER_CACHE_MAX_SQL) {
    if (DELIMITER_CACHE.size >= DELIMITER_CACHE_MAX) {
      const oldest = DELIMITER_CACHE.keys().next().value;
      if (oldest !== undefined) DELIMITER_CACHE.delete(oldest);
    }
    DELIMITER_CACHE.set(sql, result);
  }
  return result;
}

/**
 * 全量扫描 SQL，返回按出现顺序排列、互不重叠且覆盖整个输入的段。
 */
export function scanSql(sql: string, options: SqlScanOptions = {}): SqlSegment[] {
  return scanCore(sql, {
    hashComment: options.hashComment === true,
    dashDashSpace: options.dashDashRequiresSpace === true,
    dollarQuotes: !usesDelimiterDirective(sql),
    backslashEscapes: options.backslashEscapes === true,
    escapeStringPrefix: options.escapeStringPrefix === true,
  });
}

/** 增量扫描产出的段：除 kind/偏移外附带该段文本。 */
export interface SqlScannedSegment extends SqlSegment {
  text: string;
}

/**
 * 增量词法扫描器。
 *
 * 规则与 `scanCore` 一致，但跨块保持引号/注释/美元引用状态，每字符只处理常数次；
 * 供流式切分使用，避免「每次对累积 buffer 调 `scanSql`」的 O(n²)。
 *
 * 代码段按 `push` 分块产出（不跨 push 合并），非代码段在闭合（或 final）时一次性
 * 产出并附带文本。消费方按序处理即可。
 */
export class SqlScanner {
  private readonly opts: CoreOptions;
  private buf = '';
  private bufBase = 0;
  private i = 0;
  private codeStart = 0;
  private state: 'code' | 'string' | 'line' | 'block' | 'dollar' = 'code';
  private quote = '';
  private escapeString = false;
  private dollarTag = '';
  private segKind: SqlSegmentKind = 'comment';
  private escPending = false;
  private deferred = false;

  constructor(options: SqlScanOptions = {}, dollarQuotes = true) {
    this.opts = {
      hashComment: options.hashComment === true,
      dashDashSpace: options.dashDashRequiresSpace === true,
      dollarQuotes,
      backslashEscapes: options.backslashEscapes === true,
      escapeStringPrefix: options.escapeStringPrefix === true,
    };
  }

  /** 关闭美元引用识别（流式检测到代码区 `DELIMITER` 指令后调用）。 */
  disableDollarQuotes(): void { this.opts.dollarQuotes = false; }

  push(chunk: string, final = false): SqlScannedSegment[] {
    this.buf += chunk;
    const out: SqlScannedSegment[] = [];
    this.deferred = false;
    while (this.i < this.buf.length && !this.deferred) {
      if (this.state === 'code') this.codeStep(out, final);
      else this.nonCodeStep(out, final);
    }
    // final 时若停在非代码段（上一 push 已消费到末尾，循环未进入），补齐关闭。
    if (final && this.state !== 'code') this.closeSeg(out, this.buf.length);
    if (this.state === 'code') {
      // 产出本 push 的代码段（不跨 push 合并）。开启 E 串识别时保留末尾至多 2 个
      // 代码字符，供下一次 push 判定「引号前是否为 E」——否则块边界恰好落在
      // `E` 与 `'` 之间会丢失前缀。延迟 token 未消费时保留会把它当作已消费而跳过，
      // 故此时不保留（与既有行为一致）。
      const pending = this.i - this.codeStart;
      const keep = this.opts.escapeStringPrefix && !this.deferred && !final
        ? Math.min(2, pending)
        : 0;
      const cut = this.i - keep;
      this.flushCode(out, cut);
      this.bufBase += cut;
      this.buf = this.buf.slice(cut);
      this.i = keep;
      this.codeStart = 0;
    } else if (this.codeStart > 0) {
      // 非代码未闭合：丢弃其前的代码前缀，保留整个未闭合段。
      this.bufBase += this.codeStart;
      this.buf = this.buf.slice(this.codeStart);
      this.i -= this.codeStart;
      this.codeStart = 0;
    }
    return out;
  }

  finish(): SqlScannedSegment[] { return this.push('', true); }

  private codeStep(out: SqlScannedSegment[], final: boolean): void {
    const len = this.buf.length;
    const ch = this.buf[this.i];
    const next = this.i + 1 < len ? this.buf[this.i + 1] : '';
    const dashDash = ch === '-' && next === '-';
    if (ch === '-' && next === '' && !final) { this.deferred = true; return; }
    if (dashDash && this.i + 2 >= len && !final) { this.deferred = true; return; }
    if (ch === '/' && next === '' && !final) { this.deferred = true; return; } // 可能是 '/*' 的一半
    const dashAllowed = dashDash
      && (!this.opts.dashDashSpace || this.buf[this.i + 2] === undefined || /[\s\u0000-\u001f]/.test(this.buf[this.i + 2]));
    if (dashAllowed || (this.opts.hashComment && ch === '#')) {
      this.flushCode(out, this.i);
      this.state = 'line'; this.segKind = 'comment'; this.i++; return;
    }
    if (ch === '/' && next === '*') {
      if (this.i + 2 >= len && !final) { this.deferred = true; return; }
      this.flushCode(out, this.i);
      this.state = 'block';
      this.segKind = this.buf[this.i + 2] === '!' ? 'execComment' : 'comment';
      this.i += 2; return;
    }
    if (ch === "'" || ch === '"' || ch === '\x60') {
      this.flushCode(out, this.i);
      this.state = 'string'; this.segKind = 'string'; this.quote = ch; this.escPending = false;
      this.escapeString = ch === "'" && this.opts.escapeStringPrefix && this.isEscapePrefixAt(this.i);
      this.i++; return;
    }
    if (this.opts.dollarQuotes && ch === '$') {
      const tag = matchDollarTag(this.buf, this.i);
      if (tag) {
        this.flushCode(out, this.i);
        this.state = 'dollar'; this.segKind = 'dollar'; this.dollarTag = tag; this.i += tag.length; return;
      }
      if (!final && /^\$[A-Za-z_0-9]*$/.test(this.buf.slice(this.i))) { this.deferred = true; return; }
    }
    this.i++;
  }

  private nonCodeStep(out: SqlScannedSegment[], final: boolean): void {
    const len = this.buf.length;
    if (this.state === 'line') {
      const nl = this.buf.indexOf('\n', this.i);
      if (nl === -1) {
        if (final) { this.closeSeg(out, len); return; }
        this.i = len; this.deferred = true; return;
      }
      this.closeSeg(out, nl); return;
    }
    if (this.state === 'block') {
      const close = this.buf.indexOf('*/', this.i);
      if (close === -1) {
        if (final) { this.closeSeg(out, len); return; }
        this.i = Math.max(this.i, len - 1); this.deferred = true; return;
      }
      this.closeSeg(out, close + 2); return;
    }
    if (this.state === 'dollar') {
      const close = this.buf.indexOf(this.dollarTag, this.i);
      if (close === -1) {
        if (final) { this.closeSeg(out, len); return; }
        this.i = Math.max(this.i, len - (this.dollarTag.length - 1)); this.deferred = true; return;
      }
      this.closeSeg(out, close + this.dollarTag.length); return;
    }
    // string
    while (this.i < len) {
      if (this.escPending) { this.escPending = false; this.i++; continue; }
      if ((this.opts.backslashEscapes || this.escapeString) && this.quote !== '\x60' && this.buf[this.i] === '\\') {
        if (this.i + 1 >= len && !final) { this.escPending = true; this.i = len; this.deferred = true; return; }
        this.i += 2; continue;
      }
      if (this.buf[this.i] === this.quote) { this.closeSeg(out, this.i + 1); return; }
      this.i++;
    }
    if (final) this.closeSeg(out, len);
    else this.deferred = true;
  }

  /** 引号前两字符是否构成 E 串前缀（跨分块时依赖 `push` 保留的尾部代码字符）。 */
  private isEscapePrefixAt(i: number): boolean {
    const e = i > 0 ? this.buf[i - 1] : '';
    if (e !== 'E' && e !== 'e') return false;
    const before = i > 1 ? this.buf[i - 2] : '';
    return !/[A-Za-z0-9_$]/.test(before);
  }

  /** 关闭当前非代码段并回到 code 状态。`codeStart` 即段起点。 */
  private closeSeg(out: SqlScannedSegment[], endLocal: number): void {
    out.push({
      kind: this.segKind,
      start: this.bufBase + this.codeStart,
      end: this.bufBase + endLocal,
      text: this.buf.slice(this.codeStart, endLocal),
    });
    this.state = 'code';
    this.escapeString = false;
    this.codeStart = endLocal;
    this.i = endLocal;
  }

  private flushCode(out: SqlScannedSegment[], endLocal: number): void {
    if (endLocal > this.codeStart) {
      out.push({
        kind: 'code',
        start: this.bufBase + this.codeStart,
        end: this.bufBase + endLocal,
        text: this.buf.slice(this.codeStart, endLocal),
      });
    }
    this.codeStart = endLocal;
  }
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
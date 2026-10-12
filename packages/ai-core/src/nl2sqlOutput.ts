/**
 * NL2SQL 输出解析（P9 S4，§6.7.1 C 输出契约）。
 *
 * 契约（nl2sql prompt 要求模型按此顺序输出）：
 *   1. `**意图理解：**<一句话复述>`（intentParaphrase）；
 *   2. ```sql 代码块（SQL 主体保持干净）；
 *   3. 可选 `Assumptions:` 区（≤3 条 bullet；无假设时 "Assumptions: none"）。
 *
 * 解析必须容忍真实模型的布局漂移（复述/假设在代码块前后、缺段、多个代码块、
 * 中英标签混用、Markdown 强调符），因此全部用"找得到就取、找不到给空"的宽松策略：
 * 解析失败不得抛错——调用方用空字段降级渲染即可。
 */

export interface ParsedSqlAnswer {
  /** 第一个 sql 语言标注代码块（无标注则取首个代码块）；无代码块为空串。 */
  sql: string;
  /** 一句话意图复述（去 Markdown 强调符）；缺失为空串。 */
  intentParaphrase: string;
  /** Assumptions 列表（≤3 条；"none" 视为空）。 */
  assumptions: string[];
}

const MAX_ASSUMPTIONS = 3;

export function parseSqlAnswer(text: string): ParsedSqlAnswer {
  return {
    sql: extractSql(text),
    intentParaphrase: extractParaphrase(text),
    assumptions: extractAssumptions(text),
  };
}

/** 代码块提取：优先 ```sql（大小写不敏感），否则第一个无标注代码块。 */
function extractSql(text: string): string {
  const blocks: Array<{ lang: string; content: string }> = [];
  const regex = /```([\w#+-]*)\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text))) {
    blocks.push({ lang: (match[1] ?? '').toLowerCase(), content: match[2] });
  }
  const sqlBlock = blocks.find((b) => b.lang === 'sql') ?? blocks.find((b) => b.lang === '');
  return sqlBlock ? sqlBlock.content.trim() : '';
}

function stripEmphasis(value: string): string {
  return value
    .replace(/\*\*/g, '')
    .replace(/[*_`]/g, '')
    .trim();
}

/**
 * 意图复述：支持 `**意图理解：**复述` / `意图理解: 复述` / `Intent: ...`。
 * 只取标签后同一行的剩余文本（复述契约是一行）。
 */
function extractParaphrase(text: string): string {
  const regex = /(?:意图理解|意图复述|Intent(?:\s+paraphrase)?)\s*[:：]\s*\**\s*(.*)/i;
  const match = regex.exec(text);
  if (!match) return '';
  const raw = match[1].split('\n')[0];
  return stripEmphasis(raw);
}

/**
 * 假设列表：定位 `Assumptions:` / `假设：` 标签，取其后到下一个标题/代码块之前
 * 的 bullet 行；无 bullet 时取标签同行剩余文本（单行形态）。
 * "none"/"无"/"（无）" 视为无假设。
 */
function extractAssumptions(text: string): string[] {
  const label = /(?:Assumptions?|假设)\s*[:：][ \t]*/i.exec(text);
  if (!label || label.index === undefined) return [];
  const after = text.slice(label.index + label[0].length);
  const lines = after.split('\n');
  const bullets: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (!trimmed) {
      if (bullets.length > 0) break; // bullet 列表结束
      continue;
    }
    if (/^(```|#{1,6}\s)/.test(trimmed)) break;
    const bullet = /^[-*•]\s*(.+)$/.exec(trimmed);
    if (bullet) {
      bullets.push(stripEmphasis(bullet[1]));
      if (bullets.length >= MAX_ASSUMPTIONS) break;
      continue;
    }
    if (i === 0) {
      // 标签同一行的行内形态：`Assumptions: none` / `Assumptions: 假设1；假设2`
      if (isNone(trimmed)) return [];
      const parts = trimmed.split(/[；;]/).map(stripEmphasis).filter(Boolean);
      if (parts.length > 0) return parts.slice(0, MAX_ASSUMPTIONS);
      break;
    }
    break; // 非 bullet 行 → 假设区结束
  }
  return bullets.filter((b) => b && !isNone(b)).slice(0, MAX_ASSUMPTIONS);
}

function isNone(value: string): boolean {
  const v = value.trim().toLowerCase().replace(/[（()）\s.。]/g, '');
  return v === 'none' || v === '无' || v === '无假设' || v === '暂无';
}
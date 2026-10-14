import { l10n } from '../i18n';

/**
 * AI Chat「在对话中运行」的 SQL 结果回帖格式化（纯函数，可单测）。
 *
 * 有结果集 → Markdown 表格（列头 + 前 MAX_ROWS 行，单元格单行化/截断/转义；超出注记）；
 * 写语句（无字段且无行）→ 仅标题「执行完成」；无字段但有行（异常驱动）→ JSON 预览回退；
 * 错误 → 错误信息 + 失败标题。
 */
export interface SqlChatOutcomeInput {
  result?: { fields?: Array<{ name?: string }>; rows?: Array<Record<string, unknown>> } | undefined;
  error?: Error | undefined;
  costTime: number;
}

export interface SqlChatOutcome {
  title: string;
  content: string;
  isError: boolean;
  format: 'markdown';
}

const MAX_ROWS = 50;
const MAX_CELL_CHARS = 80;

export function formatSqlChatResult(input: SqlChatOutcomeInput): SqlChatOutcome {
  const ms = input.costTime;
  if (input.error) {
    return {
      title: l10n('ai.sql.chatErrorTitle', { ms }),
      content: input.error.message,
      isError: true,
      format: 'markdown',
    };
  }
  const fields = Array.isArray(input.result?.fields)
    ? input.result!.fields!.map((field) => String(field?.name ?? '')).filter((name) => name.length > 0)
    : [];
  const rows = Array.isArray(input.result?.rows) ? input.result!.rows! : [];
  if (fields.length === 0) {
    if (rows.length > 0) {
      // 无列名但有数据行（异常驱动返回）：退化为 JSON 预览，避免误报「执行完成」。
      const preview = JSON.stringify(rows.slice(0, MAX_ROWS), null, 2);
      return {
        title: l10n('ai.sql.chatTitle', { rows: rows.length, ms }),
        content: `\`\`\`json\n${preview}\n\`\`\``,
        isError: false,
        format: 'markdown',
      };
    }
    return { title: l10n('ai.sql.chatOkTitle', { ms }), content: '', isError: false, format: 'markdown' };
  }
  const shown = Math.min(rows.length, MAX_ROWS);
  const lines = [
    `| ${fields.map((name) => cell(name)).join(' | ')} |`,
    `| ${fields.map(() => '---').join(' | ')} |`,
  ];
  for (const row of rows.slice(0, MAX_ROWS)) {
    lines.push(`| ${fields.map((name) => cell(row?.[name])).join(' | ')} |`);
  }
  if (rows.length > MAX_ROWS) {
    lines.push('', l10n('ai.sql.chatTruncated', { shown, total: rows.length }));
  }
  return {
    title: l10n('ai.sql.chatTitle', { rows: rows.length, ms }),
    content: lines.join('\n'),
    isError: false,
    format: 'markdown',
  };
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value);
  // 先单行化、再截断、最后转义：避免截断切断转义序列（`\\`/`\|`）。
  const singleLine = text.replace(/\r?\n/g, ' ');
  const cut = singleLine.length > MAX_CELL_CHARS ? `${singleLine.slice(0, MAX_CELL_CHARS - 1)}…` : singleLine;
  return cut.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}
import type { ToolCall } from '@devbelt/ai-core';
import type { ToolDefinition } from '@devbelt/agent-core';
import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import type { MonitorProposal, MonitorService, ProposalInput } from '../monitor/monitorService';
import type { MonitorCondition, MonitorKind } from '../monitor/monitorTypes';
import type { ToolOutcome } from './runner.js';

export const MONITOR_TOOL_NAME = 'propose_monitor';

/** 拒绝原因给模型看的可读说明（模型原样转告用户，不暴露内部代码）。 */
const REJECTION_TEXT: Record<string, string> = {
  otherWindow: '监控任务由另一个 VS Code 窗口执行。请到那个窗口操作，或在界面上点「在此窗口执行」后重试。',
  duplicate: '这张表已经有相同的监控任务了，可以在「后台任务」里查看。',
  production: '生产连接默认不允许创建监控。',
  connectionLimit: '这个连接最多 5 个监控任务，请先删除不需要的。',
  totalLimit: '监控任务总数已达上限，请先删除不需要的。',
  conditionInvalid: '提醒条件不合法，请重新选择类型和数值。',
  conditionMissing: '还没有选择提醒条件，请让用户在卡片上选择。',
  disabled: '数据监控已关闭（设置 devbelt.ai.monitor.enabled）。',
  unsupportedEngine: '只支持 MySQL、PostgreSQL、SQLite 表。',
  validation: '提案没有通过校验。',
};

/**
 * Agent 工具 `propose_monitor`（P13）：只校验并生成「监控提案」，**不创建任务**。
 * 提案以卡片形式出现在对话里，用户点击确认后才由扩展再校验一次并创建。
 *
 * 风险级别 R1（只读试执行 / 读元数据）；不暴露给 MCP。目标连接 / 库 / schema 由
 * Agent 会话固定，参数里没有这些字段（guard 也拒绝保留参数名）。
 */
export const MONITOR_TOOL_DEFINITION: ToolDefinition = {
  name: MONITOR_TOOL_NAME,
  description: [
    'Propose a background monitoring task for a table on the current connection; it is NOT created until the user confirms the card.',
    'kind=rowCount watches COUNT(*). kind=metric needs one read-only SELECT returning 1 row and 1-10 numeric columns; watchColumn is the column compared by the alert.',
    'kind=newRows needs cursorColumn: an existing monotonic integer or datetime column of that table (use describe_table first; never invent one).',
    'Only set conditionType/conditionValue when the user said when to be alerted; otherwise omit both and let the user choose on the card. Never invent a threshold.',
    "Map intent, don't invert it: 'no new data for N minutes' = SQL computing the lag in seconds + above N*60; 'fewer than N' = below N; 'more than N new rows' = kind=newRows + increaseBy N; 'any change' = anyChange.",
  ].join(' '),
  riskClass: 'R1',
  engines: ['MYSQL', 'PG', 'SQLITE'],
  mcp: false,
  parameters: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['rowCount', 'metric', 'newRows'] },
      table: { type: 'string', maxLength: 128 },
      label: { type: 'string', maxLength: 80 },
      sql: { type: 'string', maxLength: 4000 },
      watchColumn: { type: 'string', maxLength: 128 },
      cursorColumn: { type: 'string', maxLength: 128 },
      intervalMinutes: { type: 'integer', minimum: 1, maximum: 1440 },
      conditionType: { type: 'string', enum: ['anyChange', 'increaseBy', 'decreaseBy', 'changePercent', 'above', 'below'] },
      conditionValue: { type: 'number' },
    },
    required: ['kind', 'table'],
    additionalProperties: false,
  },
};

export interface MonitorToolHost {
  service: MonitorService;
  conn: SavedConnection;
  database?: string;
  schema?: string;
  /** 把提案交给 webview 渲染成卡片（不创建任务）。 */
  onProposal(proposal: MonitorProposal): void;
}

/** 参数 → 提案输入（guard 已做类型 / 白名单校验，这里只做组装）。 */
/** 条件的中文说明（工具结果里回给模型，要求它原样转述）。 */
export function conditionTextOf(input: { kind: string; condition?: MonitorCondition; watchColumn?: string }): string {
  const c = input.condition;
  if (!c) return '未设置（由用户在卡片上选择）';
  const n = 'value' in c ? c.value : 0;
  const text = (() => {
    switch (c.type) {
      case 'anyChange': return input.kind === 'newRows' ? '有新增行时提醒' : '任何变化时提醒';
      case 'increaseBy': return input.kind === 'newRows' ? `本次新增 ≥ ${n} 行时提醒` : `增加 ≥ ${n} 时提醒`;
      case 'above': return input.kind === 'newRows' ? `本次新增 > ${n} 行时提醒` : `高于 ${n} 时提醒`;
      case 'decreaseBy': return `减少 ≥ ${n} 时提醒`;
      case 'changePercent': return `变化 ≥ ${n}% 时提醒`;
      case 'below': return `低于 ${n} 时提醒`;
    }
  })();
  return input.kind === 'metric' && input.watchColumn ? `${input.watchColumn}: ${text}` : text;
}

export function toProposalInput(args: Record<string, unknown>): ProposalInput {
  const kind = String(args.kind) as MonitorKind;
  const conditionType = typeof args.conditionType === 'string' ? args.conditionType : undefined;
  const condition = conditionType
    ? (conditionType === 'anyChange'
      ? { type: 'anyChange' }
      : { type: conditionType, value: Number(args.conditionValue) }) as MonitorCondition
    : undefined;
  return {
    kind,
    table: String(args.table ?? ''),
    ...(typeof args.label === 'string' && args.label.trim() ? { label: args.label.trim() } : {}),
    ...(typeof args.intervalMinutes === 'number' ? { intervalMinutes: args.intervalMinutes } : {}),
    ...(condition ? { condition } : {}),
    ...(typeof args.sql === 'string' ? { sql: args.sql } : {}),
    ...(typeof args.watchColumn === 'string' ? { watchColumn: args.watchColumn } : {}),
    ...(typeof args.cursorColumn === 'string' ? { cursorColumn: args.cursorColumn } : {}),
  };
}

export function buildMonitorTool(host: MonitorToolHost): {
  definition: ToolDefinition;
  handles(name: string): boolean;
  execute(call: ToolCall, args: Record<string, unknown>): Promise<ToolOutcome>;
} {
  return {
    definition: { ...MONITOR_TOOL_DEFINITION },
    handles: (name) => name === MONITOR_TOOL_NAME,
    execute: async (_call, args) => {
      const result = await host.service.propose(host.conn, host.database, host.schema, toProposalInput(args));
      if (!result.ok) {
        const issues = result.issues.map((i) => `${i.code}${i.detail ? `(${i.detail})` : ''}`).join(', ');
        const readable = REJECTION_TEXT[result.reason] ?? result.reason;
        return {
          content: JSON.stringify({
            created: false,
            rejected: result.reason,
            message: readable,
            issues,
            note: 'Tell the user this in their language; do not repeat internal codes like otherWindow.',
          }),
          isError: true,
          errorCode: result.reason,
          summary: `监控提案被拒绝：${readable}${issues ? `（${issues}）` : ''}`,
        };
      }
      host.onProposal(result.proposal);
      const p = result.proposal;
      return {
        content: JSON.stringify({
          created: false,
          status: 'awaiting_user_confirmation',
          note: 'A confirmation card is shown to the user. Tell the user to review and click it; do not claim the task is running.',
          proposal: {
            kind: p.kind,
            table: p.table,
            intervalMinutes: Math.round(p.intervalMs / 60_000),
            ...(p.condition ? { condition: p.condition, conditionText: conditionTextOf(p) } : {}),
            ...(p.watchColumn ? { watchColumn: p.watchColumn } : {}),
            ...(p.preview ? { currentValues: p.preview } : {}),
            ...(p.cursorColumn ? { cursorColumn: p.cursorColumn } : {}),
            warnings: p.warnings.map((w) => w.code),
          },
        }),
        summary: `已生成监控提案：${p.label ?? p.table}（${conditionTextOf(p)}，待你确认）`,
      };
    },
  };
}

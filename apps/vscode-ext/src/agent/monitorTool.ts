import type { ToolCall } from '@devbelt/ai-core';
import type { ToolDefinition } from '@devbelt/agent-core';
import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import type { MonitorProposal, MonitorService, ProposalInput } from '../monitor/monitorService';
import type { MonitorCondition, MonitorKind } from '../monitor/monitorTypes';
import type { ToolOutcome } from './runner.js';

export const MONITOR_TOOL_NAME = 'propose_monitor';

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
    'Propose a background monitoring task for a table on the current connection. It is NOT created until the user confirms the card shown in the chat.',
    'kind=rowCount: watch COUNT(*). kind=metric: provide one read-only SELECT returning exactly 1 row and 1-10 numeric columns; watchColumn is the column the notification compares.',
    'kind=newRows: provide cursorColumn, an existing monotonically increasing integer or datetime/timestamp column of that table (use describe_table first; never invent a column). If the table has no such column, do not call this tool with newRows: suggest rowCount or a metric instead.',
    'conditionType: anyChange | increaseBy | decreaseBy | changePercent | above | below; conditionValue is the number for it. For newRows use increaseBy (new rows >= N) or above (new rows > N).',
    'IMPORTANT: only set a condition when the user actually said when to be alerted. If the user only said what to watch (for example "monitor the per-minute upload volume"), omit conditionType/conditionValue entirely: the confirmation card asks the user to choose. Never invent a threshold, and never present one in your reply as if the user had asked for it.',
    'Translate the intent, do not invert the metric: "no new data for more than N minutes" -> SELECT that computes the lag in seconds and condition above N*60; "fewer than N" -> below N; "more than N new rows" -> kind=newRows with increaseBy N; "tell me on any change" -> anyChange. Do not compare a latest-timestamp column against a fixed value: that value goes stale.',
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
        return {
          content: JSON.stringify({ created: false, rejected: result.reason, issues }),
          isError: true,
          errorCode: result.reason,
          summary: `监控提案被拒绝：${result.reason}${issues ? `（${issues}）` : ''}`,
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

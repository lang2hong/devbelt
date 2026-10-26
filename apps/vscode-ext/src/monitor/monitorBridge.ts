import type { MonitorPoint, MonitorTask } from './monitorTypes';
import type { MonitorProposal } from './monitorService';
import type { ValidationIssue } from './monitorValidate';

/**
 * AI Chat ↔ 监控的桥（模块级单例，和 AiBridge 同一模式）：
 * 面板通过它读任务 / 历史 / 内存新增行，执行用户操作，确认 Agent 提案。
 * 监控模块未初始化（设置关闭）时 tryGet() 为 undefined，面板隐藏相关入口。
 */
export interface MonitorTaskView {
  id: string;
  kind: MonitorTask['kind'];
  label: string;
  connName: string;
  table: string;
  database?: string;
  schema?: string;
  status: MonitorTask['status'];
  pausedReason?: MonitorTask['pausedReason'];
  intervalMs: number;
  /** 结构化条件（编辑用）；任务一定有，提案可能没有。 */
  condition?: MonitorTask['condition'];
  conditionText: string;
  lastValue?: number;
  lastValues?: Record<string, number | null>;
  lastRunAt?: number;
  lastError?: string;
  columns?: string[];
  watchColumn?: string;
  cursorColumn?: string;
  sql?: string;
}

export interface MonitorDetail {
  task: MonitorTaskView;
  points: MonitorPoint[];
  /** B：最近一次新增行（内存）。 */
  rows?: { at: number; rows: Array<Record<string, unknown>>; more: boolean };
}

export interface MonitorBridgeHandlers {
  list(): MonitorTaskView[];
  detail(id: string): Promise<MonitorDetail | undefined>;
  action(id: string, action: 'resume' | 'pause' | 'runNow' | 'remove'): Promise<void>;
  resumeAll(): Promise<void>;
  confirm(proposalId: string, overrides?: { intervalMinutes?: number; condition?: unknown }): Promise<{ ok: true; task: MonitorTaskView } | { ok: false; reason: string; issues: ValidationIssue[] }>;
  /** 修改已创建任务的间隔 / 条件。 */
  edit(id: string, patch: { intervalMinutes?: number; condition?: unknown }): Promise<{ ok: true; task: MonitorTaskView } | { ok: false; reason: string }>;
  discard(proposalId: string): void;
  /** 本窗口是否执行（另一窗口持锁时只显示）。 */
  executing(): boolean;
  /** 任务列表变化（创建 / 状态 / 每次运行后）。 */
  onChanged(listener: () => void): { dispose(): void };
  /** 由 Agent 工具调用：生成提案后通知面板渲染卡片。 */
  describeProposal(proposal: MonitorProposal): MonitorProposalView;
}

export interface MonitorProposalView {
  id: string;
  kind: MonitorProposal['kind'];
  label: string;
  connName: string;
  table: string;
  database?: string;
  schema?: string;
  intervalMinutes: number;
  condition?: MonitorTask['condition'];
  conditionText: string;
  sql?: string;
  columns?: string[];
  watchColumn?: string;
  preview?: Record<string, number | null>;
  cursorColumn?: string;
  /** 校验提示：code 对应 `monitor.warning.<code>`，detail 为占位符值（如慢查询秒数）。 */
  warnings: Array<{ code: string; detail?: string }>;
}

export class MonitorBridge {
  private static instance: MonitorBridge | undefined;

  static init(handlers: MonitorBridgeHandlers): MonitorBridge {
    this.instance = new MonitorBridge(handlers);
    return this.instance;
  }

  static tryGet(): MonitorBridge | undefined {
    return this.instance;
  }

  static reset(): void {
    this.instance = undefined;
  }

  private constructor(readonly handlers: MonitorBridgeHandlers) {}
}

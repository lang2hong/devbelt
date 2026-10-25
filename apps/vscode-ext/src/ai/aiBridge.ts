import type { AiFeature, ChatMessage } from '@devbelt/ai-core';

/**
 * AI 能力桥（P9 S4）：让结果面板/表设计器等"叶子视图"在不改构造链的前提下
 * 发起 Chat 请求（对齐 AuditLogger.tryGet 的模块级单例模式）。
 *
 * 组合根（extension.ts）在 AI 初始化后 `AiBridge.init({...})` 注入打开 Chat 的能力；
 * 叶子视图用 `AiBridge.tryGet()?.requestChat(...)`，未初始化（AI 不可用）时返回
 * undefined，由调用方给用户明确提示而不是静默。
 */

/** 外部入口发起的一次 Chat 请求（messages 已由调用方用 ai-core prompt 构建器组装）。 */
export interface ExternalAiRequest {
  feature: AiFeature;
  messages: ChatMessage[];
  /** Chat 会话标题（新会话时使用，如"错误诊断"）。 */
  title: string;
  connName?: string;
  database?: string;
  /** 发起方连接 id：Chat 侧按场景（data-qa/nl2sql）注入连接级业务规则。 */
  connId?: string;
  /** 预填面板输入框（可选；如 0 行诊断的追问句式）。 */
  prefillInput?: string;
}

export interface AiBridgeHandlers {
  /** 打开/聚焦 Chat 面板并发起该请求（新会话；已存在面板则新建会话）。 */
  requestChat(request: ExternalAiRequest): void;
  /** 只打开面板并预填输入框，不发起请求、不消耗额度。 */
  prefillChat(text: string): void;
}

export class AiBridge {
  private static instance: AiBridge | undefined;

  static init(handlers: AiBridgeHandlers): AiBridge {
    this.instance = new AiBridge(handlers);
    return this.instance;
  }

  static tryGet(): AiBridge | undefined {
    return this.instance;
  }

  static reset(): void {
    this.instance = undefined;
  }

  private constructor(private readonly handlers: AiBridgeHandlers) {}

  /** 发起外部 Chat 请求；返回 false 表示 AI 桥未初始化（调用方提示"AI 未启用"）。 */
  requestChat(request: ExternalAiRequest): boolean {
    this.handlers.requestChat(request);
    return true;
  }

  /** 只预填对话输入框（不发送）；返回 false 表示 AI 桥未初始化。 */
  prefillChat(text: string): boolean {
    this.handlers.prefillChat(text);
    return true;
  }
}
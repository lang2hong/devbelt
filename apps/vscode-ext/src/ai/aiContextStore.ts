import type * as vscode from 'vscode';

/**
 * 连接级 AI 上下文存储（P9 S3）。
 *
 * 两种自由文本，**只存本地 Memento**、不进 SavedConnection/E2EE 同步：
 * - 域上下文（业务术语表）：`devbelt.ai.domainContext.<connId>`；
 * - 默认业务指令（如"金额单位是分"）：`devbelt.ai.defaultDirectives.<connId>`。
 *
 * 长度受控（单值 ≤ 2000 字符）：Memento 是同步落盘的 JSON，放任超长文本会拖慢
 * 启动读写；超限截断而不是拒绝（用户输入不应因存储细节丢失）。
 */
const MAX_TEXT_CHARS = 2000;

export const DOMAIN_CONTEXT_PREFIX = 'devbelt.ai.domainContext.';
export const DEFAULT_DIRECTIVES_PREFIX = 'devbelt.ai.defaultDirectives.';
export const LAST_SCOPE_PREFIX = 'devbelt.ai.lastScope.';

/** 连接级"上次选择的作用域"（P9 S7a：库/逻辑库/索引；单选切换）。 */
export interface AiScopeRef {
  kind: 'database' | 'redis-db' | 'index';
  value: string;
}

function normalize(raw: string | undefined | null): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  return trimmed.length > MAX_TEXT_CHARS ? trimmed.slice(0, MAX_TEXT_CHARS) : trimmed;
}

export class AiContextStore {
  constructor(private readonly memento: vscode.Memento) {}

  getDomainContext(connId: string): string {
    return normalize(this.memento.get<string>(`${DOMAIN_CONTEXT_PREFIX}${connId}`));
  }

  async setDomainContext(connId: string, text: string): Promise<void> {
    await this.memento.update(`${DOMAIN_CONTEXT_PREFIX}${connId}`, normalize(text) || undefined);
  }

  getDefaultDirectives(connId: string): string {
    return normalize(this.memento.get<string>(`${DEFAULT_DIRECTIVES_PREFIX}${connId}`));
  }

  async setDefaultDirectives(connId: string, text: string): Promise<void> {
    await this.memento.update(`${DEFAULT_DIRECTIVES_PREFIX}${connId}`, normalize(text) || undefined);
  }

  getLastScope(connId: string): AiScopeRef | undefined {
    const raw = this.memento.get<AiScopeRef>(`${LAST_SCOPE_PREFIX}${connId}`);
    if (raw && typeof raw.value === 'string' && raw.value) return raw;
    return undefined;
  }

  async setLastScope(connId: string, scope: AiScopeRef | undefined): Promise<void> {
    await this.memento.update(`${LAST_SCOPE_PREFIX}${connId}`, scope);
  }

  /** 连接被删除时清理三条键（幂等）。 */
  async clearForConnection(connId: string): Promise<void> {
    await this.memento.update(`${DOMAIN_CONTEXT_PREFIX}${connId}`, undefined);
    await this.memento.update(`${DEFAULT_DIRECTIVES_PREFIX}${connId}`, undefined);
    await this.memento.update(`${LAST_SCOPE_PREFIX}${connId}`, undefined);
  }
}
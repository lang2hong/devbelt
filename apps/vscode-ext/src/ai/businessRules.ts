/**
 * 连接级「业务规则」编辑的纯函数（无 vscode 依赖，host 与 webview 均可导入）。
 *
 * 业务术语（domainContext）与默认业务规则（defaultDirectives）在 UI 上合并为一个入口，
 * 但存储键与提示词区块保持分离（两者在 prompt 中的约束措辞不同）。
 */

/** 单段文本上限；与 aiContextStore 的 MAX_TEXT_CHARS 保持一致（store 写入时同样截断）。 */
export const BUSINESS_RULES_MAX_CHARS = 2000;

export interface BusinessRulesPayload {
  domainContext: string;
  defaultDirectives: string;
}

/**
 * 校验并规整 webview 上行的保存载荷：两段都必须是字符串，否则视为非法（返回 undefined）。
 * 规整：统一换行为 \n、首尾空白裁剪、超长截断。空串合法（表示清除该段）。
 */
export function parseBusinessRulesPayload(raw: unknown): BusinessRulesPayload | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const { domainContext, defaultDirectives } = raw as Record<string, unknown>;
  if (typeof domainContext !== 'string' || typeof defaultDirectives !== 'string') return undefined;
  return { domainContext: clean(domainContext), defaultDirectives: clean(defaultDirectives) };
}

function clean(text: string): string {
  const trimmed = text.replace(/\r\n?/g, '\n').trim();
  return trimmed.length > BUSINESS_RULES_MAX_CHARS ? trimmed.slice(0, BUSINESS_RULES_MAX_CHARS) : trimmed;
}

export interface BusinessRulesSummary {
  domainChars: number;
  directivesChars: number;
  configured: boolean;
}

/** 侧栏状态摘要：两段字数 + 是否配置过。 */
export function summarizeBusinessRules(domainContext: string, defaultDirectives: string): BusinessRulesSummary {
  const domainChars = domainContext.trim().length;
  const directivesChars = defaultDirectives.trim().length;
  return { domainChars, directivesChars, configured: domainChars > 0 || directivesChars > 0 };
}

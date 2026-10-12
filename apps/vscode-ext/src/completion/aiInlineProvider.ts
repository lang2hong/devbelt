import * as vscode from 'vscode';
import { DatabaseType } from '@devbelt/db-core';
import { buildInlineCompletionMessages, INLINE_NONE } from '@devbelt/ai-core';
import { readAiConfig, type AiService } from '../ai/aiService.js';
import { containsSecretSql } from '../utils/sqlSecret.js';
import { l10n } from '../i18n';
import {
  INLINE_AFTER_MAX,
  INLINE_BEFORE_MAX,
  collectReferenceTables,
  loadLightSchema,
} from './aiInlineContext.js';
import type { ConnectionContext } from '../connection/connectionContext.js';
import type { ConnectionManager } from '../connection/connectionManager.js';

/** 补全命令（命令面板入口；键位 Alt+/ 仅在开关开启时生效）。 */
export const INLINE_COMPLETE_COMMAND = 'devbelt.ai.inlineComplete';
/** 开关设置键（键位 when 与 provider 注册共用）。 */
export const INLINE_ENABLED_SETTING = 'ai.enableInlineCompletion';

const DEBOUNCE_MS = 300;
const TIMEOUT_MS = 5000;
const MAX_TOKENS = 128;

export interface AiInlineDeps {
  service: AiService;
  manager: ConnectionManager;
  connCtx: ConnectionContext;
}

/**
 * Inline 补全 provider（P9 S5，§6.11.5）。
 *
 * - **只在 `triggerKind === Invoke`（Alt+/ / 命令面板触发）时请求 AI**；普通打字
 *   （Automatic）立即返回 undefined——"默认不在每个按键自动触发"，成本可控。
 * - 300ms debounce（token 感知）、5s 超时、继续打字（token 取消）→ abort 在途请求。
 * - 只注入轻量 schema（当前语句引用表 + 外键邻接，≤1.5K tokens）；无打开会话或
 *   取不到元数据时降级为无 schema（不阻塞）。
 * - 光标前文本含口令字面量（`containsSecretSql`）→ 直接不发送。
 * - 返回单条 `InlineCompletionItem`（Tab 接受）；空补全/哨兵 `<none>`/围栏包裹 → 不下发。
 */
export class AiInlineProvider implements vscode.InlineCompletionItemProvider {
  constructor(private readonly deps: AiInlineDeps) {}

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    if (context.triggerKind !== vscode.InlineCompletionTriggerKind.Invoke) return undefined;
    if (!isInlineEnabled()) return undefined;
    if (!document.uri || document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled') {
      // 只对本地 SQL 文档生效；其它 scheme（vscode-vfs/输出等）不请求。
      return undefined;
    }

    const offset = document.offsetAt(position);
    const before = document.getText(
      new vscode.Range(document.positionAt(Math.max(0, offset - INLINE_BEFORE_MAX)), position),
    );
    if (!before.trim() || containsSecretSql(before)) return undefined;
    const after = document.getText(
      new vscode.Range(position, document.positionAt(Math.min(document.getText().length, offset + INLINE_AFTER_MAX))),
    );

    await debounce(DEBOUNCE_MS, token);
    if (token.isCancellationRequested) return undefined;

    const controller = new AbortController();
    const cancelSub = token.onCancellationRequested(() => controller.abort());
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const bound = this.deps.connCtx.getForDoc(document.uri.toString());
      let schemaText: string | undefined;
      if (bound) {
        const refs = collectReferenceTables(before);
        if (refs.length > 0) {
          const light = await loadLightSchema({
            manager: this.deps.manager,
            connId: bound.conn.id,
            dbType: String(bound.conn.dbType),
            ...(bound.db ? { database: bound.db } : {}),
            ...(bound.conn.dbType === DatabaseType.PG && bound.conn.schema ? { schema: bound.conn.schema } : {}),
            refs,
            includeComments: readAiConfig().includeColumnComments,
          });
          schemaText = light?.text;
        }
      }

      const config = readAiConfig();
      const result = await this.deps.service.chat(
        {
          model: config.model || 'default',
          messages: buildInlineCompletionMessages({
            before,
            ...(after.trim() ? { after } : {}),
            ...(schemaText ? { schemaText } : {}),
            ...(bound ? { dbType: String(bound.conn.dbType) } : {}),
          }),
          temperature: 0,
          maxTokens: MAX_TOKENS,
          feature: 'inline-completion',
        },
        {
          feature: 'inline-completion',
          ...(bound ? { connName: bound.conn.name } : {}),
          ...(bound?.db ? { database: bound.db } : {}),
        },
        controller.signal,
      );
      if (token.isCancellationRequested) return undefined;
      const text = sanitizeCompletion(result.content);
      if (!text) return undefined;
      return [new vscode.InlineCompletionItem(text, completionRange(document, position))];
    } catch {
      // abort/超时/未登录/未配置：补全静默（不打断输入），诊断留给服务层审计。
      return undefined;
    } finally {
      clearTimeout(timer);
      cancelSub.dispose();
    }
  }
}

/** 开关读取（provider 与命令/键位共用语义）。 */
export function isInlineEnabled(): boolean {
  return vscode.workspace.getConfiguration('devbelt').get<boolean>(INLINE_ENABLED_SETTING, false);
}

/**
 * 注册 provider：按配置决定是否注册；配置变更即时重建（关闭 → dispose 旧 provider）。
 * 键位 `Alt+/` 的 when 亦引用同一配置（VS Code `config.*` when 上下文）。
 */
export function registerAiInlineProvider(deps: AiInlineDeps): vscode.Disposable {
  let provider: vscode.Disposable | undefined;
  const sync = (): void => {
    provider?.dispose();
    provider = undefined;
    if (!isInlineEnabled()) return;
    provider = vscode.languages.registerInlineCompletionItemProvider({ language: 'sql' }, new AiInlineProvider(deps));
  };
  sync();
  const listener = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(`devbelt.${INLINE_ENABLED_SETTING}`)) sync();
  });
  return {
    dispose(): void {
      listener.dispose();
      provider?.dispose();
    },
  };
}

/** 命令入口：开关关闭时引导开启；开启时触发内置 inline suggest（调用 provider Invoke 分支）。 */
export async function triggerInlineCompletion(): Promise<void> {
  if (!isInlineEnabled()) {
    void vscode.window.showInformationMessage(l10n('ai.inline.disabled'));
    return;
  }
  await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
}

/** 模型输出卫生：剥围栏/引号，拒绝多行与哨兵（只接受单段短续写）。 */
function sanitizeCompletion(content: string): string | undefined {
  let text = content.trim();
  if (!text || text === INLINE_NONE || text.toLowerCase() === INLINE_NONE) return undefined;
  if (text.startsWith('```')) return undefined;
  // 偶尔出现的成对引号包裹
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1);
  }
  if (!text.trim()) return undefined;
  // 多行输出只取第一段非空行（补全应是一小段）
  const firstLine = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  if (!firstLine) return undefined;
  return text.includes('\n') ? firstLine : text;
}

/** 替换范围：光标 → 当前词末（不覆盖光标后面的文字）；无词时为零宽插入。 */
function completionRange(document: vscode.TextDocument, position: vscode.Position): vscode.Range {
  try {
    const word = document.getWordRangeAtPosition(position, /[A-Za-z0-9_]+/);
    if (word && word.end.isAfter(position)) return new vscode.Range(position, word.end);
  } catch {
    /* 某些文档实现不支持 word range：退化为零宽插入 */
  }
  return new vscode.Range(position, position);
}

/** token 感知的 debounce：等待期内取消立即 resolve（后续 isCancellationRequested 短路）。 */
function debounce(ms: number, token: vscode.CancellationToken): Promise<void> {
  return new Promise((resolve) => {
    if (token.isCancellationRequested) {
      resolve();
      return;
    }
    let sub: vscode.Disposable | undefined;
    const timer = setTimeout(() => {
      sub?.dispose();
      resolve();
    }, ms);
    sub = token.onCancellationRequested(() => {
      clearTimeout(timer);
      sub?.dispose();
      resolve();
    });
  });
}